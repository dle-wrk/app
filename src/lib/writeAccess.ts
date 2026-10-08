// Who may change what: every write to the API (POST, PUT, PATCH, DELETE)
// needs the permission for its area (see ./permissions for which roles have
// which). Reads stay open to everyone signed in.
//
// Mounted once in server.ts after requireSession. Routes that check a
// stricter rule of their own (admin-only, bulk pricing) still do; this is
// the floor under them. An area is the first part of the path after /api/.
// Deleting needs the area's delete permission; anything else its update one.
// A write to an area missing from AREAS is refused for viewers and allowed
// for other roles, and a unit test fails until it is listed here.

import type { NextFunction, Response } from 'express';
import { notAllowedMessage, roleCan, type Permission } from './permissions';

type Area = { change: Permission; remove: Permission } | 'open';

const INVENTORY: Area = { change: 'inventory.update', remove: 'inventory.delete' };
const ORDERS: Area = { change: 'orders.update', remove: 'orders.delete' };
const SUPPLIERS: Area = { change: 'suppliers.update', remove: 'suppliers.delete' };
const PROJECTS: Area = { change: 'projects.update', remove: 'projects.delete' };
const QUALITY: Area = { change: 'quality.update', remove: 'quality.update' };
const AUTOMATION: Area = { change: 'automation.create', remove: 'automation.delete' };

export const AREAS: Record<string, Area> = {
  // Stock, parts, BOMs and kits
  items: INVENTORY, inventory: INVENTORY, transactions: INVENTORY, 'stock-ledger': INVENTORY,
  kits: INVENTORY, 'kit-booking': INVENTORY, 'production-kits': INVENTORY, 'production-products': INVENTORY,
  'bom-structures': INVENTORY, 'sub-assemblies': INVENTORY, 'fielded-assets': INVENTORY,
  shortages: INVENTORY, 'procurement-projects': INVENTORY, 'exchange-rate': INVENTORY,
  // Bookkeeping: customers, sales, purchases, payments, accounts
  clients: ORDERS, 'client-orders': ORDERS, 'client-order-items': ORDERS, invoices: ORDERS, bills: ORDERS,
  'credit-notes': ORDERS, 'purchase-orders': ORDERS, 'payments-received': ORDERS, 'payments-made': ORDERS,
  'dispatch-notes': ORDERS, expenses: ORDERS, accounts: ORDERS, 'tax-rates': ORDERS, 'journal-entries': ORDERS,
  bank: ORDERS, 'landed-cost-batches': ORDERS, bookkeeping: ORDERS, 'order-fulfillment': ORDERS,
  suppliers: SUPPLIERS,
  // Projects and production
  projects: PROJECTS, 'job-cards': PROJECTS, 'project-progress': PROJECTS, 'production-jobs': PROJECTS,
  'work-orders': PROJECTS, 'build-jobs': PROJECTS, 'job-allocations': PROJECTS, 'production-metrics': PROJECTS,
  // Quality
  'qc-checkpoints': QUALITY, 'production-defects': QUALITY, 'qa-inspections': QUALITY, defects: QUALITY, ncr: QUALITY,
  'compliance-checkpoints': QUALITY, 'compliance-records': QUALITY, 'quality-gates': QUALITY,
  anomalies: QUALITY, 'anomaly-rules': QUALITY,
  // Automation and forecasting: things that act on their own
  automation: AUTOMATION, 'automation-rules': AUTOMATION, 'scheduled-jobs': AUTOMATION, 'auto-po-config': AUTOMATION,
  'alert-subscriptions': AUTOMATION, 'ml-models': AUTOMATION, analytics: AUTOMATION, 'demand-forecasts': AUTOMATION,
  'predictive-orders': AUTOMATION, 'supplier-intelligence': AUTOMATION,
  // Anyone signed in. Signing in and out, the app's own logging and
  // notifications, price lookups and the supplier BOM lookup (they change no
  // records; the parts that do check their own rules), and settings, which
  // also hold each person's profile.
  login: 'open', session: 'open', auth: 'open', 'activity-log': 'open', 'event-log': 'open',
  notifications: 'open', pricing: 'open', 'supplier-bom': 'open', settings: 'open',
  // Checked by the routes themselves (admins).
  users: 'open', docs: 'open', start: 'open',
};

// Areas whose writes inside are lookups rather than changes.
const LOOKUPS = [/^\/api\/kit-booking\/validate$/];

/** The permission a write needs, or null when any signed-in user may make it. */
export function permissionForWrite(method: string, path: string): Permission | 'not-viewer' | null {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) return null;
  if (LOOKUPS.some((re) => re.test(path))) return null;
  const area = path.match(/^\/api\/([^/]+)/)?.[1];
  if (!area) return null;
  const rule = AREAS[area];
  if (rule === 'open') return null;
  if (!rule) return 'not-viewer';
  return method.toUpperCase() === 'DELETE' ? rule.remove : rule.change;
}

/** Express middleware: refuses a write the signed-in user's role may not make. */
export function requireWriteAccess(req: any, res: Response, next: NextFunction): void {
  const fullPath = `${req.baseUrl || ''}${req.path}`.replace(/\/+$/, '');
  const needed = permissionForWrite(req.method, fullPath);
  if (!needed || !req.user) { next(); return; } // requireSession has dealt with no user
  if (needed === 'not-viewer') {
    if (String(req.user.role ?? '').toLowerCase() === 'viewer') { res.status(403).json({ error: 'Viewers can look but not change anything.' }); return; }
    next();
    return;
  }
  if (!roleCan(req.user.role, needed)) { res.status(403).json({ error: notAllowedMessage(needed) }); return; }
  next();
}
