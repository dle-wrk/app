// Who may do what, by role: one list for the server (requirePermission in
// ./authRoutes) and the screens (currentUserCan), so a button is only shown
// to someone the server will let use it.
//
// Roles are admin, manager, engineer and viewer (see UserManagement). Admin
// may do everything. The role_permissions table has never been filled (only
// the one-shot POST /api/users/init-roles seeder writes it, from this list),
// so this list is what counts.

export type Permission =
  | 'users.create' | 'users.read' | 'users.update' | 'users.delete'
  | 'inventory.create' | 'inventory.read' | 'inventory.update' | 'inventory.delete'
  | 'suppliers.create' | 'suppliers.read' | 'suppliers.update' | 'suppliers.delete'
  | 'orders.create' | 'orders.read' | 'orders.update' | 'orders.delete'
  | 'projects.update' | 'projects.delete'
  | 'quality.update'
  | 'reports.read' | 'settings.update' | 'automation.create' | 'automation.delete';

// Every change to the API is checked against this (./writeAccess), agreed
// 2026-10-08: managers run bookkeeping and may delete in the areas they
// change; engineers add and change stock, BOMs, kits, projects and quality
// records but not bookkeeping, and delete nothing; automation is for admins
// and managers; viewers only look.
export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  admin: [
    'users.create', 'users.read', 'users.update', 'users.delete',
    'inventory.create', 'inventory.read', 'inventory.update', 'inventory.delete',
    'suppliers.create', 'suppliers.read', 'suppliers.update', 'suppliers.delete',
    'orders.create', 'orders.read', 'orders.update', 'orders.delete',
    'projects.update', 'projects.delete',
    'quality.update',
    'reports.read', 'settings.update', 'automation.create', 'automation.delete',
  ],
  manager: [
    'users.read',
    'inventory.create', 'inventory.read', 'inventory.update', 'inventory.delete',
    'suppliers.create', 'suppliers.read', 'suppliers.update', 'suppliers.delete',
    'orders.create', 'orders.read', 'orders.update', 'orders.delete',
    'projects.update', 'projects.delete',
    'quality.update',
    'reports.read', 'automation.create', 'automation.delete',
  ],
  // Engineers keep part data (part numbers, BOMs), kits, project progress and
  // quality records up to date.
  engineer: [
    'inventory.create', 'inventory.read', 'inventory.update',
    'projects.update',
    'quality.update',
    'suppliers.read', 'orders.read', 'reports.read',
  ],
  viewer: [
    'inventory.read', 'suppliers.read', 'orders.read', 'reports.read',
  ],
};

const ROLE_ORDER = ['admin', 'manager', 'engineer', 'viewer'];
const PLURAL: Record<string, string> = { admin: 'admins', manager: 'managers', engineer: 'engineers', viewer: 'viewers' };

/** What a permission lets someone do, for messages. */
const DOES: Partial<Record<Permission, string>> = {
  'inventory.update': 'change inventory, prices and part numbers',
  'inventory.delete': 'delete items, kits and stock records',
  'suppliers.update': 'change suppliers',
  'suppliers.delete': 'delete suppliers',
  'orders.update': 'change bookkeeping (customers, quotes, orders, invoices, bills, payments)',
  'orders.delete': 'delete bookkeeping records',
  'projects.update': 'change projects, project progress and production',
  'projects.delete': 'delete projects or production records',
  'quality.update': 'change quality records (inspections, defects, NCRs)',
  'automation.create': 'change automation (rules, scheduled jobs, auto-PO, forecasts)',
  'automation.delete': 'delete automation',
  'settings.update': 'change settings',
};

export function roleCan(role: string | null | undefined, permission: Permission): boolean {
  const r = String(role ?? '').trim().toLowerCase();
  if (r === 'admin') return true;
  return (ROLE_PERMISSIONS[r] ?? []).includes(permission);
}

/** "admins, managers and engineers": the roles that have a permission. */
export function rolesWith(permission: Permission): string {
  const names = ROLE_ORDER.filter((r) => roleCan(r, permission)).map((r) => PLURAL[r]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? 'nobody';
}

/** "Only admins, managers and engineers can change inventory, prices and part numbers." */
export function notAllowedMessage(permission: Permission): string {
  return `Only ${rolesWith(permission)} can ${DOES[permission] ?? `do this (${permission})`}.`;
}

/** The signed-in user's role, as stored at sign-in (browser only). */
export function currentUserRole(): string | null {
  try {
    const raw = localStorage.getItem('currentUser');
    return raw ? String(JSON.parse(raw)?.role ?? '').trim().toLowerCase() || null : null;
  } catch {
    return null;
  }
}

export function currentUserCan(permission: Permission): boolean {
  return roleCan(currentUserRole(), permission);
}
