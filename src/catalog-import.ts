import ExcelJS from 'exceljs';
import { readdirSync } from 'node:fs';
import { pool } from './db.js';
import { PRODUCTS_DIR } from './routes/admin-media.js';

/**
 * The "friendly agent": reads a spreadsheet of product names (+ optionally an
 * image filename column), matches each row against the catalog by name, and
 * figures out which photo file it should get - without touching the database.
 * A human reviews the result and only the confirmed rows get committed.
 */

export interface ImportMatch {
  productId: number;
  productName: string;
  slug: string;
  currentImage: string | null;
  score: number; // 1 = exact match, <1 = fuzzy similarity
}

export type ImportRowStatus = 'matched' | 'needs_review' | 'no_match' | 'missing_image' | 'already_set';

export interface ImportRow {
  rowNumber: number;
  excelName: string;
  excelImage: string | null;
  match: ImportMatch | null;
  resolvedImage: string | null; // filename found on disk, if any
  status: ImportRowStatus;
}

const NAME_HEADERS = ['name', 'product name', 'product', 'item', 'item name'];
const IMAGE_HEADERS = ['image', 'image name', 'image file', 'photo', 'picture', 'filename', 'file name'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const FUZZY_THRESHOLD = 0.35;

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (typeof value === 'object') {
    if ('text' in value && typeof (value as { text?: unknown }).text === 'string') {
      return (value as { text: string }).text;
    }
    if ('richText' in value) {
      const parts = (value as { richText: { text: string }[] }).richText;
      return parts.map((p) => p.text).join('');
    }
    if ('hyperlink' in value) return String((value as { hyperlink: unknown }).hyperlink ?? '');
  }
  return String(value);
}

function findColumn(headerRow: ExcelJS.Row, candidates: string[]): number | null {
  let found: number | null = null;
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = cellText(cell.value).trim().toLowerCase();
    if (found === null && candidates.includes(text)) found = colNumber;
  });
  return found;
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** Parses the uploaded workbook into {name, image} pairs, sheet order preserved. */
export async function parseImportSheet(buffer: Buffer): Promise<{ rowNumber: number; name: string; image: string | null }[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('The workbook has no sheets.');

  const headerRow = sheet.getRow(1);
  const nameCol = findColumn(headerRow, NAME_HEADERS);
  const imageCol = findColumn(headerRow, IMAGE_HEADERS);

  if (!nameCol) {
    throw new Error(
      `Couldn't find a product name column. Expected a header like "Name" or "Product Name" in row 1.`
    );
  }

  const out: { rowNumber: number; name: string; image: string | null }[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const name = cellText(row.getCell(nameCol).value).trim();
    if (!name) return;
    const image = imageCol ? cellText(row.getCell(imageCol).value).trim() || null : null;
    out.push({ rowNumber, name, image: image ? basename(image) : null });
  });

  return out;
}

async function findExactMatch(normalized: string): Promise<ImportMatch | null> {
  const { rows } = await pool.query<{ id: number; name: string; slug: string; image: string | null }>(
    `SELECT id, name, slug, image FROM products
     WHERE trim(regexp_replace(lower(name), '[^a-z0-9]+', ' ', 'g')) = $1
     LIMIT 1`,
    [normalized]
  );
  const row = rows[0];
  return row ? { productId: row.id, productName: row.name, slug: row.slug, currentImage: row.image, score: 1 } : null;
}

async function findFuzzyMatch(rawName: string): Promise<ImportMatch | null> {
  const { rows } = await pool.query<{ id: number; name: string; slug: string; image: string | null; score: number }>(
    `SELECT id, name, slug, image, similarity(lower(name), lower($1)) AS score
     FROM products
     ORDER BY score DESC
     LIMIT 1`,
    [rawName]
  );
  const row = rows[0];
  if (!row || row.score < FUZZY_THRESHOLD) return null;
  return { productId: row.id, productName: row.name, slug: row.slug, currentImage: row.image, score: row.score };
}

/** Maps lowercased filename -> actual on-disk filename, so lookups can be case-insensitive. */
function listExistingImages(): Map<string, string> {
  try {
    const map = new Map<string, string>();
    for (const f of readdirSync(PRODUCTS_DIR)) map.set(f.toLowerCase(), f);
    return map;
  } catch {
    return new Map();
  }
}

/** Resolves which file on disk (if any) should become this row's image. */
function resolveImage(row: { image: string | null }, match: ImportMatch, existing: Map<string, string>): string | null {
  if (row.image) {
    return existing.get(row.image.toLowerCase()) ?? null;
  }
  // No explicit image column - fall back to the slug-based naming convention
  // used throughout the rest of the catalog (see productIdFromName).
  for (const ext of IMAGE_EXTENSIONS) {
    const found = existing.get(`${match.slug}${ext}`.toLowerCase());
    if (found) return found;
  }
  return null;
}

export async function analyzeImport(buffer: Buffer): Promise<{ rows: ImportRow[]; summary: Record<ImportRowStatus, number> }> {
  const parsed = await parseImportSheet(buffer);
  const existingImages = listExistingImages();

  const rows: ImportRow[] = [];
  for (const p of parsed) {
    const normalized = normalizeName(p.name);
    const match = (await findExactMatch(normalized)) ?? (await findFuzzyMatch(p.name));

    if (!match) {
      rows.push({ rowNumber: p.rowNumber, excelName: p.name, excelImage: p.image, match: null, resolvedImage: null, status: 'no_match' });
      continue;
    }

    const resolvedImage = resolveImage(p, match, existingImages);
    let status: ImportRowStatus;

    if (match.score < 1) {
      status = 'needs_review';
    } else if (!resolvedImage) {
      status = 'missing_image';
    } else if (match.currentImage === `/products/${resolvedImage}`) {
      status = 'already_set';
    } else {
      status = 'matched';
    }

    rows.push({ rowNumber: p.rowNumber, excelName: p.name, excelImage: p.image, match, resolvedImage, status });
  }

  const summary: Record<ImportRowStatus, number> = {
    matched: 0,
    needs_review: 0,
    no_match: 0,
    missing_image: 0,
    already_set: 0,
  };
  for (const r of rows) summary[r.status]++;

  return { rows, summary };
}
