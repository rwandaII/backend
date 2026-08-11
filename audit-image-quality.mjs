import 'dotenv/config';
import pg from 'pg';
import { readFileSync } from 'node:fs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const csvPath = "C:/Users/USER/AppData/Local/Temp/claude/C--Users-USER-OneDrive-Desktop-target-traders/f9ac0e2a-b2e8-43b6-9a5a-ac6ad7352a6d/scratchpad/image-dims.csv";
const lines = readFileSync(csvPath, 'utf8').split('\n').slice(1).filter(Boolean);
const dims = new Map();
for (const line of lines) {
  // CSV: "File","Width","Height","Bytes"
  const m = line.match(/^"([^"]*)","(-?\d+)","(-?\d+)","(\d+)"/);
  if (!m) continue;
  dims.set(m[1], { w: +m[2], h: +m[3], bytes: +m[4] });
}

const { rows } = await pool.query(`SELECT id, name, image FROM products WHERE image IS NOT NULL`);
let smallCount = 0;
const smallList = [];
for (const p of rows) {
  const fname = p.image.replace('/products/', '');
  const d = dims.get(fname);
  if (!d) continue; // file missing entirely - separate problem
  if (d.w > 0 && (d.w < 400 || d.h < 400)) {
    smallCount++;
    smallList.push({ id: p.id, name: p.name, image: p.image, w: d.w, h: d.h });
  }
}
console.log('Total products with an image:', rows.length);
console.log('Products whose CURRENT image is under 400px on a side:', smallCount);
console.log(JSON.stringify(smallList.slice(0, 20), null, 2));

// Export full list to CSV for future batching
import { writeFileSync } from 'node:fs';
const header = 'id,name,image,width,height\n';
const csvOut = header + smallList.map(r => `${r.id},\"${r.name.replace(/\"/g,'')}\",${r.image},${r.w},${r.h}`).join('\n');
writeFileSync('products-low-res-images.csv', csvOut);
console.log('Wrote products-low-res-images.csv');
await pool.end();
