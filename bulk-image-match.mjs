import 'dotenv/config';
import ExcelJS from 'exceljs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PRODUCTS_DIR = resolve(process.cwd(), '../public/products');
if (!existsSync(PRODUCTS_DIR)) mkdirSync(PRODUCTS_DIR, { recursive: true });

const DRY_RUN = process.argv.includes('--dry-run');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const FUZZY_THRESHOLD = 0.35;

function normalizeName(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function findExactMatch(normalized) {
  const { rows } = await pool.query(
    `SELECT id, name, slug, image FROM products WHERE trim(regexp_replace(lower(name), '[^a-z0-9]+', ' ', 'g')) = $1 LIMIT 1`,
    [normalized]
  );
  return rows[0] ?? null;
}

async function findFuzzyMatch(rawName) {
  const { rows } = await pool.query(
    `SELECT id, name, slug, image, similarity(lower(name), lower($1)) AS score
     FROM products WHERE similarity(lower(name), lower($1)) > $2
     ORDER BY score DESC LIMIT 1`,
    [rawName, FUZZY_THRESHOLD]
  );
  return rows[0] ?? null;
}

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((p) => p.text).join('');
    if ('text' in v) return String(v.text ?? '');
    if ('result' in v) return String(v.result ?? '');
    if ('hyperlink' in v) return String(v.hyperlink ?? '');
    return '';
  }
  return String(v);
}

function isGoodNameText(t) {
  const s = t.trim();
  if (s.length < 3) return false;
  if (!/[a-zA-Z]/.test(s)) return false;
  if (/^(no|nr|n°|#|photo|picture|image|action|actions)$/i.test(s)) return false;
  if (/^https?:\/\/|www\./i.test(s)) return false;
  return true;
}

function bestNameForRow(sheet, rowNum, excludeCol) {
  if (rowNum < 1 || rowNum > sheet.rowCount) return null;
  const row = sheet.getRow(rowNum);
  let best = null;
  row.eachCell({ includeEmpty: false }, (cell, col) => {
    if (col === excludeCol) return;
    const text = cellText(cell.value).trim();
    if (!isGoodNameText(text)) return;
    if (!best || text.length > best.length) best = text;
  });
  return best;
}

const NAME_TOKENS = ['name', 'produit', 'product', 'item', 'article', 'designation', 'désignation', 'description'];
const PHOTO_TOKENS = ['photo', 'picture', 'image', 'img'];
const SKIP_LEFT_SEARCH_TOKENS = ['web', 'link', 'url', 'website'];

/** Scans the top of a sheet for its header row, returning the column index for
 * the product-name field (so we read that exact column instead of guessing
 * "longest text in the row", which grabs the manufacturer-address column on
 * sheets where it's longer than the product name). */
function detectNameColumn(sheet) {
  for (let r = 1; r <= Math.min(20, sheet.rowCount); r++) {
    const row = sheet.getRow(r);
    let nameCol = null;
    let photoCol = null;
    let populatedCells = 0;
    const rowTexts = new Map();
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const text = cellText(cell.value).trim().toLowerCase();
      if (!text) return;
      populatedCells++;
      rowTexts.set(col, text);
      if (nameCol === null && NAME_TOKENS.some((t) => text.includes(t))) nameCol = col;
      if (photoCol === null && PHOTO_TOKENS.some((t) => text.includes(t))) photoCol = col;
    });
    // A real header row lists several column labels. A single populated cell
    // is almost always a letterhead/address line (e.g. "Bank name: ACCESS
    // BANK..." falsely contains the substring "name") - skip those.
    if (populatedCells < 2) continue;

    if (nameCol !== null) return { headerRow: r, nameCol };
    if (photoCol !== null) {
      // No explicit name header, but found a photo column - the name is
      // almost always the first text column to its left (skip link/URL columns).
      for (let c = photoCol - 1; c >= 1; c--) {
        const v = rowTexts.get(c);
        if (v && !SKIP_LEFT_SEARCH_TOKENS.some((t) => v.includes(t))) return { headerRow: r, nameCol: c };
      }
    }
  }
  return null;
}

function nameFromColumn(sheet, rowNum, nameCol) {
  if (rowNum < 1 || rowNum > sheet.rowCount) return null;
  const text = cellText(sheet.getRow(rowNum).getCell(nameCol).value).trim();
  return isGoodNameText(text) ? text : null;
}

function extFor(extension) {
  const e = (extension || 'png').toLowerCase();
  return e === 'jpeg' ? 'jpg' : e;
}

async function processFile(filePath, results) {
  const buf = readFileSync(filePath);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const fileLabel = filePath.split(/[\\/]/).pop();

  for (const sheet of wb.worksheets) {
    const images = sheet.getImages();
    if (!images.length) continue;

    const headerInfo = detectNameColumn(sheet);
    const seenRows = new Set();

    for (const img of images) {
      const anchorRow0 = img.range.tl.nativeRow;
      const anchorCol0 = img.range.tl.nativeCol;
      const rowNum = anchorRow0 + 1;
      const excludeCol = anchorCol0 + 1;

      let name = null;
      if (headerInfo) {
        name = nameFromColumn(sheet, rowNum, headerInfo.nameCol)
          ?? nameFromColumn(sheet, rowNum + 1, headerInfo.nameCol)
          ?? nameFromColumn(sheet, rowNum - 1, headerInfo.nameCol);
      }
      if (!name) name = bestNameForRow(sheet, rowNum, excludeCol);
      if (!name) name = bestNameForRow(sheet, rowNum + 1, excludeCol);
      if (!name) name = bestNameForRow(sheet, rowNum - 1, excludeCol);

      if (!name) {
        results.noName.push({ file: fileLabel, sheet: sheet.name, row: rowNum });
        continue;
      }

      const dedupeKey = `${sheet.name}:${rowNum}`;
      if (seenRows.has(dedupeKey)) continue;
      seenRows.add(dedupeKey);

      const media = wb.model.media[img.imageId];
      if (!media || !media.buffer) {
        results.noMatch.push({ file: fileLabel, row: rowNum, name, reason: 'no image buffer' });
        continue;
      }

      const normalized = normalizeName(name);
      const exact = await findExactMatch(normalized);

      if (exact) {
        const ext = extFor(media.extension);
        const filename = `${exact.slug}.${ext}`;
        if (!DRY_RUN) {
          writeFileSync(join(PRODUCTS_DIR, filename), Buffer.from(media.buffer));
          await pool.query(`UPDATE products SET image=$1, updated_at=now() WHERE id=$2`, [`/products/${filename}`, exact.id]);
        }
        results.applied.push({ file: fileLabel, row: rowNum, excelName: name, productId: exact.id, productName: exact.name, filename });
        continue;
      }

      const fuzzy = await findFuzzyMatch(name);
      if (fuzzy) {
        results.needsReview.push({
          file: fileLabel,
          row: rowNum,
          excelName: name,
          candidateId: fuzzy.id,
          candidateName: fuzzy.name,
          score: Number(fuzzy.score).toFixed(2),
        });
      } else {
        results.noMatch.push({ file: fileLabel, row: rowNum, name });
      }
    }
  }
}

async function main() {
  const results = { applied: [], needsReview: [], noMatch: [], noName: [] };
  for (const f of files) {
    process.stdout.write(`Processing: ${f.split(/[\\/]/).pop()} ... `);
    const start = Date.now();
    try {
      await processFile(f, results);
      console.log(`done (${Date.now() - start}ms)`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('Mode:', DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (wrote files + DB)');
  console.log('Applied (exact match):', results.applied.length);
  console.log('Needs review (fuzzy match, not applied):', results.needsReview.length);
  console.log('No DB match found:', results.noMatch.length);
  console.log('No product name found near image:', results.noName.length);

  writeFileSync('bulk-image-results.json', JSON.stringify(results, null, 2));
  console.log('\nFull results written to bulk-image-results.json');

  await pool.end();
}

main();
