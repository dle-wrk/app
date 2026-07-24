import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

export const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 5000,
  // Neon serverless databases sleep when idle and can take several seconds to wake, so allow
  // a generous connection timeout to avoid spurious failures on the first request after idle.
  connectionTimeoutMillis: 15000
});

export type QueryResult<T = any> = { rows: T[]; rowCount: number };

export async function query<T = any>(text: string, params: any[] = []): Promise<QueryResult<T>> {
  const res = await pool.query(text, params);
  return { rows: res.rows, rowCount: res.rowCount ?? 0 };
}

export async function queryOne<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const { rows } = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function exec(text: string): Promise<void> {
  await pool.query(text);
}

export async function close(): Promise<void> {
  await pool.end();
}

function parseCsv(filePath: string, delimiter = ';'): { headers: string[]; rows: string[][] } {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n');
  if (lines.length < 2) return { headers: [], rows: [] };

  const headers = lines[0].split(delimiter).map(h => h.trim().replace(/^\uFEFF/, ''));
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === delimiter && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    values.push(current.trim());
    while (values.length < headers.length) values.push('');
    rows.push(values.slice(0, headers.length));
  }
  return { headers, rows };
}

async function seedTable(tableName: string, filePath: string, delimiter = ';') {
  if (!fs.existsSync(filePath)) {
    console.warn(`SKIP ${path.basename(filePath)}: not found`);
    return 0;
  }
  const { headers, rows } = parseCsv(filePath, delimiter);
  if (!headers.length || !rows.length) return 0;

  const integerColumns = new Set<string>();
  const statusValidValues = ['ACTIVE', 'INACTIVE', 'BOOKED OUT', 'DISCONTINUED'];
  const statusIdx = headers.indexOf('status');
  let pkColumn = headers.find(h => ['serial_number', 'id', 'kitId', 'trxId'].includes(h)) || null;
  let compositePk = '';

  if (tableName.startsWith('pp_bom_') && headers.includes('StockCode') && headers.includes('Designator')) {
    pkColumn = null; // Prevent single-column PK
    compositePk = 'PRIMARY KEY ("StockCode", "Designator")';
  }

  const colDefs = headers.map(h => {
    if (pkColumn && h === pkColumn) {
      return `"${h}" TEXT PRIMARY KEY`;
    }
    if (h === 'stock' || h === 'qty_per_unit' || h === 'quantity' || h === 'qty_per_pcb' || h === 'last_order_qty' || h === 'lead_time' || h === 'response_time' || h === 'build_qty' || h === 'project_id' || h === 'projectId') {
      integerColumns.add(h);
      return `"${h}" INTEGER`;
    }
    if (h === 'status') {
      return `"${h}" TEXT CHECK ("${h}" IN ('ACTIVE', 'INACTIVE', 'BOOKED OUT', 'DISCONTINUED'))`;
    }
    return `"${h}" TEXT`;
  });

  const tableDef = compositePk ? `${colDefs.join(', ')}, ${compositePk}` : colDefs.join(', ');
  await exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${tableDef})`);
  const truncateOk = await pool.query(`TRUNCATE TABLE "${tableName}" CASCADE`).catch(() => null);
  if (!truncateOk) console.warn(`Skipped truncate for ${tableName}`);

  const cols = headers.map((h, i) => `"${h}"`).join(', ');
  const placeholders = headers.map((_, i) => `$${i + 1}`).join(', ');
  let updates = '';
  if (compositePk) {
    updates = headers.filter(h => h !== 'StockCode' && h !== 'Designator').map(h => `"${h}" = EXCLUDED."${h}"`).join(', ');
  } else if (pkColumn) {
    updates = headers.filter(h => h !== pkColumn).map(h => `"${h}" = EXCLUDED."${h}"`).join(', ');
  }

  const sql = pkColumn
    ? `INSERT INTO "${tableName}" (${cols}) VALUES (${placeholders}) ON CONFLICT("${pkColumn}") DO UPDATE SET ${updates}`
    : `INSERT INTO "${tableName}" (${cols}) VALUES (${placeholders})`;

  for (const row of rows) {
    const vals = row.map((v, i) => {
      if (v === '' && integerColumns.has(headers[i])) return null;
      if (integerColumns.has(headers[i]) && typeof v === 'string') {
        const cleaned = v.replace(',', '.');
        const num = Number(cleaned);
        return Number.isNaN(num) ? null : Math.round(num);
      }
      if (headers[i] === 'status' && v === '') return 'ACTIVE';
      return v;
    });
    await pool.query(sql, vals);
  }
  return rows.length;
}

// Fixed DDL for the core tables, used regardless of whether seed CSVs are present on disk.
// (Previously table creation only happened inside seedTable(), which returns early if the
// CSV file is missing -- meaning a fresh database with no assets/*.csv would never get an
// `inventory`, `suppliers`, or `projects` table at all, and the app would 500 on first load.)
async function ensureInventoryTable() {
  await exec(`CREATE TABLE IF NOT EXISTS inventory (
    serial_number TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    value TEXT,
    size TEXT,
    package TEXT,
    tolerance TEXT,
    type TEXT,
    footprint TEXT,
    comment TEXT,
    datasheet TEXT,
    project TEXT,
    packaging TEXT,
    stock INTEGER DEFAULT 0,
    qty_per_pcb NUMERIC(10,2),
    low_stock_lvl INTEGER DEFAULT 50,
    current_cost_dollar NUMERIC(12,4) DEFAULT 0,
    bulk_price_usd NUMERIC(12,4),
    bulk_price_zar NUMERIC(12,4),
    last_order_qty INTEGER,
    last_order_date TEXT,
    status TEXT CHECK (status IN ('ACTIVE', 'INACTIVE', 'BOOKED OUT', 'DISCONTINUED')) DEFAULT 'ACTIVE',
    man_pn_1 TEXT, man_pn_2 TEXT, man_pn_3 TEXT, man_pn_4 TEXT, man_pn_5 TEXT,
    sup_pn_1 TEXT, sup_pn_2 TEXT, sup_pn_3 TEXT, sup_pn_4 TEXT, sup_pn_5 TEXT,
    weblink_1 TEXT, weblink_2 TEXT, weblink_3 TEXT, weblink_4 TEXT, weblink_5 TEXT,
    supplier TEXT DEFAULT 'N/A'
  )`);
  await exec(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS supplier TEXT DEFAULT 'N/A'`).catch(() => {});
}

async function ensureSuppliersTable() {
  await exec(`CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    name TEXT,
    website TEXT,
    contact_email TEXT,
    notes TEXT,
    lead_time INTEGER,
    response_time INTEGER
  )`);
}

async function ensurePricingTables() {
  await exec(`CREATE TABLE IF NOT EXISTS pricing_api_usage (
    provider TEXT NOT NULL,
    usage_date DATE NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, usage_date)
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS lcsc_price_cache (
    part_number TEXT PRIMARY KEY,
    mpn TEXT,
    price NUMERIC(12,4),
    currency TEXT DEFAULT 'USD',
    stock INTEGER,
    url TEXT,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  await exec(`ALTER TABLE lcsc_price_cache ADD COLUMN IF NOT EXISTS mpn TEXT`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS lcsc_price_cache_mpn_idx ON lcsc_price_cache (mpn)`).catch(() => {});
  // Rotating OAuth refresh tokens (e.g. DigiKey, which rotates on every use) live here instead
  // of .env, so a token rotation never rewrites a file the Vite dev server watches (writing to
  // .env mid-request triggers Vite's full dev-server restart, killing the in-flight response).
  await exec(`CREATE TABLE IF NOT EXISTS pricing_tokens (
    provider TEXT PRIMARY KEY,
    refresh_token TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS supplier_price_history (
    id SERIAL PRIMARY KEY,
    supplier TEXT NOT NULL,
    part_number TEXT NOT NULL,
    price NUMERIC(12,4),
    currency TEXT,
    stock INTEGER,
    moq INTEGER,
    lead_time_days INTEGER,
    queried_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(supplier, part_number, queried_at)
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS supplier_price_history_part_supplier_idx ON supplier_price_history (part_number, supplier, queried_at DESC)`).catch(() => {});
  await exec(`CREATE TABLE IF NOT EXISTS supplier_performance (
    supplier TEXT PRIMARY KEY,
    total_lookups INTEGER DEFAULT 0,
    avg_price NUMERIC(12,4),
    avg_lead_time_days NUMERIC(5,1),
    stock_availability_pct NUMERIC(5,2),
    last_updated TIMESTAMPTZ DEFAULT now()
  )`);
}

async function ensureProductionTables() {
  // Production jobs/build jobs extended schema
  await exec(`CREATE TABLE IF NOT EXISTS production_jobs (
    id SERIAL PRIMARY KEY,
    job_number TEXT UNIQUE NOT NULL,
    client_order_id INTEGER REFERENCES client_orders(id) ON DELETE SET NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'PLANNED',
    priority TEXT DEFAULT 'MEDIUM',
    build_qty INTEGER DEFAULT 1,
    completed_qty INTEGER DEFAULT 0,
    defect_qty INTEGER DEFAULT 0,
    yield_pct NUMERIC(5,2),
    scheduled_start DATE,
    scheduled_end DATE,
    actual_start TIMESTAMP,
    actual_end TIMESTAMP,
    assigned_team TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Work orders / assembly procedures
  await exec(`CREATE TABLE IF NOT EXISTS work_orders (
    id SERIAL PRIMARY KEY,
    production_job_id INTEGER REFERENCES production_jobs(id) ON DELETE CASCADE,
    work_order_number TEXT UNIQUE NOT NULL,
    work_type TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'PENDING',
    sequence_order INTEGER,
    assigned_to TEXT,
    estimated_hours NUMERIC(8,2),
    actual_hours NUMERIC(8,2),
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Component allocation to production jobs
  await exec(`CREATE TABLE IF NOT EXISTS job_component_allocation (
    id SERIAL PRIMARY KEY,
    production_job_id INTEGER REFERENCES production_jobs(id) ON DELETE CASCADE,
    component_id TEXT NOT NULL,
    qty_allocated INTEGER NOT NULL,
    qty_consumed INTEGER DEFAULT 0,
    qty_defective INTEGER DEFAULT 0,
    allocated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    consumed_at TIMESTAMP
  )`);

  // Quality control checkpoints
  await exec(`CREATE TABLE IF NOT EXISTS qc_checkpoints (
    id SERIAL PRIMARY KEY,
    production_job_id INTEGER REFERENCES production_jobs(id) ON DELETE CASCADE,
    checkpoint_name TEXT NOT NULL,
    checkpoint_type TEXT NOT NULL,
    sequence_order INTEGER,
    status TEXT DEFAULT 'PENDING',
    inspector TEXT,
    inspected_at TIMESTAMP,
    result TEXT,
    defects_found INTEGER DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Defect/issue logging
  await exec(`CREATE TABLE IF NOT EXISTS production_defects (
    id SERIAL PRIMARY KEY,
    production_job_id INTEGER REFERENCES production_jobs(id) ON DELETE CASCADE,
    qc_checkpoint_id INTEGER REFERENCES qc_checkpoints(id) ON DELETE SET NULL,
    defect_code TEXT NOT NULL,
    defect_description TEXT,
    severity TEXT DEFAULT 'MEDIUM',
    component_affected TEXT,
    root_cause TEXT,
    corrective_action TEXT,
    status TEXT DEFAULT 'OPEN',
    discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP
  )`);

  // Order fulfillment tracking
  await exec(`CREATE TABLE IF NOT EXISTS order_fulfillment (
    id SERIAL PRIMARY KEY,
    client_order_id INTEGER REFERENCES client_orders(id) ON DELETE CASCADE,
    production_job_id INTEGER REFERENCES production_jobs(id) ON DELETE SET NULL,
    fulfillment_status TEXT DEFAULT 'PENDING',
    qty_ordered INTEGER NOT NULL,
    qty_built INTEGER DEFAULT 0,
    qty_shipped INTEGER DEFAULT 0,
    expected_ship_date DATE,
    actual_ship_date DATE,
    tracking_number TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Production metrics/analytics
  await exec(`CREATE TABLE IF NOT EXISTS production_metrics (
    id SERIAL PRIMARY KEY,
    metric_date DATE DEFAULT CURRENT_DATE,
    total_jobs_started INTEGER DEFAULT 0,
    total_jobs_completed INTEGER DEFAULT 0,
    avg_cycle_time_hours NUMERIC(8,2),
    avg_yield_pct NUMERIC(5,2),
    total_defects INTEGER DEFAULT 0,
    defect_rate_pct NUMERIC(5,2),
    on_time_completion_pct NUMERIC(5,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Indexes for performance
  await exec(`CREATE INDEX IF NOT EXISTS production_jobs_status_idx ON production_jobs (status)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS production_jobs_order_idx ON production_jobs (client_order_id)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS work_orders_job_idx ON work_orders (production_job_id, status)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS job_allocation_job_idx ON job_component_allocation (production_job_id)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS qc_checkpoints_job_idx ON qc_checkpoints (production_job_id, status)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS defects_job_idx ON production_defects (production_job_id, status)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS fulfillment_order_idx ON order_fulfillment (client_order_id, fulfillment_status)`).catch(() => {});
}

async function ensureAutomationTables() {
  // Automation rules engine
  await exec(`CREATE TABLE IF NOT EXISTS automation_rules (
    id SERIAL PRIMARY KEY,
    rule_name TEXT NOT NULL,
    rule_type TEXT NOT NULL,
    description TEXT,
    trigger_event TEXT NOT NULL,
    conditions JSONB,
    actions JSONB NOT NULL,
    is_active BOOLEAN DEFAULT true,
    priority INTEGER DEFAULT 0,
    created_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Scheduled jobs
  await exec(`CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id SERIAL PRIMARY KEY,
    job_name TEXT UNIQUE NOT NULL,
    job_type TEXT NOT NULL,
    schedule_type TEXT NOT NULL,
    cron_expression TEXT,
    next_run TIMESTAMP,
    last_run TIMESTAMP,
    last_status TEXT DEFAULT 'PENDING',
    is_active BOOLEAN DEFAULT true,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    config JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Notification templates
  await exec(`CREATE TABLE IF NOT EXISTS notification_templates (
    id SERIAL PRIMARY KEY,
    template_name TEXT UNIQUE NOT NULL,
    template_type TEXT NOT NULL,
    subject TEXT,
    body TEXT NOT NULL,
    variables JSONB,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Notifications queue
  await exec(`CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    notification_type TEXT NOT NULL,
    recipient TEXT NOT NULL,
    subject TEXT,
    message TEXT NOT NULL,
    data JSONB,
    status TEXT DEFAULT 'PENDING',
    sent_at TIMESTAMP,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Event log for audit trail
  await exec(`CREATE TABLE IF NOT EXISTS event_log (
    id SERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    action TEXT,
    user_id TEXT,
    details JSONB,
    ip_address TEXT,
    status TEXT DEFAULT 'SUCCESS',
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Auto-PO configuration
  await exec(`CREATE TABLE IF NOT EXISTS auto_po_config (
    id SERIAL PRIMARY KEY,
    component_id TEXT UNIQUE NOT NULL,
    min_stock_level INTEGER NOT NULL DEFAULT 10,
    auto_po_threshold INTEGER NOT NULL DEFAULT 5,
    preferred_supplier TEXT,
    auto_supplier_select BOOLEAN DEFAULT true,
    auto_approve BOOLEAN DEFAULT false,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Alert subscriptions
  await exec(`CREATE TABLE IF NOT EXISTS alert_subscriptions (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    alert_type TEXT NOT NULL,
    channel TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    preferences JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Automation execution log
  await exec(`CREATE TABLE IF NOT EXISTS automation_executions (
    id SERIAL PRIMARY KEY,
    rule_id INTEGER REFERENCES automation_rules(id) ON DELETE CASCADE,
    triggered_by TEXT,
    status TEXT DEFAULT 'PENDING',
    result_data JSONB,
    error_message TEXT,
    execution_time_ms INTEGER,
    executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Indexes for performance
  await exec(`CREATE INDEX IF NOT EXISTS automation_rules_active_idx ON automation_rules (is_active, trigger_event)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS scheduled_jobs_active_idx ON scheduled_jobs (is_active, next_run)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS notifications_status_idx ON notifications (status, created_at DESC)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS event_log_type_idx ON event_log (event_type, created_at DESC)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS auto_po_enabled_idx ON auto_po_config (enabled, component_id)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS alert_subscriptions_user_idx ON alert_subscriptions (user_id, alert_type)`).catch(() => {});
}

async function ensureProjectsTable() {
  await exec(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    project_name TEXT,
    description TEXT,
    status TEXT DEFAULT 'Active',
    created_date TEXT,
    start_date TEXT,
    end_date TEXT,
    assigned_team TEXT,
    design_specs TEXT
  )`);
}

// Small representative dataset used only when a brand-new database has no assets/*.csv to
// seed from, so core views (Items, Suppliers, Projects) are demoable out of the box instead
// of rendering empty. Never overwrites existing rows (ON CONFLICT DO NOTHING).
const FALLBACK_INVENTORY: Array<[string, string, string, number, string, number]> = [
  // [serial_number, name, category/type, stock, value, currentCostDollar]
  ['CAP-001', '100nF Ceramic Capacitor', 'Capacitors', 500, '100nF', 0.02],
  ['CAP-002', '10uF Electrolytic Capacitor', 'Capacitors', 300, '10uF', 0.05],
  ['RES-001', '10k Ohm Resistor 0603', 'Resistors', 1000, '10k', 0.01],
  ['RES-002', '1k Ohm Resistor 0603', 'Resistors', 800, '1k', 0.01],
  ['CHP-001', 'STM32G031F6P6 Microcontroller', 'ICs', 120, 'MCU', 1.85],
  ['CHP-002', 'ESP32-WROOM-32 Module', 'ICs', 60, 'MCU', 3.20],
  ['CON-001', 'USB-C Connector', 'Connectors', 200, 'USB-C', 0.35],
  ['CON-002', 'JST-PH 2-Pin Connector', 'Connectors', 350, '2-Pin', 0.08],
  ['LED-001', 'Red LED 0805', 'LEDs', 400, 'Red', 0.03],
  ['ANT-001', 'Fiberglass Antenna LoRa 433MHz', 'Antennas', 75, '433MHz', 2.10],
  ['TRA-001', '2N2222 NPN Transistor', 'Transistors', 250, 'NPN', 0.06],
  ['DIO-001', '1N4148 Signal Diode', 'Diodes', 500, 'Signal', 0.02],
  ['BAT-001', '18650 Li-ion Battery Cell', 'Batteries', 90, '3.7V', 4.50],
  ['ASS-001', 'TCU06 Main PCB Sub-Assembly', 'Sub-Assemblies', 20, 'Assembly', 45.00],
];

const FALLBACK_SUPPLIERS: Array<[string, string, string, string, number, number]> = [
  ['1', 'Digi-Key Electronics', 'https://www.digikey.com', 'orders@digikey.com', 5, 24],
  ['2', 'Mouser Electronics', 'https://www.mouser.com', 'sales@mouser.com', 6, 12],
  ['3', 'LCSC Electronics', 'https://www.lcsc.com', 'support@lcsc.com', 14, 48],
  ['4', 'Local Components CC', '', 'sales@localcomponents.co.za', 2, 6],
];

const FALLBACK_PROJECTS: Array<[string, string, string]> = [
  ['1', 'TCU06 Telemetry Control Unit', 'Active'],
  ['2', 'NCU04 Network Control Unit', 'Active'],
];

async function seedFallbackInventory() {
  for (const [sn, name, type, stock, value, cost] of FALLBACK_INVENTORY) {
    await pool.query(
      `INSERT INTO inventory (serial_number, name, description, type, stock, low_stock_lvl, value, current_cost_dollar, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE') ON CONFLICT (serial_number) DO NOTHING`,
      [sn, name, name, type, stock, 50, value, cost]
    );
  }
  console.log(`Seeded ${FALLBACK_INVENTORY.length} fallback inventory items (no MainInventory.csv found).`);
}

async function seedFallbackSuppliers() {
  for (const [id, name, website, email, leadTime, responseTime] of FALLBACK_SUPPLIERS) {
    await pool.query(
      `INSERT INTO suppliers (id, name, website, contact_email, lead_time, response_time) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [id, name, website, email, leadTime, responseTime]
    );
  }
  console.log(`Seeded ${FALLBACK_SUPPLIERS.length} fallback suppliers (no Suppliers.csv found).`);
}

async function seedFallbackProjects() {
  const today = new Date().toISOString().slice(0, 10);
  for (const [id, name, status] of FALLBACK_PROJECTS) {
    await pool.query(
      `INSERT INTO projects (id, project_name, description, status, created_date) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [id, name, name, status, today]
    );
  }
  console.log(`Seeded ${FALLBACK_PROJECTS.length} fallback projects (no Projects.csv found).`);
}

export async function ensureSchema() {
  const exists = await queryOne<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'inventory'
    ) as exists
  `);
  if (exists?.exists) {
    await exec(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS status TEXT CHECK (status IN ('ACTIVE', 'INACTIVE', 'BOOKED OUT', 'DISCONTINUED'))`).catch(() => {});
    await exec(`UPDATE inventory SET status = 'ACTIVE' WHERE status IS NULL`).catch(() => {});
    // Belt-and-braces: make sure sibling tables exist too, in case of a partially-provisioned
    // database. CREATE TABLE IF NOT EXISTS is a no-op (and never touches data) when they're
    // already there, so this is safe to run on every boot against a live database.
    await ensureSuppliersTable();
    await ensureProjectsTable();
    await ensurePricingTables();
    await ensureProductionTables();
    await ensureAutomationTables();
    return;
  }

  const assetsDir = path.join(process.cwd(), 'assets');
  console.log('Seeding database from CSV files...');

  await ensureInventoryTable();
  await ensureSuppliersTable();
  await ensureProjectsTable();
  await ensureProductionTables();
  await ensureAutomationTables();

  const inventoryCount = await seedTable('inventory', path.join(assetsDir, 'MainInventory.csv'));
  if (inventoryCount === 0) await seedFallbackInventory();

  const suppliersCount = await seedTable('suppliers', path.join(assetsDir, 'Suppliers.csv'), ',');
  if (suppliersCount === 0) await seedFallbackSuppliers();

  const projectsCount = await seedTable('projects', path.join(assetsDir, 'Projects.csv'), ',');
  if (projectsCount === 0) await seedFallbackProjects();

  await seedTable('alternative_components', path.join(assetsDir, 'component_alternates.csv'), ',');

  // Also run the BOM/PP seeding for a new database.
  await seedBomAndPpTables(assetsDir);

  console.log('Initial database seed complete.');
}

async function seedBomAndPpTables(assetsDir: string) {
  if (!fs.existsSync(assetsDir)) return;
  console.log('Seeding BOM/PP tables from assets...');
  const bomFiles = fs.readdirSync(assetsDir).filter(f => f.startsWith('dbBOM_') && f.endsWith('.csv'));
  for (const file of bomFiles) {
    const tableName = `db_bom_${file.replace('dbBOM_', '').split('_')[0].replace('.csv', '').toLowerCase()}`;
    const count = await seedTable(tableName, path.join(assetsDir, file));
    console.log(`Seeded ${count} rows into ${tableName} from ${file}`);
  }
  const ppFiles = fs.readdirSync(assetsDir).filter(f => f.startsWith('PP_BOM_') && f.endsWith('.csv'));
  for (const file of ppFiles) {
    const tableName = `pp_bom_${file.replace('PP_BOM_', '').split('_')[0].replace('.csv', '').toLowerCase()}`;
    const count = await seedTable(tableName, path.join(assetsDir, file));
    console.log(`Seeded ${count} rows into ${tableName} from ${file}`);
  }
}
