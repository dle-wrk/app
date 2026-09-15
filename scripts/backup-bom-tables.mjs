// Read-only snapshot of every db_bom* table in the connected Neon
// database. Writes one JSON file per table into ./backups/bom-<iso>/,
// plus a manifest listing every table + row count + a paste-into-Neon
// SQL restore snippet. Nothing is written to the database — this is a
// pure export.
//
// Run: node scripts/backup-bom-tables.mjs
// Restore: read backups/bom-<iso>/RESTORE.sql, review, and paste the
// section you want into the Neon SQL Editor.

import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
import path from 'node:path';

const env = fs.readFileSync('.env', 'utf8');
const dbUrl = env.match(/DATABASE_URL="([^"]+)"/)[1];
const sql = neon(dbUrl);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve('backups', `bom-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });

const { 0: _unused, ...rest } = { _unused: null };
void rest;

const tablesRes = await sql`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'db_bom%' ORDER BY 1`;
const tables = tablesRes.map(r => r.t);
console.log(`Found ${tables.length} db_bom* tables. Snapshotting to ${outDir}\n`);

const manifest = { snapshotAt: new Date().toISOString(), database: dbUrl.replace(/:[^:@]+@/, ':***@'), tables: [] };
const restoreLines = [
  '-- BOM tables snapshot restore script.',
  `-- Snapshot taken: ${new Date().toISOString()}`,
  '--',
  '-- Each table below has a TRUNCATE + INSERT block. Paste the sections',
  '-- you want back into the Neon SQL Editor to restore that table to',
  '-- exactly what it held at snapshot time. Review before running.',
  '',
];

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return `'${String(v).replace(/'/g, "''")}'`;
}

for (const t of tables) {
  const rows = await sql.query(`SELECT * FROM "${t}"`);
  const cols = rows.length ? Object.keys(rows[0]) : (await sql`SELECT column_name FROM information_schema.columns WHERE table_name = ${t} ORDER BY ordinal_position`).map(c => c.column_name);
  fs.writeFileSync(path.join(outDir, `${t}.json`), JSON.stringify(rows, null, 2));
  manifest.tables.push({ table: t, rows: rows.length, columns: cols });
  console.log(`  ${t.padEnd(28)} ${String(rows.length).padStart(5)} rows`);

  restoreLines.push('-- ============================================================');
  restoreLines.push(`-- ${t}   (${rows.length} rows)`);
  restoreLines.push('-- ============================================================');
  restoreLines.push('BEGIN;');
  restoreLines.push(`TRUNCATE "${t}";`);
  const colList = cols.map(c => `"${c}"`).join(', ');
  for (const r of rows) {
    const vals = cols.map(c => sqlLiteral(r[c])).join(', ');
    restoreLines.push(`INSERT INTO "${t}" (${colList}) VALUES (${vals});`);
  }
  restoreLines.push('COMMIT;');
  restoreLines.push('');
}

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(outDir, 'RESTORE.sql'), restoreLines.join('\n'));

console.log(`\n✅ Snapshot complete.`);
console.log(`   Backup directory: ${outDir}`);
console.log(`   To restore, review and paste blocks from RESTORE.sql into the Neon SQL Editor.`);
