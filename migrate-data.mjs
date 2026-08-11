// One-off: copy catalog + admin data from the local dev DB to the new
// Render Postgres instance. Run once; safe to re-run (tables are truncated
// first) but not meant to stay in the repo long-term.
import pg from 'pg';

const LOCAL_URL = 'postgresql://target_traders:target_traders@localhost:5432/target_traders';
const REMOTE_URL = process.env.REMOTE_DATABASE_URL;

if (!REMOTE_URL) {
  console.error('Set REMOTE_DATABASE_URL first.');
  process.exit(1);
}

const local = new pg.Client({ connectionString: LOCAL_URL });
const remote = new pg.Client({ connectionString: REMOTE_URL, ssl: { rejectUnauthorized: false } });

// Dependency order matters (FKs): categories -> subcategories -> products -> product_images.
const TABLES = ['categories', 'subcategories', 'products', 'product_images', 'admins'];

async function copyTable(table) {
  const { rows } = await local.query(`SELECT * FROM ${table} ORDER BY id`);
  if (rows.length === 0) {
    console.log(`${table}: 0 rows, skipping`);
    return;
  }
  const { rows: colRows } = await remote.query(
    `SELECT column_name, data_type, is_generated FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  const generated = new Set(colRows.filter((r) => r.is_generated === 'ALWAYS').map((r) => r.column_name));
  // node-postgres serializes a bare JS array/object as a Postgres ARRAY
  // literal, not JSON - since the local SELECT already parsed json/jsonb
  // columns into JS values, they need to be re-stringified before going
  // back in as parameters.
  const jsonCols = new Set(colRows.filter((r) => r.data_type === 'json' || r.data_type === 'jsonb').map((r) => r.column_name));
  const cols = Object.keys(rows[0]).filter((c) => !generated.has(c));
  await remote.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
  const colList = cols.map((c) => `"${c}"`).join(', ');
  for (const row of rows) {
    const values = cols.map((c) => (jsonCols.has(c) && row[c] !== null ? JSON.stringify(row[c]) : row[c]));
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    await remote.query(`INSERT INTO ${table} (${colList}) VALUES (${placeholders})`, values);
  }
  // Bring the identity sequence back in sync with the copied ids.
  await remote.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT COALESCE(MAX(id), 1) FROM ${table}))`);
  console.log(`${table}: copied ${rows.length} rows`);
}

async function main() {
  await local.connect();
  await remote.connect();
  for (const t of TABLES) {
    await copyTable(t);
  }
  await local.end();
  await remote.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
