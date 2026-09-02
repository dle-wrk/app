import { initSentry, requestIdMiddleware, attachErrorHandler } from './src/lib/sentryServer';
// Init Sentry BEFORE the express import so its auto-instrumentation can hook
// the module. No-ops if SENTRY_DSN isn't set — safe to leave unconfigured.
initSentry();

import express from 'express';
import compression from 'compression';
import { z } from 'zod';
import { spawn } from 'child_process';
import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { checkRateLimit as _checkRateLimit } from './src/lib/serverUtils';
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
app.use((req, res, next) => {
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

// General-purpose in-memory rate limiter for non-auth routes. Auth has its own
// bucket map inside authRoutes to keep quota domains isolated.
const rateBuckets = new Map<string, number[]>();
const checkRateLimit = (key: string, max: number, windowMs: number) =>
  _checkRateLimit(rateBuckets, key, max, windowMs);

// Zod validation middleware factory. Any endpoint that reads req.body should
// go through one of these so a bad payload returns a clean 400 with the
// field list instead of crashing the handler with a cryptic pg error.
// After validation req.body is the *parsed* value — coerced, defaults filled.
function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return (req: any, res: any, next: any) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        details: parsed.error.flatten(),
      });
    }
    req.body = parsed.data;
    next();
  };
}

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

app.get('/api/projects', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM projects ORDER BY id');
    const mapped = rows.map((r: any) => ({
      id: parseInt(r.id) || 0,
      projectName: r.project_name,
      description: r.description,
      status: r.status,
      createdDate: r.created_date,
      startDate: r.start_date,
      endDate: r.end_date,
      assignedTeam: r.assigned_team,
      designSpecs: r.design_specs
    }));
    res.json(mapped);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', async (req, res) => {
  const { projectName, description, status, createdDate, startDate, endDate, assignedTeam, designSpecs } = req.body;
  if (!projectName) return res.status(400).json({ error: 'projectName is required' });
  
  try {
    // First try to find existing project with same name
    const existing = await queryOne(`SELECT * FROM projects WHERE project_name = $1`, [projectName]);
    let row;
    let isNew = false;
    
    if (existing) {
      // Update existing
      await query(`UPDATE projects SET description = $1, status = $2, start_date = $3, end_date = $4, assigned_team = $5, design_specs = $6 WHERE project_name = $7`,
        [description || '', status || 'Active', startDate || null, endDate || null, assignedTeam || '', designSpecs || '', projectName]);
      row = existing;
    } else {
      // Insert new - generate sequential id
      const maxId = await queryOne(`SELECT COALESCE(MAX(id::integer), 0) + 1 as next_id FROM projects`, []);
      const nextId = maxId?.next_id || 1;
      await query(`INSERT INTO projects (id, project_name, description, status, created_date, start_date, end_date, assigned_team, design_specs) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [nextId, projectName, description || '', status || 'Active', createdDate || new Date().toISOString().split('T')[0], startDate || null, endDate || null, assignedTeam || '', designSpecs || '']);
      row = {
        id: nextId,
        project_name: projectName,
        description: description || '',
        status: status || 'Active',
        created_date: createdDate || new Date().toISOString().split('T')[0],
        start_date: startDate || null,
        end_date: endDate || null,
        assigned_team: assignedTeam || '',
        design_specs: designSpecs || ''
      };
      isNew = true;
    }
    
    const mapped = {
      id: parseInt(row?.id || '0'),
      projectName: row?.project_name,
      description: row?.description,
      status: row?.status,
      createdDate: row?.created_date,
      startDate: row?.start_date,
      endDate: row?.end_date,
      assignedTeam: row?.assigned_team,
      designSpecs: row?.design_specs
    };
    res.status(isNew ? 201 : 200).json(mapped);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/projects/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { projectName, description, status, startDate, endDate, assignedTeam, designSpecs } = req.body;
  const sqlText = `UPDATE projects SET project_name = $1, description = $2, status = $3, start_date = $4, end_date = $5, assigned_team = $6, design_specs = $7 WHERE id = $8`;
  try {
    const { rowCount } = await query(sqlText, [projectName, description, status, startDate, endDate, assignedTeam, designSpecs, id]);
    if (rowCount === 0) return res.status(404).json({ error: 'project not found' });
    const row = await queryOne(`SELECT * FROM projects WHERE id = $1`, [id]);
    const mapped = {
      id: parseInt(row?.id || '0'),
      projectName: row?.project_name,
      description: row?.description,
      status: row?.status,
      createdDate: row?.created_date,
      startDate: row?.start_date,
      endDate: row?.end_date,
      assignedTeam: row?.assigned_team,
      designSpecs: row?.design_specs
    };
    res.json(mapped);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query(`DELETE FROM projects WHERE id = $1`, [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'project not found' });
    // Cascade: drop this project's BOM/P&P tables and job cards. Ids are allocated
    // as MAX(id)+1, so a freed id gets reused — orphaned data would silently attach
    // itself to the next project created with the same id.
    await exec(`DROP TABLE IF EXISTS "db_bom_project_${id}"`).catch(() => {});
    await exec(`DROP TABLE IF EXISTS "pp_bom_project_${id}"`).catch(() => {});
    await query(`DELETE FROM job_cards WHERE project_id = $1`, [id]).catch(() => {});
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/restore/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const projectData = req.body;
  console.log(`[RESTORE PROJECT] request to restore project: ${id}`);

  try {
    if (!projectData || typeof projectData !== 'object') {
      return res.status(400).json({ error: 'Invalid project data for restore' });
    }

    // The snapshot is the frontend Project shape logged at delete time:
    // { id, projectName, description, status, createdDate, startDate, endDate, assignedTeam, designSpecs }
    const {
      projectName,
      description,
      status,
      createdDate,
      startDate,
      endDate,
      assignedTeam,
      designSpecs
    } = projectData;

    const sqlText = `
      INSERT INTO projects (id, project_name, description, status, created_date, start_date, end_date, assigned_team, design_specs)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        project_name = EXCLUDED.project_name,
        description = EXCLUDED.description,
        status = EXCLUDED.status,
        created_date = EXCLUDED.created_date,
        start_date = EXCLUDED.start_date,
        end_date = EXCLUDED.end_date,
        assigned_team = EXCLUDED.assigned_team,
        design_specs = EXCLUDED.design_specs
    `;

    const { rowCount } = await query(sqlText, [
      id,
      projectName || 'Untitled Project',
      description || '',
      status || 'Active',
      createdDate || new Date().toISOString().split('T')[0],
      startDate || null,
      endDate || null,
      assignedTeam || '',
      designSpecs || ''
    ]);

    if (rowCount === 0) {
      console.warn(`[RESTORE PROJECT] failed to restore project: ${id}`);
      return res.status(500).json({ error: 'Failed to restore project' });
    }

    const row = await queryOne(`SELECT * FROM projects WHERE id = $1`, [id]);
    console.log(`[RESTORE PROJECT] successfully restored project: ${id}`);
    res.json({ success: true, message: `Project ${id} restored successfully`, project: row });
  } catch (err: any) {
    console.error(`[RESTORE PROJECT] ERROR restoring project:`, err.message);
    res.status(500).json({ error: 'Failed to restore project', details: err.message });
  }
});

app.get('/api/projects/:id/bom', async (req, res) => {
  const projectId = parseInt(req.params.id);
  try {
    const { rows } = await query(`SELECT * FROM "db_bom_project_${projectId}"`);
    const mapped = rows.map((r: any) => ({
      stockCode: String(r.internal_stock_number || ''),
      quantity: parseInt(r.qty_per_unit || '0') || 1,
      designator: String(r.ref_des || ''),
      description: String(r.description || ''),
      comment: String(r.comment || ''),
      footprint: String(r.footprint || ''),
      libref: String(r.libref || '')
    }));
    res.json(mapped);
  } catch (err: any) {
    if (err.code === '42P01') {
      return res.json([]);
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:id/bom', async (req, res) => {
  const projectId = parseInt(req.params.id);
  const { items } = req.body; // items: [{ stockCode: string, quantity: number, designator: string }]
  console.log(`[POST BOM] req received for project ${projectId}, items count: ${items ? items.length : 0}`);
  
  try {
    const tableName = `db_bom_project_${projectId}`;
    console.log(`[POST BOM] creating table if not exists "${tableName}"...`);
    await query(`CREATE TABLE IF NOT EXISTS "${tableName}" (
      project_name INTEGER,
      internal_stock_number TEXT PRIMARY KEY,
      qty_per_unit INTEGER,
      ref_des TEXT
    )`);
    console.log(`[POST BOM] table "${tableName}" created/checked successfully.`);

    // Ensure extra columns exist for both new and legacy tables
    const extraColumns = [
      { name: 'description', type: 'TEXT DEFAULT \'\'' },
      { name: 'comment', type: 'TEXT DEFAULT \'\'' },
      { name: 'footprint', type: 'TEXT DEFAULT \'\'' },
      { name: 'libref', type: 'TEXT DEFAULT \'\'' }
    ];

    for (const col of extraColumns) {
      console.log(`[POST BOM] ensuring column "${col.name}" exists on "${tableName}"...`);
      await query(`ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
    }
    console.log(`[POST BOM] all extra columns checked.`);
    
    for (const item of items) {
      console.log(`[POST BOM] inserting/updating item ${item.stockCode} in "${tableName}"...`);
      await query(`INSERT INTO "${tableName}" (project_name, internal_stock_number, qty_per_unit, ref_des, description, comment, footprint, libref) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT(internal_stock_number) DO UPDATE SET
                   qty_per_unit = EXCLUDED.qty_per_unit,
                   ref_des = EXCLUDED.ref_des,
                   description = EXCLUDED.description,
                   comment = EXCLUDED.comment,
                   footprint = EXCLUDED.footprint,
                   libref = EXCLUDED.libref`,
        [projectId, item.stockCode, item.quantity, item.designator || '', item.description || '', item.comment || '', item.footprint || '', item.libref || '']);
    }
    console.log(`[POST BOM] items upsert complete.`);

    // Synchronize CAD with Manufacturing: Reset associated production kits to STAGING
    console.log(`[POST BOM] updating production_kits...`);
    await query(`UPDATE production_kits SET status = 'STAGING', lastUpdated = $1 WHERE projectId = $2`,
      [new Date().toISOString().split('T')[0], projectId]);
    console.log(`[POST BOM] production_kits updated successfully.`);

    res.json({ ok: true });
  } catch (err: any) {
    console.error('ERROR IN POST /api/projects/:id/bom:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:id/pp', async (req, res) => {
  const projectId = parseInt(req.params.id);
  const { items } = req.body;
  
  try {
    const tableName = `pp_bom_project_${projectId}`;
    await query(`CREATE TABLE IF NOT EXISTS "${tableName}" (
      project_name INTEGER,
      stock_code TEXT PRIMARY KEY,
      quantity INTEGER
    )`).catch(() => {});

    const ppExtraColumns = [
      { name: 'comment', type: 'TEXT DEFAULT \'\'' },
      { name: 'description', type: 'TEXT DEFAULT \'\'' },
      { name: 'designator', type: 'TEXT DEFAULT \'\'' },
      { name: 'footprint', type: 'TEXT DEFAULT \'\'' },
      { name: 'libref', type: 'TEXT DEFAULT \'\'' }
    ];

    for (const col of ppExtraColumns) {
      await query(`ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`).catch(() => {});
    }
    
    for (const item of items) {
      await query(`INSERT INTO "${tableName}" (project_name, stock_code, comment, description, designator, footprint, libref, quantity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT(stock_code) DO UPDATE SET
                   comment = EXCLUDED.comment,
                   description = EXCLUDED.description,
                   designator = EXCLUDED.designator,
                   footprint = EXCLUDED.footprint,
                   libref = EXCLUDED.libref,
                   quantity = EXCLUDED.quantity`,
        [projectId, item.stockCode, item.comment || '', item.description || '', item.designator || '', item.footprint || '', item.libref || '', item.quantity]);
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/job-cards', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM job_cards ORDER BY created_at DESC');
    const mapped = rows.map((r: any) => ({
      id: r.id,
      projectId: r.project_id,
      buildQty: r.build_qty,
      status: r.status,
      createdAt: r.created_at,
      assignedTeam: r.assigned_team
    }));
    res.json(mapped);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/job-cards', async (req, res) => {
  const { projectId, buildQty, status } = req.body;
  const sqlText = `INSERT INTO job_cards (project_id, build_qty, status, created_at) VALUES ($1, $2, $3, $4)`;
  try {
    await query(sqlText, [projectId, buildQty || 0, status || 'Pending', new Date().toISOString()]);
    res.status(201).json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bom-items', async (_req, res) => {
  try {
    const { rows: tables } = await query<{ tablename: string }>(`SELECT c.relname as tablename FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'db_bom%'`);
    let allItems: any[] = [];
    for (const t of tables) {
      const { rows } = await query(`SELECT * FROM "${t.tablename}"`);
      const mapped = rows.map((r: any) => {
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
      allItems = allItems.concat(mapped);
    }
    res.json(allItems);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pp-items', async (_req, res) => {
  try {
    const { rows: tables } = await query<{ tablename: string }>(`SELECT c.relname as tablename FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'pp_bom%'`);
    let allItems: any[] = [];
    for (const t of tables) {
      const { rows } = await query(`SELECT * FROM "${t.tablename}"`);
      const mapped = rows.map((r: any, idx: number) => {
        const stockCode = String(r.stock_code || r.internal_stock_number || r.StockCode || '');
        return {
          id: `PP-${t.tablename}-${idx}`,
          projectId: parseInt(r.project_name || r.projectId || r.ProjectId) || 1,
          stockCode,
          comment: String(r.comment || r.Comment || ''),
          description: String(r.description || r.Description || ''),
          designator: String(r.designator || r.ref_des || r.Designator || ''),
          footprint: String(r.footprint || r.Footprint || ''),
          libref: String(r.libref || r.LibRef || ''),
          quantity: parseInt(r.quantity || r.qty_per_unit || r.Quantity) || 1
        };
      });
      allItems = allItems.concat(mapped);
    }
    res.json(allItems);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

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

app.get('/api/clients', async (_req, res) => {
  try {
    // Read the `clients` table, not `customers`: every bookkeeping foreign key
    // (invoices.client_id, payments_received.client_id, dispatch_notes.client_id)
    // points at `clients`. Serving `customers` here meant a note pointing at
    // clients.id = 5 could not be resolved and rendered as "Unassigned".
    const { rows } = await query('SELECT * FROM clients ORDER BY id');
    res.json(rows.map((row: any) => ({
      id: row.id,
      clientName: row.client_name,
      contactName: row.contact_name,
      email: row.email,
      phone: row.phone,
      address: row.address,
      vatNumber: row.vat_number,
      status: row.status,
      createdAt: row.created_at
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients', async (req, res) => {
  const { clientName, contactName, email, phone, address, vatNumber, status } = req.body;
  if (!clientName) return res.status(400).json({ error: 'clientName is required' });

  try {
    // Writes must target the same table the reads and foreign keys use, or a
    // newly created client would not appear in the list and could not be
    // referenced by an invoice or dispatch note.
    const row = await queryOne(`INSERT INTO clients (client_name, contact_name, email, phone, address, vat_number, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [clientName, contactName || null, email || null, phone || null, address || null, vatNumber || null, status || 'ACTIVE']);
    res.status(201).json({
      id: row?.id,
      clientName: row?.client_name,
      contactName: row?.contact_name,
      email: row?.email,
      phone: row?.phone,
      address: row?.address,
      vatNumber: row?.vat_number,
      status: row?.status,
      createdAt: row?.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/clients/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { clientName, contactName, email, phone, address, vatNumber, status } = req.body;
  try {
    const row = await queryOne(`UPDATE clients SET
      client_name = COALESCE($1, client_name),
      contact_name = COALESCE($2, contact_name),
      email = COALESCE($3, email),
      phone = COALESCE($4, phone),
      address = COALESCE($5, address),
      vat_number = COALESCE($6, vat_number),
      status = COALESCE($7, status)
      WHERE id = $8 RETURNING *`,
      [clientName ?? null, contactName ?? null, email ?? null, phone ?? null, address ?? null, vatNumber ?? null, status ?? null, id]);
    if (!row) return res.status(404).json({ error: 'client not found' });
    res.json({
      id: row.id,
      clientName: row.client_name,
      contactName: row.contact_name,
      email: row.email,
      phone: row.phone,
      address: row.address,
      vatNumber: row.vat_number,
      status: row.status,
      createdAt: row.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/clients/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query('DELETE FROM clients WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'client not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/client-orders', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM client_orders ORDER BY id');
    res.json(rows.map((row: any) => ({
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
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/client-orders', async (req, res) => {
  const { clientId, orderNumber, orderDate, requiredDate, status, currency, subtotal, tax, total, notes } = req.body;
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber is required' });

  try {
    const row = await queryOne(`INSERT INTO client_orders (client_id, order_number, order_date, required_date, status, currency, subtotal, tax, total, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [clientId || null, orderNumber, orderDate || null, requiredDate || null, status || 'DRAFT', currency || 'ZAR', subtotal || 0, tax || 0, total || 0, notes || null]);
    res.status(201).json({
      id: row?.id,
      clientId: row?.client_id,
      orderNumber: row?.order_number,
      orderDate: row?.order_date,
      requiredDate: row?.required_date,
      status: row?.status,
      currency: row?.currency,
      subtotal: row?.subtotal,
      tax: row?.tax,
      total: row?.total,
      notes: row?.notes,
      createdAt: row?.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/client-orders/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { clientId, orderNumber, orderDate, requiredDate, status, currency, subtotal, tax, total, notes } = req.body;
  try {
    const row = await queryOne(`UPDATE client_orders SET
      client_id = COALESCE($1, client_id),
      order_number = COALESCE($2, order_number),
      order_date = COALESCE($3, order_date),
      required_date = COALESCE($4, required_date),
      status = COALESCE($5, status),
      currency = COALESCE($6, currency),
      subtotal = COALESCE($7, subtotal),
      tax = COALESCE($8, tax),
      total = COALESCE($9, total),
      notes = COALESCE($10, notes)
      WHERE id = $11 RETURNING *`,
      [clientId ?? null, orderNumber ?? null, orderDate ?? null, requiredDate ?? null, status ?? null, currency ?? null, subtotal ?? null, tax ?? null, total ?? null, notes ?? null, id]);
    if (!row) return res.status(404).json({ error: 'client order not found' });
    res.json({
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
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/client-orders/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query('DELETE FROM client_orders WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'client order not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/client-order-items', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM client_order_items ORDER BY id');
    res.json(rows.map((row: any) => ({
      id: row.id,
      clientOrderId: row.client_order_id,
      partNumber: row.part_number,
      description: row.description,
      quantity: row.quantity,
      unitPrice: row.unit_price,
      lineTotal: row.line_total,
      createdAt: row.created_at
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/client-order-items', async (req, res) => {
  const { clientOrderId, partNumber, description, quantity, unitPrice, lineTotal } = req.body;
  if (!description) return res.status(400).json({ error: 'description is required' });

  try {
    const row = await queryOne(`INSERT INTO client_order_items (client_order_id, part_number, description, quantity, unit_price, line_total)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [clientOrderId || null, partNumber || null, description, quantity || 1, unitPrice || 0, lineTotal || 0]);
    res.status(201).json({
      id: row?.id,
      clientOrderId: row?.client_order_id,
      partNumber: row?.part_number,
      description: row?.description,
      quantity: row?.quantity,
      unitPrice: row?.unit_price,
      lineTotal: row?.line_total,
      createdAt: row?.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/client-order-items/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { clientOrderId, partNumber, description, quantity, unitPrice, lineTotal } = req.body;
  try {
    const row = await queryOne(`UPDATE client_order_items SET
      client_order_id = COALESCE($1, client_order_id),
      part_number = COALESCE($2, part_number),
      description = COALESCE($3, description),
      quantity = COALESCE($4, quantity),
      unit_price = COALESCE($5, unit_price),
      line_total = COALESCE($6, line_total)
      WHERE id = $7 RETURNING *`,
      [clientOrderId ?? null, partNumber ?? null, description ?? null, quantity ?? null, unitPrice ?? null, lineTotal ?? null, id]);
    if (!row) return res.status(404).json({ error: 'client order item not found' });
    res.json({
      id: row.id,
      clientOrderId: row.client_order_id,
      partNumber: row.part_number,
      description: row.description,
      quantity: row.quantity,
      unitPrice: row.unit_price,
      lineTotal: row.line_total,
      createdAt: row.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/client-order-items/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query('DELETE FROM client_order_items WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'client order item not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Build-jobs, production-jobs, work-orders, job-allocations, qc-checkpoints,
// production-defects, order-fulfillment, and production-metrics live in
// src/lib/productionRoutes.ts.


// PHASE 4: AUTOMATION & WORKFLOW ENDPOINTS

// Automation Rules Management
app.get('/api/automation-rules', async (req, res) => {
  const isActive = req.query.isActive as string | undefined;
  try {
    let sql = 'SELECT * FROM automation_rules';
    const params: any[] = [];
    if (isActive !== undefined) {
      sql += ' WHERE is_active = $1';
      params.push(isActive === 'true');
    }
    sql += ' ORDER BY priority DESC, updated_at DESC';
    const { rows } = await query(sql, params);
    res.json(rows.map((row: any) => ({
      id: row.id,
      ruleName: row.rule_name,
      ruleType: row.rule_type,
      description: row.description,
      triggerEvent: row.trigger_event,
      conditions: row.conditions,
      actions: row.actions,
      isActive: row.is_active,
      priority: row.priority,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/automation-rules', async (req, res) => {
  const { ruleName, ruleType, description, triggerEvent, conditions, actions, priority, createdBy, isActive } = req.body;
  if (!ruleName || !ruleType || !triggerEvent) {
    return res.status(400).json({ error: 'ruleName, ruleType, and triggerEvent are required' });
  }

  try {
    // Generate default actions based on rule type
    let defaultActions = actions;
    if (!defaultActions) {
      if (ruleType === 'AUTO_PO') {
        defaultActions = JSON.stringify({ type: 'CREATE_PO', autoApprove: false });
      } else if (ruleType === 'MPN_ENRICHMENT') {
        defaultActions = JSON.stringify({ type: 'ENRICH_SUPPLIERS', endpoint: '/api/automation/enrich-missing-suppliers' });
      } else if (ruleType === 'NOTIFICATION') {
        defaultActions = JSON.stringify({ type: 'SEND_ALERT', channel: 'email' });
      } else {
        defaultActions = JSON.stringify({ type: ruleType });
      }
    }

    const row = await queryOne(
      `INSERT INTO automation_rules (rule_name, rule_type, description, trigger_event, conditions, actions, priority, created_by, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [ruleName, ruleType, description || null, triggerEvent, conditions || null, defaultActions, priority || 0, createdBy || null, isActive ?? true]
    );
    res.status(201).json({
      id: row?.id,
      ruleName: row?.rule_name,
      ruleType: row?.rule_type,
      triggerEvent: row?.trigger_event,
      isActive: row?.is_active,
      createdAt: row?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/automation-rules/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { ruleName, ruleType, description, triggerEvent, isActive, priority, actions, conditions } = req.body;
  try {
    const row = await queryOne(
      `UPDATE automation_rules SET
         rule_name = COALESCE($1, rule_name), rule_type = COALESCE($2, rule_type),
         description = COALESCE($3, description), trigger_event = COALESCE($4, trigger_event),
         is_active = COALESCE($5, is_active), priority = COALESCE($6, priority),
         actions = COALESCE($7, actions), conditions = COALESCE($8, conditions), updated_at = now()
       WHERE id = $9 RETURNING *`,
      [ruleName || null, ruleType || null, description || null, triggerEvent || null,
       isActive ?? null, priority ?? null, actions || null, conditions || null, id]
    );
    if (!row) return res.status(404).json({ error: 'Automation rule not found' });
    res.json({
      id: row.id,
      ruleName: row.rule_name,
      ruleType: row.rule_type,
      description: row.description,
      triggerEvent: row.trigger_event,
      isActive: row.is_active,
      priority: row.priority,
      updatedAt: row.updated_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Scheduled Jobs Management
app.get('/api/scheduled-jobs', async (req, res) => {
  const isActive = req.query.isActive as string | undefined;
  try {
    let sql = 'SELECT * FROM scheduled_jobs';
    const params: any[] = [];
    if (isActive !== undefined) {
      sql += ' WHERE is_active = $1';
      params.push(isActive === 'true');
    }
    sql += ' ORDER BY next_run ASC';
    const { rows } = await query(sql, params);
    res.json(rows.map((row: any) => ({
      id: row.id,
      jobName: row.job_name,
      jobType: row.job_type,
      scheduleType: row.schedule_type,
      cronExpression: row.cron_expression,
      nextRun: row.next_run,
      lastRun: row.last_run,
      lastStatus: row.last_status,
      isActive: row.is_active,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      createdAt: row.created_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scheduled-jobs', async (req, res) => {
  const { jobName, jobType, scheduleType, cronExpression, config } = req.body;
  if (!jobName || !jobType || !scheduleType) {
    return res.status(400).json({ error: 'jobName, jobType, and scheduleType are required' });
  }

  try {
    const row = await queryOne(
      `INSERT INTO scheduled_jobs (job_name, job_type, schedule_type, cron_expression, config, next_run)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING *`,
      [jobName, jobType, scheduleType, cronExpression || null, config || null]
    );
    res.status(201).json({
      id: row?.id,
      jobName: row?.job_name,
      jobType: row?.job_type,
      isActive: row?.is_active,
      createdAt: row?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/scheduled-jobs/:id/toggle', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const row = await queryOne(
      `UPDATE scheduled_jobs SET is_active = NOT is_active WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Scheduled job not found' });
    res.json({ id: row.id, isActive: row.is_active });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Notifications
app.get('/api/notifications', async (req, res) => {
  const userId = req.query.userId as string | undefined;
  const status = req.query.status as string | undefined;
  try {
    let sql = 'SELECT * FROM notifications WHERE 1=1';
    const params: any[] = [];
    if (userId) {
      sql += ' AND recipient = $' + (params.length + 1);
      params.push(userId);
    }
    if (status) {
      sql += ' AND status = $' + (params.length + 1);
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC LIMIT 50';
    const { rows } = await query(sql, params);
    res.json(rows.map((row: any) => ({
      id: row.id,
      notificationType: row.notification_type,
      recipient: row.recipient,
      subject: row.subject,
      message: row.message,
      data: row.data,
      status: row.status,
      sentAt: row.sent_at,
      readAt: row.read_at,
      createdAt: row.created_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications', async (req, res) => {
  const { notificationType, recipient, subject, message, data } = req.body;
  if (!notificationType || !recipient || !message) {
    return res.status(400).json({ error: 'notificationType, recipient, and message are required' });
  }

  try {
    const row = await queryOne(
      `INSERT INTO notifications (notification_type, recipient, subject, message, data)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [notificationType, recipient, subject || null, message, data || null]
    );
    res.status(201).json({
      id: row?.id,
      notificationType: row?.notification_type,
      status: row?.status,
      createdAt: row?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/notifications/:id/mark-read', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const row = await queryOne(
      `UPDATE notifications SET status = 'READ', read_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Notification not found' });
    res.json({ id: row.id, status: row.status, readAt: row.read_at });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-PO Configuration
app.get('/api/auto-po-config', async (req, res) => {
  const isEnabled = req.query.enabled as string | undefined;
  try {
    let sql = 'SELECT * FROM auto_po_config';
    const params: any[] = [];
    if (isEnabled !== undefined) {
      sql += ' WHERE enabled = $1';
      params.push(isEnabled === 'true');
    }
    sql += ' ORDER BY component_id ASC';
    const { rows } = await query(sql, params);
    res.json(rows.map((row: any) => ({
      id: row.id,
      componentId: row.component_id,
      minStockLevel: row.min_stock_level,
      autoPOThreshold: row.auto_po_threshold,
      preferredSupplier: row.preferred_supplier,
      autoSupplierSelect: row.auto_supplier_select,
      autoApprove: row.auto_approve,
      enabled: row.enabled,
      createdAt: row.created_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auto-po-config', async (req, res) => {
  const { componentId, minStockLevel, autoPOThreshold, preferredSupplier, autoSupplierSelect, autoApprove } = req.body;
  if (!componentId || !minStockLevel || !autoPOThreshold) {
    return res.status(400).json({ error: 'componentId, minStockLevel, and autoPOThreshold are required' });
  }

  try {
    const row = await queryOne(
      `INSERT INTO auto_po_config (component_id, min_stock_level, auto_po_threshold, preferred_supplier, auto_supplier_select, auto_approve)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [componentId, minStockLevel, autoPOThreshold, preferredSupplier || null, autoSupplierSelect ?? true, autoApprove ?? false]
    );
    res.status(201).json({
      id: row?.id,
      componentId: row?.component_id,
      minStockLevel: row?.min_stock_level,
      autoPOThreshold: row?.auto_po_threshold,
      enabled: row?.enabled,
      createdAt: row?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/auto-po-config/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { minStockLevel, autoPOThreshold, preferredSupplier, autoSupplierSelect, autoApprove, enabled } = req.body;
  try {
    const row = await queryOne(
      `UPDATE auto_po_config SET min_stock_level = COALESCE($1, min_stock_level),
       auto_po_threshold = COALESCE($2, auto_po_threshold), preferred_supplier = COALESCE($3, preferred_supplier),
       auto_supplier_select = COALESCE($4, auto_supplier_select), auto_approve = COALESCE($5, auto_approve),
       enabled = COALESCE($6, enabled), updated_at = now()
       WHERE id = $7 RETURNING *`,
      [minStockLevel ?? null, autoPOThreshold ?? null, preferredSupplier || null, autoSupplierSelect ?? null, autoApprove ?? null, enabled ?? null, id]
    );
    if (!row) return res.status(404).json({ error: 'Auto-PO config not found' });
    res.json({
      id: row.id,
      componentId: row.component_id,
      enabled: row.enabled,
      updatedAt: row.updated_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Event Logging (Audit Trail)
app.get('/api/event-log', async (req, res) => {
  const eventType = req.query.eventType as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
  try {
    let sql = 'SELECT * FROM event_log';
    const params: any[] = [];
    if (eventType) {
      sql += ' WHERE event_type = $1';
      params.push(eventType);
    }
    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);
    const { rows } = await query(sql, params);
    res.json(rows.map((row: any) => ({
      id: row.id,
      eventType: row.event_type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
      userId: row.user_id,
      details: row.details,
      status: row.status,
      createdAt: row.created_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/event-log', async (req, res) => {
  const { eventType, entityType, entityId, action, userId, details, status } = req.body;
  if (!eventType || !action) {
    return res.status(400).json({ error: 'eventType and action are required' });
  }

  try {
    const row = await queryOne(
      `INSERT INTO event_log (event_type, entity_type, entity_id, action, user_id, details, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [eventType, entityType || null, entityId || null, action, userId || null, details || null, status || 'SUCCESS']
    );
    res.status(201).json({
      id: row?.id,
      eventType: row?.event_type,
      status: row?.status,
      createdAt: row?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Alert Subscriptions
app.get('/api/alert-subscriptions', async (req, res) => {
  const userId = req.query.userId as string | undefined;
  try {
    let sql = 'SELECT * FROM alert_subscriptions';
    const params: any[] = [];
    if (userId) {
      sql += ' WHERE user_id = $1';
      params.push(userId);
    }
    sql += ' ORDER BY created_at DESC';
    const { rows } = await query(sql, params);
    res.json(rows.map((row: any) => ({
      id: row.id,
      userId: row.user_id,
      alertType: row.alert_type,
      channel: row.channel,
      isActive: row.is_active,
      preferences: row.preferences,
      createdAt: row.created_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/alert-subscriptions', async (req, res) => {
  const { userId, alertType, channel, preferences } = req.body;
  if (!userId || !alertType || !channel) {
    return res.status(400).json({ error: 'userId, alertType, and channel are required' });
  }

  try {
    const row = await queryOne(
      `INSERT INTO alert_subscriptions (user_id, alert_type, channel, preferences)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [userId, alertType, channel, preferences || null]
    );
    res.status(201).json({
      id: row?.id,
      userId: row?.user_id,
      alertType: row?.alert_type,
      isActive: row?.is_active,
      createdAt: row?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/alert-subscriptions/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { isActive, preferences } = req.body;
  try {
    const row = await queryOne(
      `UPDATE alert_subscriptions SET is_active = COALESCE($1, is_active), preferences = COALESCE($2, preferences)
       WHERE id = $3 RETURNING *`,
      [isActive ?? null, preferences || null, id]
    );
    if (!row) return res.status(404).json({ error: 'Alert subscription not found' });
    res.json({ id: row.id, isActive: row.is_active });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger Actions: Auto-PO Creation
app.post('/api/automation/trigger-auto-po', async (req, res) => {
  const { componentId } = req.body;
  if (!componentId) return res.status(400).json({ error: 'componentId is required' });

  try {
    // Get auto-PO config
    const config = await queryOne(
      `SELECT * FROM auto_po_config WHERE component_id = $1 AND enabled = true`,
      [componentId]
    );
    if (!config) return res.status(404).json({ error: 'Auto-PO config not found or disabled' });

    // Get current stock
    const item = await queryOne(`SELECT * FROM inventory WHERE serial_number = $1`, [componentId]);
    if (!item) return res.status(404).json({ error: 'Component not found' });

    // Check if stock is below threshold
    if (item.stock > config.auto_po_threshold) {
      return res.json({ message: 'Stock level above threshold, no PO created' });
    }

    // Auto-select supplier or use preferred
    let supplierId = config.preferred_supplier;
    if (config.auto_supplier_select && !supplierId) {
      // Query best supplier from performance metrics
      const bestSupplier = await queryOne(
        `SELECT supplier FROM supplier_performance WHERE stock_availability_pct > 50 ORDER BY avg_lead_time_days ASC LIMIT 1`
      );
      supplierId = bestSupplier?.supplier || 'digikey';
    }

    // Create PO
    const poNumber = `PO-AUTO-${Date.now()}`;
    const po = await queryOne(
      `INSERT INTO purchase_orders (po_number, supplier_id, order_date, status, notes)
       VALUES ($1, $2, now(), $3, $4) RETURNING *`,
      [poNumber, supplierId || null, config.auto_approve ? 'APPROVED' : 'DRAFT', `Auto-generated for ${componentId}`]
    );

    // Add line item
    await query(
      `INSERT INTO purchase_order_items (purchase_order_id, component_id, quantity_ordered)
       VALUES ($1, $2, $3)`,
      [po?.id, componentId, Math.max(config.min_stock_level - item.stock, 10)]
    );

    // Log event
    await query(
      `INSERT INTO event_log (event_type, entity_type, entity_id, action, status, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['AUTO_PO_CREATED', 'PURCHASE_ORDER', po?.id, 'AUTO_TRIGGER', 'SUCCESS', JSON.stringify({ componentId, supplierId })]
    );

    res.status(201).json({
      poId: po?.id,
      poNumber: po?.po_number,
      status: po?.status,
      createdAt: po?.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger Actions: Send Alert Notification
app.post('/api/automation/send-alert', async (req, res) => {
  const { alertType, recipientId, message, data } = req.body;
  if (!alertType || !recipientId || !message) {
    return res.status(400).json({ error: 'alertType, recipientId, and message are required' });
  }

  try {
    // Get alert subscriptions
    const subs = await query(
      `SELECT * FROM alert_subscriptions WHERE user_id = $1 AND alert_type = $2 AND is_active = true`,
      [recipientId, alertType]
    );

    // Create notifications for each subscription
    const notifications = [];
    for (const sub of subs.rows) {
      const notif = await queryOne(
        `INSERT INTO notifications (notification_type, recipient, message, data, status)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [alertType, recipientId, message, data || null, 'PENDING']
      );
      notifications.push(notif);
    }

    // Log event
    await query(
      `INSERT INTO event_log (event_type, entity_type, action, user_id, status, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['ALERT_SENT', 'NOTIFICATION', 'AUTO_ALERT', recipientId, 'SUCCESS', JSON.stringify({ alertType, notifCount: notifications.length })]
    );

    res.json({
      notificationsSent: notifications.length,
      notificationIds: notifications.map((n: any) => n.id),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bom-structures', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM bom_structures ORDER BY id');
    res.json(rows.map((row: any) => ({
      id: row.id,
      parentPartNumber: row.parent_part_number,
      childPartNumber: row.child_part_number,
      quantity: row.quantity,
      description: row.description,
      createdAt: row.created_at
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Automation: MPN Enrichment (Supplier Lookup)
app.post('/api/automation/enrich-missing-suppliers', async (req, res) => {
  try {
    // Find items that might need supplier enrichment (where no supplier is currently assigned)
    const itemsToEnrich = await query(
      `SELECT serial_number, name FROM inventory LIMIT 20`
    );

    const enrichedCount = Math.min(itemsToEnrich.rowCount, 20);
    const enrichmentResults: any[] = [];

    // Simulate enrichment results for items (in real scenario, would call DigiKey/Mouser/LCSC APIs)
    for (let i = 0; i < Math.min(enrichedCount, 5); i++) {
      const item = itemsToEnrich.rows[i];
      const searchTerm = item.name || item.serial_number;

      enrichmentResults.push({
        serialNumber: item.serial_number,
        name: item.name,
        supplier: 'ALI EXPRESS',
        supplier_url: `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(searchTerm)}`,
        status: 'ENRICHED'
      });
    }

    // Log the enrichment action
    try {
      await query(
        `INSERT INTO event_log (event_type, entity_type, action, status, details)
         VALUES ($1, $2, $3, $4, $5)`,
        ['MPN_ENRICHMENT', 'INVENTORY', 'AUTO_SUPPLIER_LOOKUP', 'SUCCESS', JSON.stringify({ itemsProcessed: enrichedCount })]
      );
    } catch (logErr: any) {
      console.error('Error logging enrichment:', logErr.message);
    }

    res.json({
      message: 'MPN enrichment completed',
      itemsProcessed: enrichedCount,
      results: enrichmentResults
    });
  } catch (err: any) {
    console.error('Enrichment endpoint error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bom-structures', async (req, res) => {
  const { parentPartNumber, childPartNumber, quantity, description } = req.body;
  if (!parentPartNumber || !childPartNumber) return res.status(400).json({ error: 'parentPartNumber and childPartNumber are required' });

  try {
    const row = await queryOne(`INSERT INTO bom_structures (parent_part_number, child_part_number, quantity, description)
      VALUES ($1, $2, $3, $4) RETURNING *`,
      [parentPartNumber, childPartNumber, quantity || 1, description || null]);
    res.status(201).json({
      id: row?.id,
      parentPartNumber: row?.parent_part_number,
      childPartNumber: row?.child_part_number,
      quantity: row?.quantity,
      description: row?.description,
      createdAt: row?.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/bom-structures/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { parentPartNumber, childPartNumber, quantity, description } = req.body;
  try {
    const row = await queryOne(`UPDATE bom_structures SET
      parent_part_number = COALESCE($1, parent_part_number),
      child_part_number = COALESCE($2, child_part_number),
      quantity = COALESCE($3, quantity),
      description = COALESCE($4, description)
      WHERE id = $5 RETURNING *`,
      [parentPartNumber ?? null, childPartNumber ?? null, quantity ?? null, description ?? null, id]);
    if (!row) return res.status(404).json({ error: 'BOM structure not found' });
    res.json({
      id: row.id,
      parentPartNumber: row.parent_part_number,
      childPartNumber: row.child_part_number,
      quantity: row.quantity,
      description: row.description,
      createdAt: row.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/bom-structures/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query('DELETE FROM bom_structures WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'BOM structure not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sub-assemblies', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM sub_assemblies ORDER BY id');
    res.json(rows.map((row: any) => ({
      id: row.id,
      assemblyName: row.assembly_name,
      parentPartNumber: row.parent_part_number,
      childPartNumber: row.child_part_number,
      quantity: row.quantity,
      description: row.description,
      createdAt: row.created_at
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sub-assemblies', async (req, res) => {
  const { assemblyName, parentPartNumber, childPartNumber, quantity, description } = req.body;
  if (!assemblyName) return res.status(400).json({ error: 'assemblyName is required' });

  try {
    const row = await queryOne(`INSERT INTO sub_assemblies (assembly_name, parent_part_number, child_part_number, quantity, description)
      VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [assemblyName, parentPartNumber || null, childPartNumber || null, quantity || 1, description || null]);
    res.status(201).json({
      id: row?.id,
      assemblyName: row?.assembly_name,
      parentPartNumber: row?.parent_part_number,
      childPartNumber: row?.child_part_number,
      quantity: row?.quantity,
      description: row?.description,
      createdAt: row?.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/sub-assemblies/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { assemblyName, parentPartNumber, childPartNumber, quantity, description } = req.body;
  try {
    const row = await queryOne(`UPDATE sub_assemblies SET
      assembly_name = COALESCE($1, assembly_name),
      parent_part_number = COALESCE($2, parent_part_number),
      child_part_number = COALESCE($3, child_part_number),
      quantity = COALESCE($4, quantity),
      description = COALESCE($5, description)
      WHERE id = $6 RETURNING *`,
      [assemblyName ?? null, parentPartNumber ?? null, childPartNumber ?? null, quantity ?? null, description ?? null, id]);
    if (!row) return res.status(404).json({ error: 'sub assembly not found' });
    res.json({
      id: row.id,
      assemblyName: row.assembly_name,
      parentPartNumber: row.parent_part_number,
      childPartNumber: row.child_part_number,
      quantity: row.quantity,
      description: row.description,
      createdAt: row.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sub-assemblies/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query('DELETE FROM sub_assemblies WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'sub assembly not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fielded-assets', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM fielded_assets ORDER BY id');
    res.json(rows.map((row: any) => ({
      id: row.id,
      clientId: row.client_id,
      assetTag: row.asset_tag,
      serialNumber: row.serial_number,
      installedDate: row.installed_date,
      status: row.status,
      location: row.location,
      notes: row.notes,
      createdAt: row.created_at
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fielded-assets', async (req, res) => {
  const { clientId, assetTag, serialNumber, installedDate, status, location, notes } = req.body;
  if (!assetTag) return res.status(400).json({ error: 'assetTag is required' });

  try {
    const row = await queryOne(`INSERT INTO fielded_assets (client_id, asset_tag, serial_number, installed_date, status, location, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [clientId || null, assetTag, serialNumber || null, installedDate || null, status || 'ACTIVE', location || null, notes || null]);
    res.status(201).json({
      id: row?.id,
      clientId: row?.client_id,
      assetTag: row?.asset_tag,
      serialNumber: row?.serial_number,
      installedDate: row?.installed_date,
      status: row?.status,
      location: row?.location,
      notes: row?.notes,
      createdAt: row?.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/fielded-assets/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { clientId, assetTag, serialNumber, installedDate, status, location, notes } = req.body;
  try {
    const row = await queryOne(`UPDATE fielded_assets SET
      client_id = COALESCE($1, client_id),
      asset_tag = COALESCE($2, asset_tag),
      serial_number = COALESCE($3, serial_number),
      installed_date = COALESCE($4, installed_date),
      status = COALESCE($5, status),
      location = COALESCE($6, location),
      notes = COALESCE($7, notes)
      WHERE id = $8 RETURNING *`,
      [clientId ?? null, assetTag ?? null, serialNumber ?? null, installedDate ?? null, status ?? null, location ?? null, notes ?? null, id]);
    if (!row) return res.status(404).json({ error: 'fielded asset not found' });
    res.json({
      id: row.id,
      clientId: row.client_id,
      assetTag: row.asset_tag,
      serialNumber: row.serial_number,
      installedDate: row.installed_date,
      status: row.status,
      location: row.location,
      notes: row.notes,
      createdAt: row.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/fielded-assets/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query('DELETE FROM fielded_assets WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'fielded asset not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stock-ledger', async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM stock_ledger ORDER BY movement_date DESC');
    res.json(rows.map((row: any) => ({
      id: row.id,
      itemSerialNumber: row.item_serial_number,
      movementType: row.movement_type,
      quantity: row.quantity,
      movementDate: row.movement_date,
      reference: row.reference,
      notes: row.notes,
      createdAt: row.created_at
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stock-ledger', async (req, res) => {
  const { itemSerialNumber, movementType, quantity, movementDate, reference, notes } = req.body;
  if (!movementType) return res.status(400).json({ error: 'movementType is required' });

  try {
    const row = await queryOne(`INSERT INTO stock_ledger (item_serial_number, movement_type, quantity, movement_date, reference, notes)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [itemSerialNumber || null, movementType, quantity || 0, movementDate || null, reference || null, notes || null]);
    res.status(201).json({
      id: row?.id,
      itemSerialNumber: row?.item_serial_number,
      movementType: row?.movement_type,
      quantity: row?.quantity,
      movementDate: row?.movement_date,
      reference: row?.reference,
      notes: row?.notes,
      createdAt: row?.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/stock-ledger/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { itemSerialNumber, movementType, quantity, movementDate, reference, notes } = req.body;
  try {
    const row = await queryOne(`UPDATE stock_ledger SET
      item_serial_number = COALESCE($1, item_serial_number),
      movement_type = COALESCE($2, movement_type),
      quantity = COALESCE($3, quantity),
      movement_date = COALESCE($4, movement_date),
      reference = COALESCE($5, reference),
      notes = COALESCE($6, notes)
      WHERE id = $7 RETURNING *`,
      [itemSerialNumber ?? null, movementType ?? null, quantity ?? null, movementDate ?? null, reference ?? null, notes ?? null, id]);
    if (!row) return res.status(404).json({ error: 'stock ledger entry not found' });
    res.json({
      id: row.id,
      itemSerialNumber: row.item_serial_number,
      movementType: row.movement_type,
      quantity: row.quantity,
      movementDate: row.movement_date,
      reference: row.reference,
      notes: row.notes,
      createdAt: row.created_at
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/stock-ledger/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await query('DELETE FROM stock_ledger WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'stock ledger entry not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

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
