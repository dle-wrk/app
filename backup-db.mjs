import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backupDir = path.join(__dirname, 'db-backup');

// Create backup directory
if (fs.existsSync(backupDir)) {
  fs.rmSync(backupDir, { recursive: true });
}
fs.mkdirSync(backupDir, { recursive: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function getAllTables() {
  const result = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
  `);
  return result.rows.map(row => row.table_name);
}

async function exportTable(tableName) {
  const result = await pool.query(`SELECT * FROM ${tableName}`);
  const filePath = path.join(backupDir, `${tableName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(result.rows, null, 2));
  console.log(`✓ Exported ${tableName} (${result.rows.length} rows)`);
}

async function main() {
  try {
    console.log('📦 Starting database backup...\n');

    const tables = await getAllTables();
    console.log(`Found ${tables.length} tables\n`);

    for (const table of tables) {
      await exportTable(table);
    }

    console.log('\n✅ Backup complete!');
    console.log(`📁 Location: ${backupDir}`);
    console.log('\nNow zipping with PowerShell...');

    await pool.end();
  } catch (error) {
    console.error('❌ Backup failed:', error.message);
    process.exit(1);
  }
}

main();
