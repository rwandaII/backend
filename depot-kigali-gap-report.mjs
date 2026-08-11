import 'dotenv/config';
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import pg from 'pg';

/**
 * Compares Health Target's master "Depot Kigali" list against the current
 * catalog and reports every row that's still missing - the final gap
 * report after the supplier-file import. Read-only: never writes anything.
 *
 * Usage: node depot-kigali-gap-report.mjs "DEPOT KIGALI DEFINTIVE LIST MAY 2026.xlsx" [--out=report.xlsx]
 */

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const outArg = process.argv.find((a) => a.startsWith('--out='));
const REPORT_PATH = outArg ? outArg.slice('--out='.length) : 'depot-kigali-gap-report.xlsx';
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
const FUZZY_THRESHOLD = 0.35;

if (!file) {
  console.error('Usage: node depot-kigali-gap-report.mjs "DEPOT KIGALI....xlsx" [--out=report.xlsx]');
  process.exit(1);
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

function normalizeName(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeBarcode(s) {
  return (s || '').replace(/[^0-9]/g, '').trim();
}

async function findByBarcode(barcode) {
  if (!barcode || barcode.length < 6) return null;
  const { rows } = await pool.query(
    `SELECT id, name FROM products WHERE regexp_replace(barcode, '[^0-9]', '', 'g') = $1 LIMIT 1`,
    [barcode]
  );
  return rows[0] ?? null;
}

async function findExactMatch(normalized) {
  const { rows } = await pool.query(
    `SELECT id, name FROM products WHERE trim(regexp_replace(lower(name), '[^a-z0-9]+', ' ', 'g')) = $1 LIMIT 1`,
    [normalized]
  );
  return rows[0] ?? null;
}

async function findFuzzyMatch(rawName) {
  const { rows } = await pool.query(
    `SELECT id, name, similarity(lower(name), lower($1)) AS score
     FROM products WHERE similarity(lower(name), lower($1)) > $2
     ORDER BY score DESC LIMIT 1`,
    [rawName, FUZZY_THRESHOLD]
  );
  return rows[0] ?? null;
}

async function main() {
  const buf = readFileSync(file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheet = wb.worksheets[0];

  // Header row: scan the first 10 rows for one containing "NAME" (this file's
  // header is "NO | ID COMPANY NO | BAR CODE | NAME & SPECIFICATION | ...").
  let headerRow = null, nameCol = null, barcodeCol = null;
  for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
    const row = sheet.getRow(r);
    let localName = null, localBarcode = null, populated = 0;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const t = cellText(cell.value).trim().toLowerCase();
      if (!t) return;
      populated++;
      if (localName === null && t.includes('name')) localName = col;
      if (localBarcode === null && (t.includes('bar code') || t.includes('barcode') || t === 'ean')) localBarcode = col;
    });
    if (populated >= 3 && localName !== null) {
      headerRow = r; nameCol = localName; barcodeCol = localBarcode;
      break;
    }
  }
  if (!headerRow) throw new Error('Could not find a header row with a NAME column.');
  console.log(`Header found at row ${headerRow}: name col ${nameCol}, barcode col ${barcodeCol}`);

  const results = { matched: 0, missing: [], skippedSectionRows: 0 };

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const name = cellText(row.getCell(nameCol).value).trim();
    if (!name || name.length < 3) continue;

    // Department-separator rows repeat the same short word across most
    // columns (e.g. "DUBAI" in every cell) - not a real product row.
    let sameTextCount = 0, totalPopulated = 0;
    row.eachCell({ includeEmpty: false }, (cell) => {
      const t = cellText(cell.value).trim();
      if (!t) return;
      totalPopulated++;
      if (t.toLowerCase() === name.toLowerCase()) sameTextCount++;
    });
    if (totalPopulated >= 3 && sameTextCount >= 3) {
      results.skippedSectionRows++;
      continue;
    }

    const barcodeRaw = barcodeCol ? cellText(row.getCell(barcodeCol).value) : '';
    const barcode = normalizeBarcode(barcodeRaw);
    const normalized = normalizeName(name);

    let match = barcode ? await findByBarcode(barcode) : null;
    if (!match) match = await findExactMatch(normalized);
    if (match) { results.matched++; continue; }

    const fuzzy = await findFuzzyMatch(name);
    if (fuzzy && Number(fuzzy.score) >= 0.5) { results.matched++; continue; } // close enough to count as present

    results.missing.push({ row: r, name, barcode: barcode || null, closestCandidate: fuzzy ? fuzzy.name : null, closestScore: fuzzy ? Number(fuzzy.score).toFixed(2) : null });
  }

  console.log(`\nMatched (already in catalog): ${results.matched}`);
  console.log(`Section/header rows skipped: ${results.skippedSectionRows}`);
  console.log(`Still missing from catalog: ${results.missing.length}`);

  const outWb = new ExcelJS.Workbook();
  const outSheet = outWb.addWorksheet('Missing from catalog');
  outSheet.columns = [
    { header: 'Row', key: 'row', width: 8 },
    { header: 'Name (Depot Kigali list)', key: 'name', width: 55 },
    { header: 'Barcode', key: 'barcode', width: 18 },
    { header: 'Closest catalog match (if any)', key: 'closestCandidate', width: 45 },
    { header: 'Similarity', key: 'closestScore', width: 12 },
  ];
  outSheet.addRows(results.missing);
  outSheet.getRow(1).font = { bold: true };
  await outWb.xlsx.writeFile(REPORT_PATH);
  console.log(`\nReport written to ${REPORT_PATH}`);

  await pool.end();
}

main();
