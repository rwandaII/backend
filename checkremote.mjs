import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.REMOTE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
for (const t of ['categories','subcategories','products','product_images','admins']) {
  const r = await c.query(`select count(*) from ${t}`);
  console.log(t, r.rows[0].count);
}
await c.end();
