import { Router } from 'express';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { pool } from '../db.js';
import { reloadCatalog } from '../catalog.js';
import { analyzeImport } from '../catalog-import.js';
import { PRODUCTS_DIR } from './admin-media.js';

export const adminImportRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function fail(res: import('express').Response, status: number, error: string, code = 'INVALID_INPUT') {
  res.status(status).json({ ok: false, code, error });
}

/**
 * POST /api/admin/import/analyze
 * Upload a spreadsheet (a "Name" column, optionally an "Image" column) and
 * get back, for every row: the best-matching product in the catalog, which
 * photo file it would use, and why (exact match / needs a human look /
 * no match / matched but no photo found / already set). Nothing is written
 * to the database here - this is the preview a person reviews before
 * POST /commit applies anything.
 */
adminImportRouter.post('/analyze', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return fail(res, 400, 'Upload failed - is the file a valid .xlsx?', 'BAD_FILE');
    if (!req.file) return fail(res, 400, 'No spreadsheet was uploaded (field name: file).');

    try {
      const { rows, summary } = await analyzeImport(req.file.buffer);
      res.json({ ok: true, rows, summary });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : 'Could not read that spreadsheet.', 'PARSE_ERROR');
    }
  });
});

const commitSchema = z.object({
  changes: z
    .array(
      z.object({
        productId: z.coerce.number().int().positive(),
        image: z.string().trim().min(1).max(255),
      })
    )
    .min(1, 'Nothing to apply.'),
});

/**
 * POST /api/admin/import/commit
 * Body: { changes: [{ productId, image }] } - normally exactly the rows the
 * dashboard showed as "matched" from /analyze (plus anything the user
 * confirmed by hand for the "needs review" rows). Each image filename must
 * already exist in public/products/ (upload it first via
 * POST /api/admin/media/upload, or via /analyze against existing photos).
 */
adminImportRouter.post('/commit', async (req, res) => {
  const parsed = commitSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? 'Invalid request.');

  const applied: { productId: number; image: string }[] = [];
  const errors: { productId: number; error: string }[] = [];

  for (const change of parsed.data.changes) {
    if (!existsSync(join(PRODUCTS_DIR, change.image))) {
      errors.push({ productId: change.productId, error: `Image file "${change.image}" was not found in public/products/.` });
      continue;
    }

    const { rowCount } = await pool.query(`UPDATE products SET image = $1, updated_at = now() WHERE id = $2`, [
      `/products/${change.image}`,
      change.productId,
    ]);

    if (!rowCount) {
      errors.push({ productId: change.productId, error: 'Product not found.' });
      continue;
    }

    applied.push(change);
  }

  if (applied.length > 0) await reloadCatalog();

  res.json({ ok: true, applied: applied.length, errors });
});
