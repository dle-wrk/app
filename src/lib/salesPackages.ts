// Sales Builder packages: a named set of lines (inventory items, finished
// products, services, other packages) that is added to a sales order, quote
// or invoice in one go, as normal lines. Prices are in rand, set in the
// package; an optional discount % becomes its own line, one per tax rate so
// VAT stays right. A package inside a package is expanded in place, its
// lines times the quantity it is used at. Routes: ./salesPackagesRoutes.

export const PACKAGE_LINE_KINDS = ['item', 'product', 'service', 'package'] as const;
export type PackageLineKind = typeof PACKAGE_LINE_KINDS[number];

export interface PackageLine {
  kind: PackageLineKind;
  /** SKU (item), model number (product), package id (package); null for a service. */
  ref: string | null;
  description: string;
  quantity: number;
  /** Rand, before tax. Not used for a package line (its own lines are). */
  unitPrice: number;
  taxRateId: number | null;
}

export interface SalesPackage {
  id: number;
  name: string;
  category: string | null;
  tags: string[];
  clientId: number | null;
  discountPct: number;
  notes: string | null;
  active: boolean;
  lines: PackageLine[];
}

/** A line as it goes onto the order. */
export interface ExpandedLine {
  kind: PackageLineKind | 'discount';
  partNumber: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRateId: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const MAX_DEPTH = 8;

export class PackageError extends Error {}

/**
 * The lines one of a package adds (packages inside expanded, discounts as
 * lines). Throws PackageError for a package that contains itself or one
 * that no longer exists.
 */
export function expandPackage(id: number, byId: Map<number, SalesPackage>, stack: number[] = []): ExpandedLine[] {
  const pkg = byId.get(id);
  if (!pkg) throw new PackageError(`Package #${id} no longer exists.`);
  if (stack.includes(id)) throw new PackageError(`"${pkg.name}" contains itself.`);
  if (stack.length >= MAX_DEPTH) throw new PackageError('Packages are nested too deep.');
  const out: ExpandedLine[] = [];
  for (const l of pkg.lines) {
    if (l.kind === 'package') {
      const childId = Number(l.ref);
      for (const c of expandPackage(childId, byId, [...stack, id])) out.push({ ...c, quantity: round4(c.quantity * l.quantity) });
      continue;
    }
    out.push({
      kind: l.kind,
      partNumber: l.kind === 'service' ? null : (l.ref || null),
      description: l.description,
      quantity: l.quantity,
      unitPrice: round2(l.unitPrice),
      taxRateId: l.taxRateId,
    });
  }
  const pct = Number(pkg.discountPct) || 0;
  if (pct > 0) {
    // One discount line per tax rate, so each rate's VAT comes down by the discount.
    const byRate = new Map<string, { taxRateId: number | null; amount: number }>();
    for (const l of out) {
      const k = String(l.taxRateId);
      const e = byRate.get(k) ?? { taxRateId: l.taxRateId, amount: 0 };
      e.amount += l.quantity * l.unitPrice;
      byRate.set(k, e);
    }
    const several = [...byRate.values()].filter((e) => e.amount > 0).length > 1;
    for (const e of byRate.values()) {
      const off = round2((e.amount * pct) / 100);
      if (off <= 0) continue;
      out.push({
        kind: 'discount', partNumber: null, quantity: 1, unitPrice: -off, taxRateId: e.taxRateId,
        description: `${pkg.name} discount (${trimPct(pct)}%)${several ? ' on items at this tax rate' : ''}`,
      });
    }
  }
  return out;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const trimPct = (p: number) => String(Math.round(p * 1000) / 1000);

/** Whether a package with these lines would end up containing itself. */
export function wouldContainItself(id: number | null, lines: PackageLine[], byId: Map<number, SalesPackage>): boolean {
  if (id === null) return false;
  const seen = new Set<number>();
  const reaches = (pid: number): boolean => {
    if (pid === id) return true;
    if (seen.has(pid)) return false;
    seen.add(pid);
    const p = byId.get(pid);
    return !!p && p.lines.some((l) => l.kind === 'package' && reaches(Number(l.ref)));
  };
  return lines.some((l) => l.kind === 'package' && reaches(Number(l.ref)));
}

/** Total before tax, and margin from what the lines cost (cost per unit in rand, null when unknown). */
export function packageTotals(lines: ExpandedLine[], unitCost: (l: ExpandedLine) => number | null) {
  let gross = 0, discount = 0, cost = 0, costKnown = true;
  for (const l of lines) {
    const amount = l.quantity * l.unitPrice;
    if (l.kind === 'discount') { discount += amount; continue; }
    gross += amount;
    if (l.kind === 'service') continue;
    const c = unitCost(l);
    if (c === null) costKnown = false; else cost += c * l.quantity;
  }
  const total = round2(gross + discount);
  return {
    gross: round2(gross), discount: round2(discount), total,
    cost: round2(cost), costKnown,
    marginPct: total > 0 ? Math.round(((total - cost) / total) * 1000) / 10 : null,
  };
}

/** Rand prices in another currency, at a rate in rand per unit of it. */
export function inCurrency(lines: ExpandedLine[], zarPerUnit: number): ExpandedLine[] {
  return lines.map((l) => ({ ...l, unitPrice: round2(l.unitPrice / zarPerUnit) }));
}

/** cost + markup %, as a selling price. */
export const markupPrice = (cost: number, markupPct: number) => round2(cost * (1 + markupPct / 100));
