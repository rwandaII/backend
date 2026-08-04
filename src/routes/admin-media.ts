import { Router } from 'express';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, extname } from 'node:path';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { pool } from '../db.js';
import { reloadCatalog } from '../catalog.js';

export const adminMediaRouter = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));
// server/src/routes -> server/src -> server -> target-traders -> public/products
export const PRODUCTS_DIR = resolve(__dirname, '../../../public/products');
if (!existsSync(PRODUCTS_DIR)) mkdirSync(PRODUCTS_DIR, { recursive: true });

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_SIZE = 5 * 1024 * 1024;

export function sanitizeFilename(originalName: string): string {
  const ext = extname(originalName).toLowerCase();
  const base = originalName
    .slice(0, originalName.length - ext.length)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base || 'image'}${ext}`;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new Error('UNSUPPORTED_TYPE'));
      return;
    }
    cb(null, true);
  },
});

function fail(res: import('express').Response, status: number, error: string, code = 'INVALID_INPUT') {
  res.status(status).json({ ok: false, code, error });
}

function handleUploadError(err: unknown, res: import('express').Response): boolean {
  if (!err) return false;
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    fail(res, 413, 'Image is too large - 5MB max.', 'FILE_TOO_LARGE');
    return true;
  }
  if (err instanceof Error && err.message === 'UNSUPPORTED_TYPE') {
    fail(res, 400, 'Only JPG, PNG, or WEBP images are allowed.', 'UNSUPPORTED_TYPE');
    return true;
  }
  fail(res, 500, 'Upload failed.', 'SERVER_ERROR');
  return true;
}

/**
 * POST /api/admin/media/products/:id/image
 * Replaces a single product's photo. Saved under the product's own slug, so
 * re-uploading always overwrites the same file instead of piling up orphans.
 */
adminMediaRouter.post('/products/:id/image', (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (handleUploadError(err, res)) return;
    if (!req.file) return fail(res, 400, 'No image file was uploaded (field name: image).');

    const { rows } = await pool.query<{ slug: string; image: string | null }>(
      `SELECT slug, image FROM products WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return fail(res, 404, 'Product not found.', 'NOT_FOUND');

    const ext = extname(req.file.originalname).toLowerCase() || '.jpg';
    if (!ALLOWED_EXT.has(ext)) return fail(res, 400, 'Only JPG, PNG, or WEBP images are allowed.');

    const filename = `${rows[0].slug}${ext}`;
    writeFileSync(join(PRODUCTS_DIR, filename), req.file.buffer);

    // Clean up a previous file if this replacement changed the extension.
    const oldImage = rows[0].image;
    if (oldImage?.startsWith('/products/')) {
      const oldFilename = oldImage.replace('/products/', '');
      if (oldFilename !== filename) {
        const oldPath = join(PRODUCTS_DIR, oldFilename);
        if (existsSync(oldPath)) {
          try {
            unlinkSync(oldPath);
          } catch {
            // Not fatal - an orphaned file is a minor cleanup issue, not a correctness one.
          }
        }
      }
    }

    const image = `/products/${filename}`;
    await pool.query(`UPDATE products SET image = $1, updated_at = now() WHERE id = $2`, [image, req.params.id]);
    await reloadCatalog();

    res.json({ ok: true, image });
  });
});

/**
 * POST /api/admin/media/upload
 * Batch-uploads photos (e.g. a whole shipment folder) into public/products/
 * under their sanitized original filenames, without attaching them to any
 * product yet. Meant to be paired with the Excel import: upload the photos
 * here first, then POST /api/admin/import/analyze to match them by name.
 */
adminMediaRouter.post('/upload', (req, res) => {
  upload.array('images', 300)(req, res, (err) => {
    if (handleUploadError(err, res)) return;

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) return fail(res, 400, 'No image files were uploaded (field name: images).');

    const saved: string[] = [];
    const rejected: { originalName: string; reason: string }[] = [];

    for (const file of files) {
      const ext = extname(file.originalname).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        rejected.push({ originalName: file.originalname, reason: 'Unsupported file type.' });
        continue;
      }
      const filename = sanitizeFilename(file.originalname);
      writeFileSync(join(PRODUCTS_DIR, filename), file.buffer);
      saved.push(filename);
    }

    res.json({ ok: true, saved, rejected });
  });
});
