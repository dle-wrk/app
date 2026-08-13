import { ViewType } from '../types';

// A single navigable destination. `section` and `subSection` deep-link into
// views that have internal tab state (Bookkeeping today; anything else that
// grows tabs should follow the same shape).
export interface CommandTarget {
  view: ViewType;
  section?: string;
  subSection?: string;
  /** When present, App sets its global searchQuery to this value on nav — used
   * to highlight a specific entity inside a list-shaped view. */
  focusQuery?: string;
}

export interface CommandRoute {
  id: string;
  label: string;
  /** Short subtitle shown under the label — usually the path (e.g. "Bookkeeping › Sales › Dispatch"). */
  path: string;
  /** Extra searchable synonyms so common phrasings hit. Comma-separated words. */
  keywords: string;
  target: CommandTarget;
  /** Bucket the result lands in. */
  group: 'Pages' | 'Bookkeeping' | 'Actions' | 'Items' | 'Clients' | 'Suppliers';
  /** Lucide icon name — resolved to a component in CommandPalette. */
  icon: string;
}

// The canonical registry. Any newly-added top-level view or sub-tab must be
// listed here or it will be unreachable via the palette. Keywords are the
// difference between a palette that feels smart and one that doesn't — err on
// the side of listing every phrasing a real user might type.
export const ROUTES: CommandRoute[] = [
  { id: 'dashboard', label: 'Dashboard', path: 'Home', keywords: 'home overview main kpi metrics summary', group: 'Pages', icon: 'LayoutDashboard', target: { view: 'dashboard' } },
  { id: 'items', label: 'Items & Inventory', path: 'Stock › Items', keywords: 'parts stock inventory catalog catalogue components', group: 'Pages', icon: 'Boxes', target: { view: 'items' } },
  { id: 'stock_kits', label: 'Stock Tables', path: 'Stock', keywords: 'kits tables warehouse levels', group: 'Pages', icon: 'TableProperties', target: { view: 'stock_kits' } },
  { id: 'pricing', label: 'Pricing Directory', path: 'Pricing', keywords: 'quotes digikey mouser lcsc nexar element14 tme suppliers cost currency zar usd bulk', group: 'Pages', icon: 'Tag', target: { view: 'pricing' } },
  { id: 'suppliers', label: 'Suppliers', path: 'Suppliers', keywords: 'vendors distributors manufacturers', group: 'Pages', icon: 'Factory', target: { view: 'suppliers' } },
  { id: 'bookkeeping', label: 'Bookkeeping', path: 'Bookkeeping', keywords: 'accounting finance ledger invoices bills', group: 'Pages', icon: 'Receipt', target: { view: 'bookkeeping' } },
  { id: 'production_costs', label: 'Production Costs', path: 'Stock › Production Costs', keywords: 'cogs bom cost margin markup selling price', group: 'Pages', icon: 'Calculator', target: { view: 'production_costs' } },
  { id: 'kit_booking', label: 'P&P Kit Booking', path: 'Manufacturing', keywords: 'pick place kit reserve book', group: 'Pages', icon: 'Boxes', target: { view: 'kit_booking' } },
  { id: 'bom_manager', label: 'Bill of Materials', path: 'Manufacturing › BOM', keywords: 'bom bill of materials board pcb components', group: 'Pages', icon: 'Boxes', target: { view: 'bom_manager' } },
  { id: 'pick_place', label: 'Pick & Place', path: 'Manufacturing', keywords: 'p&p smt pnp coordinates placement', group: 'Pages', icon: 'Database', target: { view: 'pick_place' } },
  { id: 'alternates', label: 'Component Alternates', path: 'Manufacturing', keywords: 'substitutes alternates equivalents crosses', group: 'Pages', icon: 'ArrowLeftRight', target: { view: 'alternates' } },
  { id: 'projects', label: 'Project Manager', path: 'Projects', keywords: 'projects jobs builds', group: 'Pages', icon: 'ClipboardList', target: { view: 'projects' } },
  { id: 'automation', label: 'Automation Dashboard', path: 'Automation', keywords: 'workflows rules triggers scheduled jobs alerts', group: 'Pages', icon: 'Zap', target: { view: 'automation' } },
  { id: 'auto_po_config', label: 'Auto-PO Config', path: 'Automation', keywords: 'auto po purchase order reorder threshold', group: 'Pages', icon: 'Settings', target: { view: 'auto_po_config' } },
  { id: 'quality_compliance', label: 'Quality & Compliance', path: 'Quality', keywords: 'qa qc inspections defects ncr non conformance audits', group: 'Pages', icon: 'Shield', target: { view: 'quality_compliance' } },
  { id: 'advanced_automation', label: 'Advanced Automation', path: 'Quality', keywords: 'ml machine learning anomaly detection intelligence', group: 'Pages', icon: 'Brain', target: { view: 'advanced_automation' } },
  { id: 'settings', label: 'System Config', path: 'Admin', keywords: 'settings preferences theme timezone api keys credentials', group: 'Pages', icon: 'Settings', target: { view: 'settings' } },
  { id: 'activity-logs', label: 'Activity Logs', path: 'Admin', keywords: 'audit history log events who did what', group: 'Pages', icon: 'Activity', target: { view: 'activity-logs' } },
  { id: 'reports_ledger', label: 'Reports & Ledger', path: 'Admin', keywords: 'reports ledger stock movements transactions', group: 'Pages', icon: 'ArrowLeftRight', target: { view: 'reports_ledger' } },
  { id: 'profile', label: 'My Profile', path: 'Admin', keywords: 'profile account me user', group: 'Pages', icon: 'User', target: { view: 'profile' } },

  // Bookkeeping sub-tabs — deep-linked via `section`/`subSection`.
  { id: 'bk_overview', label: 'Bookkeeping Overview', path: 'Bookkeeping › Overview', keywords: 'summary kpi', group: 'Bookkeeping', icon: 'LayoutDashboard', target: { view: 'bookkeeping', section: 'OVERVIEW' } },
  { id: 'bk_customers', label: 'Customers', path: 'Bookkeeping › Sales › Customers', keywords: 'clients accounts buyer', group: 'Bookkeeping', icon: 'Users', target: { view: 'bookkeeping', section: 'SALES', subSection: 'CUSTOMERS' } },
  { id: 'bk_sales_orders', label: 'Sales Orders', path: 'Bookkeeping › Sales › Orders', keywords: 'so sales orders quote', group: 'Bookkeeping', icon: 'FileText', target: { view: 'bookkeeping', section: 'SALES', subSection: 'ORDERS' } },
  { id: 'bk_invoices', label: 'Invoices', path: 'Bookkeeping › Sales › Invoices', keywords: 'invoice inv billing receivable', group: 'Bookkeeping', icon: 'Receipt', target: { view: 'bookkeeping', section: 'SALES', subSection: 'INVOICES' } },
  { id: 'bk_payments_received', label: 'Payments Received', path: 'Bookkeeping › Sales › Payments', keywords: 'receipt receivable customer payment', group: 'Bookkeeping', icon: 'Wallet', target: { view: 'bookkeeping', section: 'SALES', subSection: 'PAYMENTS' } },
  { id: 'bk_dispatch', label: 'Delivery & Collection Notes', path: 'Bookkeeping › Sales › Dispatch', keywords: 'delivery note collection note dispatch shipping dn cn courier', group: 'Bookkeeping', icon: 'Truck', target: { view: 'bookkeeping', section: 'SALES', subSection: 'DISPATCH' } },
  { id: 'bk_vendors', label: 'Vendors', path: 'Bookkeeping › Purchases › Vendors', keywords: 'suppliers vendor', group: 'Bookkeeping', icon: 'Truck', target: { view: 'bookkeeping', section: 'PURCHASES', subSection: 'VENDORS' } },
  { id: 'bk_purchase_orders', label: 'Purchase Orders', path: 'Bookkeeping › Purchases › Orders', keywords: 'po purchase order buy', group: 'Bookkeeping', icon: 'FileText', target: { view: 'bookkeeping', section: 'PURCHASES', subSection: 'ORDERS' } },
  { id: 'bk_bills', label: 'Bills', path: 'Bookkeeping › Purchases › Bills', keywords: 'bill vendor invoice payable ap', group: 'Bookkeeping', icon: 'Receipt', target: { view: 'bookkeeping', section: 'PURCHASES', subSection: 'BILLS' } },
  { id: 'bk_payments_made', label: 'Payments Made', path: 'Bookkeeping › Purchases › Payments', keywords: 'vendor payment payable ap outbound', group: 'Bookkeeping', icon: 'CreditCard', target: { view: 'bookkeeping', section: 'PURCHASES', subSection: 'PAYMENTS' } },
  { id: 'bk_expenses', label: 'Expenses', path: 'Bookkeeping › Purchases › Expenses', keywords: 'expense receipt petty cash', group: 'Bookkeeping', icon: 'Wallet', target: { view: 'bookkeeping', section: 'PURCHASES', subSection: 'EXPENSES' } },
  { id: 'bk_accounting', label: 'Accounting', path: 'Bookkeeping › Accounting', keywords: 'chart of accounts coa journal ledger tax rates', group: 'Bookkeeping', icon: 'Landmark', target: { view: 'bookkeeping', section: 'ACCOUNTING' } },
  { id: 'bk_production', label: 'Production', path: 'Bookkeeping › Production', keywords: 'work orders builds cogs', group: 'Bookkeeping', icon: 'Wrench', target: { view: 'bookkeeping', section: 'PRODUCTION' } },
  { id: 'bk_reports', label: 'Bookkeeping Reports', path: 'Bookkeeping › Reports', keywords: 'financial reports p&l income statement balance sheet', group: 'Bookkeeping', icon: 'BarChart3', target: { view: 'bookkeeping', section: 'REPORTS' } },
];

export interface ScoredResult<T = unknown> {
  score: number;
  item: T;
  matches: number[];
}

// Case-insensitive subsequence match with a light preference for tight matches
// and prefix hits. Returns a score and the indices that matched so we can
// highlight them; -1 if not a match.
export function fuzzyScore(query: string, target: string): { score: number; matches: number[] } {
  if (!query) return { score: 0, matches: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  // Substring is the strongest signal.
  const idx = t.indexOf(q);
  if (idx !== -1) {
    const prefixBonus = idx === 0 ? 200 : 0;
    const wordStartBonus = idx === 0 || /[\s\-_/›&]/.test(t[idx - 1] || '') ? 80 : 0;
    return {
      score: 1000 + prefixBonus + wordStartBonus - idx,
      matches: Array.from({ length: q.length }, (_, i) => idx + i),
    };
  }
  // Fallback: characters-in-order (subsequence).
  const matches: number[] = [];
  let ti = 0;
  let gaps = 0;
  let wordBoundaryHits = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const nextIdx = t.indexOf(ch, ti);
    if (nextIdx === -1) return { score: -1, matches: [] };
    if (matches.length > 0) gaps += nextIdx - ti;
    if (nextIdx === 0 || /[\s\-_/›&]/.test(t[nextIdx - 1] || '')) wordBoundaryHits++;
    matches.push(nextIdx);
    ti = nextIdx + 1;
  }
  return { score: 100 + wordBoundaryHits * 20 - gaps, matches };
}

// Best-of over label and keywords, with label matches weighted 2×.
export function scoreRoute(route: CommandRoute, query: string): number {
  if (!query) return 0;
  const label = fuzzyScore(query, route.label).score;
  const path = fuzzyScore(query, route.path).score;
  const keywords = fuzzyScore(query, route.keywords).score;
  const best = Math.max(
    label >= 0 ? label * 2 : -Infinity,
    path >= 0 ? path : -Infinity,
    keywords >= 0 ? keywords : -Infinity,
  );
  return best === -Infinity ? -1 : best;
}

// Simple recency store: last N selected command ids, most-recent-first.
const RECENT_KEY = 'commandPaletteRecent';
const RECENT_MAX = 6;

export function getRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string').slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

export function pushRecent(id: string): void {
  const current = getRecent().filter((r) => r !== id);
  current.unshift(id);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(current.slice(0, RECENT_MAX))); } catch { /* ignore */ }
}
