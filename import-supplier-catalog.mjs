import 'dotenv/config';
import ExcelJS from 'exceljs';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';

/**
 * Bulk-imports supplier price-list spreadsheets: fills in missing photos on
 * existing products (without ever overwriting a photo that's already set -
 * a second distinct photo for an already-imaged product becomes a gallery
 * image instead, which is what turns into the product-page slideshow), and
 * inserts genuinely new products with a best-guess category.
 *
 * Builds on bulk-image-match.mjs's proven header/name/image-extraction
 * logic (detectNameColumn, isGoodNameText, cellText, findExactMatch,
 * findFuzzyMatch) but drives the walk off PRODUCT ROWS rather than off
 * embedded images, so products with no photo at all are still caught and
 * can be inserted / reported on.
 *
 * Unlike bulk-image-match.mjs, this script is DRY-RUN BY DEFAULT - pass
 * --commit to actually write the database and the image files. Always
 * read the .xlsx report from a dry run before committing.
 *
 * Usage:
 *   node import-supplier-catalog.mjs "file1.xlsx" "file2.xlsx" ...      (dry run -> report.xlsx)
 *   node import-supplier-catalog.mjs --commit "file1.xlsx" ...          (writes DB + files)
 *   node import-supplier-catalog.mjs --commit --out=my-report.xlsx ...
 */

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PRODUCTS_DIR = resolve(process.cwd(), '../public/products');
if (!existsSync(PRODUCTS_DIR)) mkdirSync(PRODUCTS_DIR, { recursive: true });

const COMMIT = process.argv.includes('--commit');
const outArg = process.argv.find((a) => a.startsWith('--out='));
const REPORT_PATH = outArg ? outArg.slice('--out='.length) : 'import-report.xlsx';
const fuzzyFillArg = process.argv.find((a) => a.startsWith('--fill-fuzzy='));
const FUZZY_FILL_THRESHOLD = fuzzyFillArg ? Number(fuzzyFillArg.slice('--fill-fuzzy='.length)) : null;
// Only fill genuine gaps - skip gallery-adds and new-product creation
// entirely. For re-running against files already committed once, this
// avoids re-discovering already-attached photos as "new" gallery entries
// (gallery dedup is in-memory only, per run - safe the first time, not
// safe to re-run blind against files already committed).
const FILL_ONLY = process.argv.includes('--fill-only');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const FUZZY_THRESHOLD = 0.35;

// ---------------------------------------------------------------- helpers
// (cellText / isGoodNameText / normalizeName / findExactMatch / findFuzzyMatch
// mirror bulk-image-match.mjs exactly - same tuning, same data.)

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

const MONTHS = 'jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?';
const JUNK_ROW_PATTERNS = [
  new RegExp(`^(updated|revised|as of|dated)?[:\\s]*\\d{1,2}(st|nd|rd|th)?[,.]?\\s*(${MONTHS})[,.]?\\s*\\d{4}$`, 'i'), // "19th, April, 2025" / "Updated 13th, August, 2024"
  /^(by|done by|signed by)\b/i, // signature lines
  /\bby\s+(phn|dr|mr|mrs|ms)\b/i, // "...: BY PHN ASSOUMPTA" (date+signature combined in one cell)
  /^(total|sub-?total|grand total|amount|balance)s?$/i,
  /^(phn|dr|mr|mrs|ms)\.?\s+[a-z'\-]+(\s+[a-z'\-]+){1,3}$/i, // "PHN ASSOUMPTA AIMEE" - a bare person name, no product-ish words
];

function isGoodNameText(t) {
  const s = t.trim();
  if (s.length < 3 || s.length > 120) return false; // >120 chars is a description paragraph, not a title
  if (!/[a-zA-Z]/.test(s)) return false;
  if (/^(no|nr|n°|#|photo|picture|image|action|actions)$/i.test(s)) return false;
  if (/^https?:\/\/|www\./i.test(s)) return false;
  if (JUNK_ROW_PATTERNS.some((re) => re.test(s))) return false;
  return true;
}

function normalizeName(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeBarcode(s) {
  return (s || '').replace(/[^0-9]/g, '').trim();
}

async function findExactMatch(normalized) {
  const { rows } = await pool.query(
    `SELECT id, name, slug, image, barcode FROM products WHERE trim(regexp_replace(lower(name), '[^a-z0-9]+', ' ', 'g')) = $1 LIMIT 1`,
    [normalized]
  );
  return rows[0] ?? null;
}

async function findByBarcode(barcode) {
  if (!barcode || barcode.length < 6) return null; // too short to be a real EAN/UPC
  const { rows } = await pool.query(
    `SELECT id, name, slug, image, barcode FROM products
     WHERE regexp_replace(barcode, '[^0-9]', '', 'g') = $1 LIMIT 1`,
    [barcode]
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

function slugify(input) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function extFor(extension) {
  const e = (extension || 'png').toLowerCase();
  return e === 'jpeg' ? 'jpg' : e;
}

function hashBuffer(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

// ------------------------------------------------------- header detection
// Scans the first 20 rows for a real header row (>=2 populated cells) and
// finds the name/barcode/qty column by substring match on header labels.
// Tiered so a specific label like "Product Name" always outranks a loose
// substring hit like "Line Description" (a category/section column on some
// supplier sheets, not the product name - it just happens to contain the
// word "description").
const NAME_EXACT_TOKENS = ['name', 'product name', 'item name', 'article name', 'nom du produit', 'designation', 'désignation'];
const NAME_LOOSE_TOKENS = ['produit', 'product', 'item', 'article', 'description'];
const BARCODE_TOKENS = ['ean', 'reference', 'référence', 'barcode', 'bar code', 'code'];
const QTY_TOKENS = ['qty', 'quantity', 'qte', 'quantite'];
const PHOTO_TOKENS = ['photo', 'picture', 'image', 'img'];
const SKIP_LEFT_SEARCH_TOKENS = ['web', 'link', 'url', 'website'];

function scoreNameHeader(text) {
  if (NAME_EXACT_TOKENS.includes(text)) return 3;
  if (/\bname\b/.test(text)) return 2;
  if (NAME_LOOSE_TOKENS.some((t) => text.includes(t))) return 1;
  return 0;
}

function detectHeaderInfo(sheet) {
  for (let r = 1; r <= Math.min(20, sheet.rowCount); r++) {
    const row = sheet.getRow(r);
    let nameCol = null, nameScore = 0, barcodeCol = null, qtyCol = null, photoCol = null;
    let populatedCells = 0;
    const rowTexts = new Map();
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const text = cellText(cell.value).trim().toLowerCase();
      if (!text) return;
      populatedCells++;
      rowTexts.set(col, text);
      const s = scoreNameHeader(text);
      if (s > nameScore) { nameScore = s; nameCol = col; }
      if (barcodeCol === null && BARCODE_TOKENS.some((t) => text.includes(t))) barcodeCol = col;
      if (qtyCol === null && QTY_TOKENS.some((t) => text.includes(t))) qtyCol = col;
      if (photoCol === null && PHOTO_TOKENS.some((t) => text.includes(t))) photoCol = col;
    });
    if (populatedCells < 2) continue; // a single populated cell is a letterhead line, not a header

    if (nameCol !== null) return { headerRow: r, nameCol, barcodeCol, qtyCol };
    if (photoCol !== null) {
      for (let c = photoCol - 1; c >= 1; c--) {
        const v = rowTexts.get(c);
        if (v && !SKIP_LEFT_SEARCH_TOKENS.some((t) => v.includes(t))) {
          return { headerRow: r, nameCol: c, barcodeCol, qtyCol };
        }
      }
    }
  }
  return null;
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

function nameFromColumn(sheet, rowNum, nameCol) {
  if (rowNum < 1 || rowNum > sheet.rowCount) return null;
  const text = cellText(sheet.getRow(rowNum).getCell(nameCol).value).trim();
  return isGoodNameText(text) ? text : null;
}

// ------------------------------------------------------- category guesses
// Ordered, first match wins. Anything unmatched falls into
// OTHERS > NEEDS CATEGORY REVIEW so it's still shoppable but flagged.
let CATEGORY_RULES = null; // built from the live DB in main()

const CATEGORY_KEYWORDS = [
  ['toothbrush-floss', /toothbrush|dental floss|flosser/i],
  ['mouthwash', /mouthwash|bain de bouche/i],
  ['mouthspray', /mouth ?spray|breath spray/i],
  ['oral-care-accessories', /toothpaste|dentifrice|oral.?care|whitening (gel|pen|strip)|denture|brosse a dents?|blanchiment dentaire|teeth whitening/i],
  ['baby-milk-powder', /\binfant (milk|formula)\b|\bfollow.?on milk\b|\bapt[ao]mil\b|\bnan\b.*(milk|formula|optipro)|nutrilon|lait (premiere|infantile)/i],
  ['baby-food-cereals', /baby (food|cereal|porridge|puree)|cereal.*(baby|infant)/i],
  ['baby-bottles-other-dinning-utensils', /baby bottle|feeding bottle|biberon|sippy cup|pacifier|sucette|teether/i],
  ['baby-diapering-accessories-products', /\bdiaper|nappy|couche\b/i],
  ['baby-cosmetics-baby-skincare-products', /\bbaby (lotion|shampoo|oil|powder|wash|cream)\b/i],
  ['pregnant-breastfiding-mother', /pregnan|breastfeed|breast pump|maternity|nursing pad|ovulation test/i],
  ['feminine-intimate-care-toiletries', /intimate (wash|wipe|care)|sanitary (pad|napkin)|tampon|menstrual|panty ?liner/i],
  ['father-care-grooming', /shaving|razor|beard|aftershave/i],
  ['diets-natural-remedy-food-supplements', /supplement|vitamin|collagen|omega.?3|multivitamin|herbal|capsule|\d+\s*(caps|tabs)\b/i],
  ['face-care', /face (cream|serum|mask|wash|cleanser)|facial|anti.?aging|moisturi[sz]er/i],
  ['foot-hand-care', /foot (cream|file|balm|care)|hand cream|nail (care|fungal)/i],
  ['personal-care-hygienics', /deodorant|antiperspirant|body (wash|lotion|gel)|shower gel|\bsoap\b|hygien|\bwipes?\b|lingettes?|cotton (pad|disc|bud)|\bcoton\b/i],
  ['medical-scrubs-uniform-short-sleeve', /scrubs? uniform|scrub top|scrub set/i],
  ['medical-doctor-s-nurses-shoes-clog-block', /\b(clog|nurse shoe|doctor shoe|medical shoe)\b/i],
  ['diabetic-shoes', /diabetic shoe/i],
  ['medical-massage-shoes', /massage shoe/i],
  ['other-medical-devices-parapharmaceuticals', /thermometer|stethoscope|blood pressure|glucose meter|syringe|\bbandage\b|surgical mask|\bn95\b|\bgloves?\b|plaster|pansement|first aid|\bsupport\b|\bbrace\b|\binsole\b|semelle|kinesiology tape/i],
  ['household-home-needs-products', /household|kitchen ?ware|cleaning|detergent/i],
  ['chemicals-essential-oils', /essential oil|aromatherapy/i],
  ['sexual-health-accessories-products', /condom|lubricant|sexual/i],
  ['medicated-flagrance-parfums-roll-ons', /perfume|parfum|eau de (toilette|parfum)|roll.?on/i],
  ['haircare-products-accessories', /hair (shampoo|conditioner|treatment|serum|loss|growth)|trioxidil|minoxidil|\bshampoo\b|\bconditioner\b/i],
  ['over-the-counter-medicines-and-topical', /\bparacetamol|ibuprofen|aspirin\b|\bsyrup\b|\bointment\b|antiseptic/i],
];

function guessSubcategory(name) {
  for (const [slug, re] of CATEGORY_KEYWORDS) {
    if (re.test(name)) {
      const hit = CATEGORY_RULES.bySlug.get(slug);
      if (hit) return hit;
    }
  }
  return CATEGORY_RULES.fallback;
}

// -------------------------------------------------------------- run state
const report = []; // one row per decision, written to REPORT_PATH at the end
const pendingNew = new Map(); // key -> { name, barcode, qty, images: [{buffer, ext, hash}], sources: [] }
const galleryHashesByProduct = new Map(); // productId -> Set(hash) - avoid re-adding the same photo twice

function reportRow(action, extra) {
  report.push({ action, ...extra });
}

async function handleRow(ctx) {
  const { fileLabel, sheetName, row, name, barcodeRaw, qty, media } = ctx;
  const normalized = normalizeName(name);
  const barcode = normalizeBarcode(barcodeRaw);

  let match = barcode ? await findByBarcode(barcode) : null;
  if (!match) match = await findExactMatch(normalized);

  if (match) {
    if (!media) {
      reportRow('matched-no-photo-on-row', { file: fileLabel, sheet: sheetName, row, name, productId: match.id, productName: match.name });
      return;
    }
    const hash = hashBuffer(media.buffer);
    if (!match.image) {
      // Fill the gap - this becomes the cover photo.
      reportRow('fill-missing-image', { file: fileLabel, sheet: sheetName, row, name, productId: match.id, productName: match.name, hash });
      if (COMMIT) {
        const ext = extFor(media.extension);
        const filename = `${match.slug}.${ext}`;
        writeFileSync(join(PRODUCTS_DIR, filename), Buffer.from(media.buffer));
        await pool.query(`UPDATE products SET image=$1, updated_at=now() WHERE id=$2`, [`/products/${filename}`, match.id]);
        match.image = `/products/${filename}`; // so a second row for the same product this run sees it as filled
      }
    } else if (FILL_ONLY) {
      reportRow('skip-already-has-image', { file: fileLabel, sheet: sheetName, row, name, productId: match.id, productName: match.name });
    } else {
      // Already has a cover - never overwrite it. A genuinely new photo
      // becomes a gallery entry instead (this is what makes the slider show up).
      let seen = galleryHashesByProduct.get(match.id);
      if (!seen) { seen = new Set(); galleryHashesByProduct.set(match.id, seen); }
      if (seen.has(hash)) {
        reportRow('skip-duplicate-image', { file: fileLabel, sheet: sheetName, row, name, productId: match.id, productName: match.name });
        return;
      }
      seen.add(hash);
      reportRow('add-gallery-image', { file: fileLabel, sheet: sheetName, row, name, productId: match.id, productName: match.name, hash });
      if (COMMIT) {
        const ext = extFor(media.extension);
        const filename = `${match.slug}-${seen.size}.${ext}`;
        writeFileSync(join(PRODUCTS_DIR, filename), Buffer.from(media.buffer));
        const { rows: sortRows } = await pool.query(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM product_images WHERE product_id=$1`, [match.id]);
        await pool.query(`INSERT INTO product_images (product_id, image, sort_order) VALUES ($1, $2, $3)`, [match.id, `/products/${filename}`, sortRows[0].next]);
      }
    }
    return;
  }

  const fuzzy = await findFuzzyMatch(name);
  if (fuzzy) {
    const score = Number(fuzzy.score);
    // Only ever fill a gap this way, never overwrite or add a gallery photo -
    // a fuzzy name match is much likelier to be a different-but-similar
    // product (different size/variant) than an exact match is, so the safe
    // failure mode is "still no photo", not "wrong photo attached".
    if (FUZZY_FILL_THRESHOLD != null && score >= FUZZY_FILL_THRESHOLD && !fuzzy.image && media) {
      reportRow('fill-missing-image-fuzzy', { file: fileLabel, sheet: sheetName, row, name, productId: fuzzy.id, productName: fuzzy.name, score: score.toFixed(2) });
      if (COMMIT) {
        const ext = extFor(media.extension);
        const filename = `${fuzzy.slug}.${ext}`;
        writeFileSync(join(PRODUCTS_DIR, filename), Buffer.from(media.buffer));
        await pool.query(`UPDATE products SET image=$1, updated_at=now() WHERE id=$2`, [`/products/${filename}`, fuzzy.id]);
      }
      return;
    }
    reportRow('needs-review', { file: fileLabel, sheet: sheetName, row, name, candidateId: fuzzy.id, candidateName: fuzzy.name, score: score.toFixed(2) });
    return;
  }

  if (FILL_ONLY) return; // don't create new products in this mode

  // Genuinely new product. Merge across duplicate sightings (same file
  // appears in multiple folders, or the same item is listed twice) - keyed
  // on name only, since the same product sometimes carries a different or
  // missing barcode between supplier listings and a barcode-first key would
  // otherwise split one product into two pending inserts.
  const key = normalized;
  let pending = pendingNew.get(key);
  if (!pending) {
    pending = { name, barcode: barcode || null, qty: qty ?? null, images: [], sources: [] };
    pendingNew.set(key, pending);
  }
  pending.sources.push(`${fileLabel}:${row}`);
  if (qty && !pending.qty) pending.qty = qty;
  if (media) {
    const hash = hashBuffer(media.buffer);
    if (!pending.images.some((i) => i.hash === hash)) {
      pending.images.push({ buffer: media.buffer, ext: extFor(media.extension), hash });
    }
  }
}

async function processFile(filePath) {
  const buf = readFileSync(filePath);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const fileLabel = filePath.split(/[\\/]/).pop();

  for (const sheet of wb.worksheets) {
    if (sheet.rowCount === 0 || sheet.columnCount === 0) continue;
    const headerInfo = detectHeaderInfo(sheet);
    if (!headerInfo) continue;

    const imagesByRow = new Map();
    for (const img of sheet.getImages()) {
      const r = img.range.tl.nativeRow + 1;
      const media = wb.model.media[img.imageId];
      if (media?.buffer && !imagesByRow.has(r)) imagesByRow.set(r, media);
    }

    let consecutiveBlank = 0;
    for (let r = headerInfo.headerRow + 1; r <= sheet.rowCount; r++) {
      let name = nameFromColumn(sheet, r, headerInfo.nameCol);
      if (!name) name = bestNameForRow(sheet, r, headerInfo.nameCol);
      if (!name) {
        // Two blank rows in a row means the product table is over - anything
        // after (signature, date, "done by ...") is not a product.
        if (++consecutiveBlank >= 2) break;
        continue;
      }
      consecutiveBlank = 0;

      const barcodeRaw = headerInfo.barcodeCol ? cellText(sheet.getRow(r).getCell(headerInfo.barcodeCol).value) : '';
      const qtyRaw = headerInfo.qtyCol ? cellText(sheet.getRow(r).getCell(headerInfo.qtyCol).value).trim() : '';
      const qty = /^\d+$/.test(qtyRaw) ? parseInt(qtyRaw, 10) : null;
      const media = imagesByRow.get(r) ?? imagesByRow.get(r + 1) ?? imagesByRow.get(r - 1);

      await handleRow({ fileLabel, sheetName: sheet.name, row: r, name, barcodeRaw, qty, media });
    }
  }
}

async function loadCategoryRules() {
  const { rows } = await pool.query(
    `SELECT s.id, s.slug FROM subcategories s`
  );
  const bySlug = new Map(rows.map((r) => [r.slug, r.id]));

  const { rows: othersCat } = await pool.query(`SELECT id FROM categories WHERE slug = 'others' LIMIT 1`);
  if (!othersCat[0]) throw new Error('Expected an "others" category to exist.');
  const { rows: fallbackSub } = await pool.query(
    `INSERT INTO subcategories (category_id, name, slug, sort_order)
     VALUES ($1, 'NEEDS CATEGORY REVIEW', 'needs-category-review', 999)
     ON CONFLICT (category_id, slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [othersCat[0].id]
  );
  return { bySlug, fallback: fallbackSub[0].id };
}

async function commitNewProducts() {
  for (const [, p] of pendingNew) {
    const subcategoryId = guessSubcategory(p.name);
    const subSlug = [...CATEGORY_RULES.bySlug.entries()].find(([, id]) => id === subcategoryId)?.[0] ?? 'needs-category-review';

    reportRow('new-product', {
      name: p.name,
      barcode: p.barcode,
      qty: p.qty,
      subcategory: subSlug,
      imageCount: p.images.length,
      sources: p.sources.join('; '),
    });

    if (!COMMIT) continue;

    let slug = slugify(p.name);
    const { rows: clash } = await pool.query(`SELECT 1 FROM products WHERE slug = $1`, [slug]);
    if (clash.length) {
      let n = 2;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { rows: c2 } = await pool.query(`SELECT 1 FROM products WHERE slug = $1`, [`${slug}-${n}`]);
        if (!c2.length) { slug = `${slug}-${n}`; break; }
        n++;
      }
    }

    const cover = p.images[0];
    const coverPath = cover ? `/products/${slug}.${cover.ext}` : null;
    if (cover) writeFileSync(join(PRODUCTS_DIR, `${slug}.${cover.ext}`), Buffer.from(cover.buffer));

    const { rows: inserted } = await pool.query(
      `INSERT INTO products (subcategory_id, name, slug, barcode, qty_in_stock, image)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [subcategoryId, p.name, slug, p.barcode, p.qty ?? 0, coverPath]
    );
    const productId = inserted[0].id;

    for (let i = 1; i < p.images.length; i++) {
      const img = p.images[i];
      const filename = `${slug}-${i + 1}.${img.ext}`;
      writeFileSync(join(PRODUCTS_DIR, filename), Buffer.from(img.buffer));
      await pool.query(`INSERT INTO product_images (product_id, image, sort_order) VALUES ($1, $2, $3)`, [productId, `/products/${filename}`, i]);
    }
  }
}

async function writeReport() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Import report');
  const cols = new Set();
  for (const r of report) for (const k of Object.keys(r)) cols.add(k);
  const columns = ['action', ...[...cols].filter((c) => c !== 'action')];
  sheet.columns = columns.map((c) => ({ header: c, key: c, width: c === 'name' || c === 'sources' ? 45 : 18 }));
  for (const r of report) sheet.addRow(r);
  sheet.getRow(1).font = { bold: true };
  await wb.xlsx.writeFile(REPORT_PATH);
}

async function main() {
  if (files.length === 0) {
    console.error('Usage: node import-supplier-catalog.mjs [--commit] [--out=report.xlsx] file1.xlsx file2.xlsx ...');
    process.exit(1);
  }

  CATEGORY_RULES = await loadCategoryRules();

  for (const f of files) {
    process.stdout.write(`Processing: ${f.split(/[\\/]/).pop()} ... `);
    const start = Date.now();
    try {
      await processFile(f);
      console.log(`done (${Date.now() - start}ms)`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }

  await commitNewProducts();

  const counts = report.reduce((acc, r) => { acc[r.action] = (acc[r.action] ?? 0) + 1; return acc; }, {});
  console.log('\n=== SUMMARY ===');
  console.log('Mode:', COMMIT ? 'COMMIT (wrote DB + files)' : 'DRY RUN (no writes)');
  for (const [action, n] of Object.entries(counts)) console.log(`  ${action}: ${n}`);

  await writeReport();
  console.log(`\nFull report written to ${REPORT_PATH}`);

  await pool.end();
}

main();
