import 'dotenv/config';
import pg from 'pg';

// Cleans up a specific defect from today's import batch: the same product
// appearing under two different barcodes in different supplier files, which
// meant the within-run new-product dedup (keyed by barcode||name) missed the
// collision and inserted it twice. Merges duplicates by exact normalized
// name (scoped to this batch's time window), keeps the lowest id, moves any
// distinct extra photo into product_images (gallery), deletes the rest.

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const DRY_RUN = !process.argv.includes('--commit');

async function main() {
  const { rows: groups } = await pool.query(`
    SELECT trim(regexp_replace(lower(name), '[^a-z0-9]+', ' ', 'g')) AS norm, array_agg(id ORDER BY id) AS ids
    FROM products
    WHERE created_at > now() - interval '3 hours'
    GROUP BY norm HAVING COUNT(*) > 1
  `);

  console.log(`Found ${groups.length} duplicate-name groups from this batch.`);
  let merged = 0, galleryAdded = 0;

  for (const g of groups) {
    const [keepId, ...dupeIds] = g.ids;
    const { rows: all } = await pool.query(`SELECT id, name, image FROM products WHERE id = ANY($1)`, [g.ids]);
    const keep = all.find((p) => p.id === keepId);
    const keptImages = new Set([keep.image].filter(Boolean));

    for (const dupeId of dupeIds) {
      const dupe = all.find((p) => p.id === dupeId);
      console.log(`  merge #${dupeId} "${dupe.name}" -> #${keepId}`);
      if (dupe.image && !keptImages.has(dupe.image)) {
        keptImages.add(dupe.image);
        galleryAdded++;
        if (!DRY_RUN) {
          const { rows: sortRows } = await pool.query(
            `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM product_images WHERE product_id=$1`, [keepId]
          );
          await pool.query(
            `INSERT INTO product_images (product_id, image, sort_order) VALUES ($1, $2, $3)`,
            [keepId, dupe.image, sortRows[0].next]
          );
        }
      }
      if (!DRY_RUN) {
        // Move over any gallery rows the duplicate already had, then delete it.
        await pool.query(`UPDATE product_images SET product_id = $1 WHERE product_id = $2`, [keepId, dupeId]);
        await pool.query(`DELETE FROM products WHERE id = $1`, [dupeId]);
      }
      merged++;
    }
  }

  console.log(`\n${DRY_RUN ? 'Would merge' : 'Merged'} ${merged} duplicate rows into their originals (${galleryAdded} became gallery photos).`);
  await pool.end();
}

main();
