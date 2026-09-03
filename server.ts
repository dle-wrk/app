import { initSentry, requestIdMiddleware, attachErrorHandler } from './src/lib/sentryServer';
// Init Sentry BEFORE the express import so its auto-instrumentation can hook
// the module. No-ops if SENTRY_DSN isn't set — safe to leave unconfigured.
initSentry();

import express from 'express';
import compression from 'compression';
import { spawn } from 'child_process';
import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  registerAuthRoutes,
  attachSessionUser,
  BCRYPT_ROUNDS,
} from './src/lib/authRoutes';
import { registerUsersRoutes } from './src/lib/usersRoutes';
import { registerDocsRoutes } from './src/lib/docsRoutes';
import { registerSuppliersRoutes } from './src/lib/suppliersRoutes';
import { registerPricingRoutes } from './src/lib/pricingRoutes';
import { registerExchangeRateRoutes, updateExchangeRate } from './src/lib/exchangeRate';
import { registerItemsRoutes } from './src/lib/itemsRoutes';
import { registerProductionRoutes, ensureProductionCostsSchema } from './src/lib/productionRoutes';
import { registerAutomationRoutes } from './src/lib/automationRoutes';
import { registerProjectsRoutes } from './src/lib/projectsRoutes';
import { registerClientsRoutes } from './src/lib/clientsRoutes';
import { registerAssetsRoutes } from './src/lib/assetsRoutes';
import { registerInventoryMetadataRoutes } from './src/lib/inventoryMetadataRoutes';

import { pool, query, queryOne, exec, ensureSchema, close } from './src/lib/db';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determine dist directory path (handle both dev and prod)
const distPath = path.resolve(__dirname, 'dist');
const altDistPath = path.resolve(process.cwd(), 'dist');
const DIST_DIR = existsSync(distPath) ? distPath : altDistPath;

import { ensureBookkeepingSchema } from './src/lib/bookkeeping-db';
import { registerBookkeepingRoutes } from './src/lib/bookkeeping-routes';
import { ensurePhase5Tables } from './src/lib/phase5-db';
import phase5Routes from './src/lib/phase5-routes';

const app = express();
// Request ID first — everything downstream should log with req.id so log
// lines and Sentry events can be correlated on a single incident.
app.use(requestIdMiddleware());
app.use(compression());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
// 20mb accommodates scanned till slips (receipts) and doc attachments (PDFs)
// posted as base64. Individual endpoints enforce their own per-payload caps
// so a huge body can't sneak past.
app.use(express.json({ limit: '20mb' }));

// Security response headers. We deliberately don't use a full CSRF token
// scheme — the auth surface uses X-Session-Id from localStorage, which
// browsers won't send on cross-origin requests (no CORS preflight allowance
// on a custom header) and no other origin can read localStorage. Frame
// embedding is disallowed so a malicious iframe can't render the app and
// scrape via postMessage.
app.use((_req, res, next) => {
  // CSP: allow self + inline styles (Tailwind), data: images (receipts),
  // blob: workers (Tesseract), and wasm eval. External images/APIs limited
  // to the vendors we actually call from the browser (rare — most vendor
  // traffic goes server-side).
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https: blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  // HSTS only makes sense over HTTPS; Fly serves us over HTTPS. Two-year
  // max-age + includeSubDomains + preload readiness.
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
});

// Populate req.user from the client's X-Session-Id header when present.
// Scoped to /api so static asset requests don't trigger a DB lookup.
app.use('/api', (req, res, next) => attachSessionUser(req, res, next));

// Serve static files from dist directory
app.use(express.static(DIST_DIR));


// Bookkeeping / ERP module — Chart of Accounts, invoices, bills, payments, reports.
registerBookkeepingRoutes(app);

// Phase 5: Quality & Compliance + Advanced Automation
app.use(phase5Routes);

// Auth (/api/login, /api/session/*, /api/auth/*). attachSessionUser is applied
// globally further down; per-route admin gating is enforced inside each router.
registerAuthRoutes(app);

// Users (/api/users/*, /api/roles). Admin-gated CRUD plus one bootstrap seeder.
registerUsersRoutes(app);

// Docs (/api/docs/*). Everyone reads; only admins mutate. Supports optional
// inline file attachments (streamed back from /api/docs/:id/file).
registerDocsRoutes(app);

// Suppliers (/api/suppliers/*): CRUD + price-history + performance. The
// /compare-prices endpoint under the same prefix is registered by pricingRoutes
// because it fans out through the same provider clients.
registerSuppliersRoutes(app);

// Pricing (/api/pricing/* + /api/suppliers/compare-prices). Live lookups
// against DigiKey/Mouser/LCSC/Nexar/element14/TME, cache, daily-limit counter,
// encrypted key vault, and bulk-refresh writer.
registerPricingRoutes(app);

// Exchange rate (/api/exchange-rate, /api/exchange-rate/update). Consumed by
// the pricing bulk-refresh; also refreshed on boot and daily at 06:00 UTC.
registerExchangeRateRoutes(app);

// Items (/api/items/*). Inventory CRUD, bulk upsert, status-repair helpers,
// and the category-based next-code generator.
registerItemsRoutes(app);

// Production (/api/production-*, /api/work-orders, /api/qc-checkpoints,
// /api/job-allocations, /api/order-fulfillment, /api/build-jobs,
// /api/kit-booking/*). Phase 3 job/QC/fulfillment surface plus the
// finished-goods catalogue and the transactional kit-booking flow.
// Schema bootstrap for production_products is called from the boot bootstrap
// below (ensureProductionCostsSchema); registering the routes here does not
// create tables.
registerProductionRoutes(app);

// Automation surface (Phase 4): rules, scheduled jobs, notifications,
// auto-PO config, event log, alert subscriptions, and the trigger actions
// that stitch them together. Assumes the Phase 4 tables already exist
// (bootstrap earlier in this file / phase5-db handle the schema).
registerAutomationRoutes(app);

// Projects surface: project CRUD (including MAX(id)+1 allocation and
// upsert-by-name), the per-project BOM / P&P tables (db_bom_project_<id>,
// pp_bom_project_<id>), job cards, and the aggregated /api/bom-items and
// /api/pp-items feeds that walk pg_class. No schema bootstrap moved —
// per-project tables are created lazily on first BOM write.
registerProjectsRoutes(app);

// Clients surface: /api/clients, /api/client-orders, /api/client-order-items.
// Reads and writes both target the `clients` table (not the legacy
// `customers` table) — the bookkeeping foreign keys point at clients.id,
// so a write against `customers` would create a row invoices/dispatches
// can't reference.
registerClientsRoutes(app);

// Assets surface: sub-assemblies (grouped parent/child part rollups) and
// fielded-assets (serial-numbered units at customer sites). Distinct from
// bom_structures — that's the raw parent-child graph, lives with the
// inventory-metadata surface.
registerAssetsRoutes(app);

// Inventory-metadata surface: bom_structures (raw parent/child part graph)
// and stock_ledger (append-log of warehouse movements — distinct from the
// `transactions` table used by the BOOK-IN UI, which records user-facing
// bookings).
registerInventoryMetadataRoutes(app);


// Helper functions for document numbering and mapping
async function nextDocNumber(client: any, docType: string, seqTable: string): Promise<string> {
  const result = await client.query(
    `SELECT nextval('${seqTable}') as seq`
  );
  const seq = result.rows[0].seq;
  return `${docType}-${String(seq).padStart(6, '0')}`;
}

function mapPurchaseOrder(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    poNumber: row.po_number,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    orderDate: row.order_date,
    expectedDate: row.expected_date,
    status: row.status,
    currency: row.currency,
    subtotal: row.subtotal,
    taxTotal: row.tax_total,
    total: row.total,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function mapPurchaseOrderItem(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    purchaseOrderId: row.purchase_order_id,
    partNumber: row.part_number,
    description: row.description,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    taxAmount: row.tax_amount || 0,
    lineTotal: row.line_total || 0,
    qtyReceived: row.qty_received || 0,
  };
}


// Production catalogue / kits / jobs / QC / fulfillment / metrics live in
// src/lib/productionRoutes.ts. ensureProductionCostsSchema is imported at
// the top of this file and invoked from the boot bootstrap below.

app.get('/api/bootstrap', async (_req, res) => {
  try {
    // 1. Items (exclude soft-deleted rows, same as GET /api/items)
    const { rows: itemsRows } = await query('SELECT * FROM inventory WHERE deleted != true ORDER BY serial_number');
    const { rows: countRows } = await query<{ count: string }>('SELECT COUNT(*) as count FROM inventory WHERE deleted != true');
    const totalItems = parseInt(countRows[0]?.count || '0', 10);

    // 2. Suppliers
    const { rows: suppliers } = await query('SELECT * FROM suppliers ORDER BY id');

    // 3. Projects
    const { rows: projectsRows } = await query('SELECT * FROM projects ORDER BY id');
    const projects = projectsRows.map((r: any) => ({
      // Numeric id: BOM/PP rows carry numeric projectId and the frontend Project
      // type declares id: number — emitting strings here broke strict-equality
      // filters (blank BOM manager) before App.tsx normalization was added.
      id: parseInt(r.id),
      projectName: r.project_name,
      description: r.description,
      status: r.status,
      createdDate: r.created_date,
      startDate: r.start_date,
      endDate: r.end_date,
      assignedTeam: r.assigned_team,
      designSpecs: r.design_specs
    }));

    // 4. Transactions
    const { rows: transactions } = await query('SELECT * FROM transactions ORDER BY id DESC LIMIT 100 OFFSET 0');

    // 5. Production Kits
    const { rows: productionKits } = await query('SELECT * FROM production_kits ORDER BY lastUpdated DESC');

    // 6. BOM Items (db_bom)
    const { rows: bomTables } = await query<{ tablename: string }>(`SELECT c.relname as tablename FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'db_bom%'`);
    let bomItems: any[] = [];
    for (const t of bomTables) {
      const { rows: bomRows } = await query(`SELECT * FROM "${t.tablename}"`);
      const mapped = bomRows.map((r: any) => {
        const stockCode = String(r.internal_stock_number || r.stock_code || r.StockCode || '');
        const designator = String(r.ref_des || r.designator || r.Designator || '');
        return {
          id: `BOM-${t.tablename}-${stockCode}-${designator}`,
          projectId: parseInt(r.project_name || r.projectId || r.ProjectId) || 1,
          stockCode,
          comment: String(r.comment || r.Comment || ''),
          description: String(r.description || r.Description || ''),
          designator,
          footprint: String(r.footprint || r.Footprint || ''),
          libref: String(r.libref || r.LibRef || ''),
          quantity: parseInt(r.qty_per_unit || r.quantity || r.Quantity) || 1
        };
      });
      bomItems = bomItems.concat(mapped);
    }

    // 7. PP Items (pp_bom)
    const { rows: ppTables } = await query<{ tablename: string }>(`SELECT c.relname as tablename FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'pp_bom%'`);
    let ppItems: any[] = [];
    for (const t of ppTables) {
      const { rows: ppRows } = await query(`SELECT * FROM "${t.tablename}"`);
      const mapped = ppRows.map((r: any) => {
        const stockCode = String(r.stock_code || r.internal_stock_number || r.StockCode || '');
        const designator = String(r.ref_des || r.designator || r.Designator || '');
        return {
          id: `PP-${t.tablename}-${stockCode}-${designator}`,
          projectId: parseInt(r.project_name || r.projectId || r.ProjectId) || 1,
          stockCode,
          comment: String(r.comment || r.Comment || ''),
          description: String(r.description || r.Description || ''),
          designator,
          footprint: String(r.footprint || r.Footprint || ''),
          libref: String(r.libref || r.LibRef || ''),
          quantity: parseInt(r.quantity || r.qty_per_unit || r.Quantity) || 1
        };
      });
      ppItems = ppItems.concat(mapped);
    }

    // 8. Settings
    const { rows: settingsRows } = await query('SELECT * FROM settings');
    const settings: any = {};
    for (const r of settingsRows) {
      try {
        settings[r.key] = JSON.parse(r.value);
      } catch {
        settings[r.key] = r.value;
      }
    }

    // 9. Job Cards
    const { rows: jobCardsRows } = await query('SELECT * FROM job_cards ORDER BY created_at DESC');
    const jobCards = jobCardsRows.map((r: any) => ({
      id: r.id,
      projectId: r.project_id,
      buildQty: r.build_qty,
      status: r.status,
      createdAt: r.created_at,
      assignedTeam: r.assigned_team
    }));

    // 10. Customers
    // Must match GET /api/clients — see the note there. The bookkeeping UI
    // resolves client_id against this list.
    const { rows: clientsRows } = await query('SELECT * FROM clients ORDER BY id');
    const clients = clientsRows.map((row: any) => ({
      id: row.id,
      clientName: row.client_name,
      contactName: row.contact_name,
      email: row.email,
      phone: row.phone,
      address: row.address,
      vatNumber: row.vat_number,
      status: row.status,
      createdAt: row.created_at
    }));

    // 11. Client Orders
    const { rows: clientOrdersRows } = await query('SELECT * FROM client_orders ORDER BY id');
    const clientOrders = clientOrdersRows.map((row: any) => ({
      id: row.id,
      clientId: row.client_id,
      orderNumber: row.order_number,
      orderDate: row.order_date,
      requiredDate: row.required_date,
      status: row.status,
      currency: row.currency,
      subtotal: row.subtotal,
      tax: row.tax,
      total: row.total,
      notes: row.notes,
      createdAt: row.created_at
    }));

    // 12. Client Order Items
    const { rows: clientOrderItemsRows } = await query('SELECT * FROM client_order_items ORDER BY id');
    const clientOrderItems = clientOrderItemsRows.map((row: any) => ({
      id: row.id,
      clientOrderId: row.client_order_id,
      partNumber: row.part_number,
      description: row.description,
      quantity: row.quantity,
      unitPrice: row.unit_price,
      lineTotal: row.line_total,
      createdAt: row.created_at
    }));

    // 13. Build Jobs
    const { rows: buildJobsRows } = await query('SELECT * FROM build_jobs ORDER BY id');
    const buildJobs = buildJobsRows.map((row: any) => ({
      id: row.id,
      clientOrderId: row.client_order_id,
      jobNumber: row.job_number,
      status: row.status,
      buildQty: row.build_qty,
      startDate: row.start_date,
      endDate: row.end_date,
      assignedTeam: row.assigned_team,
      notes: row.notes,
      createdAt: row.created_at
    }));

    // 14. BOM Structures
    const { rows: bomStructuresRows } = await query('SELECT * FROM bom_structures ORDER BY id');
    const bomStructures = bomStructuresRows.map((row: any) => ({
      id: row.id,
      parentPartNumber: row.parent_part_number,
      childPartNumber: row.child_part_number,
      quantity: row.quantity,
      description: row.description,
      createdAt: row.created_at
    }));

    // 15. Sub Assemblies
    const { rows: subAssembliesRows } = await query('SELECT * FROM sub_assemblies ORDER BY id');
    const subAssemblies = subAssembliesRows.map((row: any) => ({
      id: row.id,
      assemblyName: row.assembly_name,
      parentPartNumber: row.parent_part_number,
      childPartNumber: row.child_part_number,
      quantity: row.quantity,
      description: row.description,
      createdAt: row.created_at
    }));

    // 16. Fielded Assets
    const { rows: fieldedAssetsRows } = await query('SELECT * FROM fielded_assets ORDER BY id');
    const fieldedAssets = fieldedAssetsRows.map((row: any) => ({
      id: row.id,
      clientId: row.client_id,
      assetTag: row.asset_tag,
      serialNumber: row.serial_number,
      installedDate: row.installed_date,
      status: row.status,
      location: row.location,
      notes: row.notes,
      createdAt: row.created_at
    }));

    // 17. Stock Ledger
    const { rows: stockLedgerRows } = await query('SELECT * FROM stock_ledger ORDER BY movement_date DESC');
    const stockLedger = stockLedgerRows.map((row: any) => ({
      id: row.id,
      itemSerialNumber: row.item_serial_number,
      movementType: row.movement_type,
      quantity: row.quantity,
      movementDate: row.movement_date,
      reference: row.reference,
      notes: row.notes,
      createdAt: row.created_at
    }));

    res.json({
      items: { items: itemsRows, total: totalItems },
      suppliers,
      projects,
      transactions,
      productionKits,
      bomItems,
      ppItems,
      settings,
      jobCards,
      clients,
      clientOrders,
      clientOrderItems,
      buildJobs,
      bomStructures,
      subAssemblies,
      fieldedAssets,
      stockLedger
    });
  } catch (err: any) {
    console.error('ERROR IN GET /api/bootstrap:', err.message);
    // Return empty data if database is unavailable, so app can still function
    res.json({
      items: { items: [], total: 0 },
      suppliers: [],
      projects: [],
      transactions: [],
      productionKits: [],
      bomItems: [],
      ppItems: [],
      settings: {},
      jobCards: [],
      clients: [],
      clientOrders: [],
      clientOrderItems: [],
      buildJobs: [],
      bomStructures: [],
      subAssemblies: [],
      fieldedAssets: [],
      stockLedger: []
    });
  }
});


// ============================================================================
// USER MANAGEMENT
// Auth (login, sessions, forgot/reset password) lives in src/lib/authRoutes.ts.
// The middlewares and constants that auth exports are re-used by the pricing
// and user-CRUD routes still in this file.
// ============================================================================

// The old in-file checkRateLimit + validateBody helpers moved with the
// endpoints that used them. Each extracted route module (authRoutes,
// docsRoutes, usersRoutes, pricingRoutes) owns its own local copy of
// validateBody so the schema lives next to the handler that enforces
// it. serverUtils still exports the shared rate-limit primitive.

app.post('/api/activity-log', async (req, res) => {
  try {
    const { userEmail, action, entityType, entityId, details, status } = req.body;

    // Detect real client IP from proxy headers (try multiple common headers)
    let ipAddress = '';
    const xForwardedFor = req.headers['x-forwarded-for'] as string;
    const cfConnectingIp = req.headers['cf-connecting-ip'] as string;
    const xRealIp = req.headers['x-real-ip'] as string;

    if (xForwardedFor) {
      ipAddress = xForwardedFor.split(',')[0].trim();
    } else if (cfConnectingIp) {
      ipAddress = cfConnectingIp.trim();
    } else if (xRealIp) {
      ipAddress = xRealIp.trim();
    } else {
      ipAddress = (req.socket.remoteAddress || '').split(':').pop() || '';
    }

    const userAgent = req.headers['user-agent'] || '';

    if (!userEmail || !action) {
      return res.status(400).json({ error: 'userEmail and action are required' });
    }

    const logResult = await query(
      `INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, ip_address, user_agent, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at`,
      [userEmail, action, entityType || null, entityId || null, JSON.stringify(details || {}), ipAddress, userAgent, status || 'SUCCESS']
    );

    res.json({ success: true, logId: logResult.rows[0].id });
  } catch (err) {
    console.error('Activity log error:', err);
    res.status(500).json({ error: 'Failed to log activity' });
  }
});

app.get('/api/activity-logs', async (req, res) => {
  try {
    const { userEmail, action, limit = '100', offset = '0' } = req.query;
    let sql = 'SELECT * FROM user_activity_logs WHERE 1=1';
    const params: any[] = [];

    if (userEmail) {
      sql += ` AND user_email = $${params.length + 1}`;
      params.push(userEmail);
    }
    if (action) {
      sql += ` AND action = $${params.length + 1}`;
      params.push(action);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit as string) || 100, parseInt(offset as string) || 0);

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching activity logs:', err);
    res.status(500).json({ error: 'Failed to fetch activity logs' });
  }
});

// Projects surface (projects CRUD + restore, per-project BOM/P&P
// tables, job-cards, aggregated bom-items/pp-items) lives in
// src/lib/projectsRoutes.ts.


app.get('/api/transactions', async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const offset = parseInt(req.query.offset as string) || 0;

  if (isNaN(limit) || isNaN(offset)) {
    return res.status(400).json({ error: 'Invalid limit or offset' });
  }

  try {
    const { rows } = await query('SELECT * FROM transactions ORDER BY id DESC LIMIT $1 OFFSET $2', [limit, offset]);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/transactions', async (req, res) => {
  const trx = req.body;
  const sqlText = `INSERT INTO transactions (trxId, itemPartNumber, itemName, type, qtyChange, reference, performedBy, performedByAvatar, dateTime, newCost)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;
  try {
    await query(sqlText, [trx.trxId, trx.itemPartNumber, trx.itemName, trx.type, trx.qtyChange, trx.reference, trx.performedBy, trx.performedByAvatar, trx.dateTime, trx.newCost]);
    res.status(201).json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// production_kits GET/POST live in productionRoutes.ts.

app.get('/api/settings', async (_req, res) => {
  const { rows } = await query('SELECT * FROM settings');
  const settings: any = {};
  for (const r of rows) {
    try {
      settings[r.key] = JSON.parse(r.value);
    } catch {
      settings[r.key] = r.value;
    }
  }
  res.json(settings);
});

app.post('/api/settings', async (req, res) => {
  const settings = req.body;
  const upsert = async (data: any) => {
    const stmt = `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`;
    for (const key in data) {
      await query(stmt, [key, JSON.stringify(data[key])]);
    }
  };
  try {
    await upsert(settings);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Clients surface (/api/clients, /api/client-orders,
// /api/client-order-items) lives in src/lib/clientsRoutes.ts.


// Build-jobs, production-jobs, work-orders, job-allocations, qc-checkpoints,
// production-defects, order-fulfillment, and production-metrics live in
// src/lib/productionRoutes.ts.


// PHASE 4 automation surface (rules, scheduled jobs, notifications,
// auto-PO config, event log, alert subscriptions, trigger-auto-po,
// send-alert, enrich-missing-suppliers) lives in src/lib/automationRoutes.ts.


// Inventory-metadata surface (/api/bom-structures + /api/stock-ledger)
// lives in src/lib/inventoryMetadataRoutes.ts.
// Assets surface (/api/sub-assemblies, /api/fielded-assets) lives in
// src/lib/assetsRoutes.ts.



app.get('/api/raw-table/:name', async (req, res) => {
  const name = req.params.name;
  const { rows: tables } = await query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  const tableNames = tables.map((r: { tablename: string }) => r.tablename);
  if (!tableNames.includes(name)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }

  try {
    const { rows } = await query(`SELECT * FROM "${name}" LIMIT 1000`);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tables', async (_req, res) => {
  const { rows } = await query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  res.json(rows.map((r: { tablename: string }) => r.tablename));
});

app.post('/api/start', (_req, res) => {
  try {
    const child = spawn('node', ['--import', 'tsx/esm', 'server.ts'], {
      cwd: process.cwd(),
      stdio: 'ignore',
      shell: false,
      detached: true,
    });
    child.unref();
    res.json({ ok: true, pid: child.pid });
  } catch (err) {
    console.error('Failed to start server:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// auditKitStock and /api/kit-booking/{validate,execute} live in
// src/lib/productionRoutes.ts.

app.post('/api/shortages/convert-to-po', async (req, res) => {
  const { shortages, supplierId, supplierName } = req.body;
  if (!shortages || !Array.isArray(shortages) || shortages.length === 0) {
    return res.status(400).json({ error: 'shortages array is required' });
  }
  if (!supplierId && !supplierName) {
    return res.status(400).json({ error: 'supplierId or supplierName is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get or create supplier
    let sId: number | null = null;
    if (supplierId) {
      sId = Number(supplierId);
    } else if (supplierName) {
      const existing = await queryOne(`SELECT id FROM suppliers WHERE name = $1`, [supplierName]);
      if (existing) {
        sId = existing.id;
      } else {
        const newSupplier = await queryOne(`INSERT INTO suppliers (name, contact_name, email, phone, address, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [supplierName, '', '', '', '', 'ACTIVE']);
        sId = newSupplier.id;
      }
    }

    // Create PO with items from shortages
    const poNumber = await nextDocNumber(client, 'PO', 'po_seq');
    const orderDate = new Date().toISOString().slice(0, 10);

    // Transform shortages into line items (use shortage_qty as quantity)
    const items = shortages.map((s: any) => ({
      partNumber: s.resolved_part_number || s.component_id,
      description: s.description || s.comment || '',
      quantity: Math.ceil(s.shortage_qty || 0),
      unitPrice: 0, // Will be filled in from supplier pricing if available
    }));

    // Calculate totals
    const subtotal = 0; // User will fill in actual pricing
    const taxTotal = 0;
    const total = 0;

    const poRes = await client.query(
      `INSERT INTO purchase_orders (po_number, supplier_id, order_date, status, currency, subtotal, tax_total, total, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [poNumber, sId || null, orderDate, 'DRAFT', 'ZAR', subtotal, taxTotal, total, `Generated from shortage detection`]
    );
    const poId = poRes.rows[0].id;

    // Insert PO items
    for (const item of items) {
      await client.query(
        `INSERT INTO purchase_order_items (purchase_order_id, part_number, description, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [poId, item.partNumber, item.description, item.quantity, item.unitPrice]
      );
    }

    await client.query('COMMIT');
    const poRow = await queryOne(`SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`, [poId]);
    const poItems = await query(`SELECT * FROM purchase_order_items WHERE purchase_order_id = $1`, [poId]);

    res.status(201).json({
      po: mapPurchaseOrder(poRow),
      items: poItems.rows.map(mapPurchaseOrderItem),
      message: `PO ${poNumber} created with ${items.length} items`
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});


// Serve index.html for all non-API routes (client-side routing)
app.get('*', (_req, res) => {
  const indexPath = path.join(DIST_DIR, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error('Error serving index.html:', err.message);
      res.status(500).send('Error loading page');
    }
  });
});

// Sentry's error handler must sit AFTER every route so it catches whatever
// they throw. A no-op when SENTRY_DSN is unset.
attachErrorHandler(app);

async function runSchemaBootstrap() {
  await ensureSchema();
    // NOTE: these were previously fire-and-forget (no `await`), which raced across the
    // connection pool with no guaranteed order — risky for FK-dependent tables (e.g.
    // client_orders references clients) on a brand-new database. Now sequenced properly.
    await exec(`CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      trxId TEXT UNIQUE,
      itemPartNumber TEXT,
      itemName TEXT,
      type TEXT,
      qtyChange INTEGER,
      reference TEXT,
      performedBy TEXT,
      performedByAvatar TEXT,
      dateTime TEXT,
      newCost REAL
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS production_kits (
      kitId TEXT PRIMARY KEY,
      skuReference TEXT,
      status TEXT,
      qtyAvailable INTEGER,
      assemblyLine TEXT,
      lastUpdated TEXT,
      projectId INTEGER
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      role TEXT DEFAULT 'VIEWER',
      status TEXT DEFAULT 'ACTIVE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP
    )`).catch(() => {});

    // Migrate: Add missing columns if they don't exist
    await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT NOT NULL DEFAULT 'migrate_required'`).catch(() => {});
    await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT`).catch(() => {});
    await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT`).catch(() => {});
    await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ACTIVE'`).catch(() => {});
    await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`).catch(() => {});
    await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`).catch(() => {});
    await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP`).catch(() => {});
    // One row per active login. A new login for the same email deletes prior
    // rows, so any older device polling /api/session/verify gets kicked out.
    await exec(`CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      user_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      user_agent TEXT,
      ip_address TEXT
    )`).catch(() => {});
    await exec(`CREATE INDEX IF NOT EXISTS user_sessions_email_idx ON user_sessions (user_email)`).catch(() => {});
    // Password reset tokens. Bcrypt-hashed at rest (like the passwords they
    // reset) so a DB read alone can't be turned into an account takeover.
    // One row per issued token; expired/used rows stay for audit.
    await exec(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id SERIAL PRIMARY KEY,
      token_hash TEXT NOT NULL,
      user_email TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      ip_address TEXT
    )`).catch(() => {});
    await exec(`CREATE INDEX IF NOT EXISTS password_reset_tokens_email_idx ON password_reset_tokens (user_email)`).catch(() => {});
    // Documentation registry — a simple list of links, not a CMS. Each row
    // is one clickable doc: title + description + URL that opens in a new
    // tab. Admin-only mutations, everyone can read.
    await exec(`CREATE TABLE IF NOT EXISTS app_docs (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      url TEXT NOT NULL,
      sort_order INTEGER DEFAULT 100,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT
    )`).catch(() => {});
    // Additive migration for older shape from the earlier markdown-editor
    // version: keep the row, drop unused columns lazily.
    await exec(`ALTER TABLE app_docs ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''`).catch(() => {});
    await exec(`ALTER TABLE app_docs ADD COLUMN IF NOT EXISTS url TEXT`).catch(() => {});
    await exec(`ALTER TABLE app_docs ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 100`).catch(() => {});
    await exec(`ALTER TABLE app_docs ADD COLUMN IF NOT EXISTS updated_by TEXT`).catch(() => {});
    // Drop constraints/columns from the earlier CMS shape (slug, content,
    // category were NOT NULL there and would block every INSERT here).
    // DROP COLUMN cascades to any unique index tied to it.
    await exec(`ALTER TABLE app_docs DROP COLUMN IF EXISTS slug`).catch(() => {});
    await exec(`ALTER TABLE app_docs DROP COLUMN IF EXISTS content`).catch(() => {});
    await exec(`ALTER TABLE app_docs DROP COLUMN IF EXISTS category`).catch(() => {});
    // Optional binary attachment (PDFs, images, spreadsheets). Stored as
    // base64 in a text column — Postgres compresses TOAST well and this
    // avoids provisioning a Fly Volume. Cap enforced at the upload
    // endpoint so the table stays healthy.
    await exec(`ALTER TABLE app_docs ADD COLUMN IF NOT EXISTS file_name TEXT`).catch(() => {});
    await exec(`ALTER TABLE app_docs ADD COLUMN IF NOT EXISTS file_mime TEXT`).catch(() => {});
    await exec(`ALTER TABLE app_docs ADD COLUMN IF NOT EXISTS file_data TEXT`).catch(() => {});
    // Seed the built-in "Complete User Guide" link if nothing exists yet, so
    // a fresh install has something to show before the admin adds their own.
    await exec(`INSERT INTO app_docs (title, description, url, sort_order, updated_by)
      SELECT 'Complete User Guide', 'Master the ERP from setup to advanced automation', '/tracklab-complete-guide.html', 1, 'seed'
       WHERE NOT EXISTS (SELECT 1 FROM app_docs)`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS role_permissions (
      id SERIAL PRIMARY KEY,
      role TEXT NOT NULL,
      permission TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(role, permission)
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      client_name TEXT NOT NULL,
      contact_name TEXT,
      email TEXT,
      phone TEXT,
      address TEXT,
      vat_number TEXT,
      status TEXT DEFAULT 'ACTIVE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS client_orders (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      order_number TEXT UNIQUE NOT NULL,
      order_date DATE NOT NULL DEFAULT CURRENT_DATE,
      required_date DATE,
      status TEXT DEFAULT 'DRAFT',
      currency TEXT DEFAULT 'ZAR',
      subtotal NUMERIC(12,2) DEFAULT 0,
      tax NUMERIC(12,2) DEFAULT 0,
      total NUMERIC(12,2) DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS client_order_items (
      id SERIAL PRIMARY KEY,
      client_order_id INTEGER REFERENCES client_orders(id) ON DELETE CASCADE,
      part_number TEXT,
      description TEXT NOT NULL,
      quantity NUMERIC(10,2) DEFAULT 1,
      unit_price NUMERIC(12,2) DEFAULT 0,
      line_total NUMERIC(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS build_jobs (
      id SERIAL PRIMARY KEY,
      client_order_id INTEGER REFERENCES client_orders(id) ON DELETE SET NULL,
      job_number TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'PLANNED',
      build_qty INTEGER DEFAULT 1,
      start_date DATE,
      end_date DATE,
      assigned_team TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS bom_structures (
      id SERIAL PRIMARY KEY,
      parent_part_number TEXT NOT NULL,
      child_part_number TEXT NOT NULL,
      quantity NUMERIC(10,2) DEFAULT 1,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS sub_assemblies (
      id SERIAL PRIMARY KEY,
      assembly_name TEXT NOT NULL,
      parent_part_number TEXT,
      child_part_number TEXT,
      quantity NUMERIC(10,2) DEFAULT 1,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS fielded_assets (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      asset_tag TEXT UNIQUE,
      serial_number TEXT,
      installed_date DATE,
      status TEXT DEFAULT 'ACTIVE',
      location TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS stock_ledger (
      id SERIAL PRIMARY KEY,
      item_serial_number TEXT,
      movement_type TEXT NOT NULL,
      quantity NUMERIC(10,2) DEFAULT 0,
      movement_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      reference TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS job_cards (
      id SERIAL PRIMARY KEY,
      project_id INTEGER,
      build_qty INTEGER,
      status TEXT,
      created_at TEXT
    )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS alternative_components (
       id SERIAL PRIMARY KEY,
       primary_part_number TEXT,
       alternative_part_number TEXT
     )`).catch(() => {});
    await exec(`CREATE TABLE IF NOT EXISTS user_activity_logs (
      id SERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      details JSONB,
      ip_address TEXT,
      user_agent TEXT,
      status TEXT DEFAULT 'SUCCESS',
      error_message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE SET NULL
    )`).catch(() => {});
    await exec(`CREATE INDEX IF NOT EXISTS idx_activity_logs_user_email ON user_activity_logs(user_email)`).catch(() => {});
    await exec(`CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON user_activity_logs(created_at)`).catch(() => {});
    await exec(`CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON user_activity_logs(action)`).catch(() => {});
    await exec(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS lead_time INTEGER`).catch(() => {});
    await exec(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS response_time INTEGER`).catch(() => {});
    await exec(`ALTER TABLE production_kits ADD COLUMN IF NOT EXISTS projectId INTEGER`).catch(() => {});
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS projects_project_name_key ON projects(project_name)`).catch(() => {});
    await exec(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS start_date TEXT`).catch(() => {});
    await exec(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS end_date TEXT`).catch(() => {});
    await exec(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS assigned_team TEXT`).catch(() => {});
    await exec(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS design_specs TEXT`).catch(() => {});
    await exec(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS assigned_team TEXT`).catch(() => {});

    // Bookkeeping / ERP schema — runs after clients & client_orders exist, since invoices
    // and other new tables carry FK references to them.
    await ensureBookkeepingSchema().catch((e) => console.error('Failed to bootstrap bookkeeping schema:', e));

    await ensureProductionCostsSchema().catch((e) => console.error('Failed to bootstrap production costs schema:', e));

    // Phase 5: Quality & Compliance + Advanced Automation
    await ensurePhase5Tables().catch((e) => console.error('Failed to bootstrap Phase 5 schema:', e));

    // Seed the primary admin account if none exists. Password is bcrypt-hashed;
    // in production, override via SEED_ADMIN_PASSWORD env var so nothing
    // guessable ships. Falls back to a randomly-generated one logged to the
    // console — that value is only useful on first-boot and vanishes on restart.
    try {
      const seedEmail = (process.env.SEED_ADMIN_EMAIL || 'dedw13@gmail.com').toLowerCase().trim();
      const existing = await queryOne(`SELECT id FROM users WHERE email = $1`, [seedEmail]);
      if (!existing) {
        const seedPassword = process.env.SEED_ADMIN_PASSWORD || randomBytes(12).toString('hex');
        const hashed = await bcrypt.hash(seedPassword, BCRYPT_ROUNDS);
        await query(
          `INSERT INTO users (email, first_name, last_name, role, status, password) VALUES ($1, 'Admin', 'User', 'admin', 'ACTIVE', $2)`,
          [seedEmail, hashed]
        );
        if (!process.env.SEED_ADMIN_PASSWORD) {
          console.log(`[seed] Admin account created for ${seedEmail} — one-time password: ${seedPassword}`);
          console.log('[seed] Log in and change it, or set SEED_ADMIN_PASSWORD in your environment before first boot.');
        } else {
          console.log(`[seed] Admin account created for ${seedEmail} using SEED_ADMIN_PASSWORD`);
        }
      }
    } catch (e) {
      console.error('Error seeding admin user:', (e as any).message);
    }

    console.log('Database bootstrapping complete.');
}


async function bootstrap() {
  const PORT = parseInt(process.env.PORT || '3001', 10);

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Tracklab API listening on http://localhost:${PORT}`);
  });

  // Schedule exchange rate update every day at 06:00 (UTC)
  cron.schedule('0 6 * * *', () => {
    console.log('[CRON] Updating exchange rate at 06:00...');
    updateExchangeRate();
  });

  // Also update on startup
  await updateExchangeRate();

  // Neon serverless databases sleep when idle and can take several seconds to wake, so the
  // first connection often times out. Retry the (idempotent) schema bootstrap with backoff,
  // and — crucially — DO NOT exit the process if it ultimately fails: on an already-provisioned
  // database the API can serve fine without a successful bootstrap pass, and the pg pool will
  // reconnect on the next request. Killing the server on a transient DB hiccup takes the whole
  // app down until a manual restart, which is worse than serving with a stale-but-present schema.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await runSchemaBootstrap();
      break;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        console.error(`Database bootstrap failed after ${MAX_ATTEMPTS} attempts — continuing to serve; schema will be retried lazily on demand.`, err);
      } else {
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
        console.warn(`Database bootstrap attempt ${attempt} failed (${(err as Error).message}). Retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }

  return server;
}

bootstrap();

process.on('SIGINT', async () => {
  await close();
  process.exit(0);
});
