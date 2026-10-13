// Supplier product links (an item's web links): which supplier a link is
// for and the part numbers in it, and how a product's details fill in an
// item. The lookup itself is POST /api/pricing/link-lookup (pricingRoutes);
// the item form calls it when a link is added and shows a checklist of what
// it can fill in (fillOptions), then applies the ticked lines (applyFill).

export type LinkSupplier = 'lcsc' | 'mouser' | 'digikey';

export interface ProductLink {
  supplier: LinkSupplier;
  /** LCSC's own part number, from an LCSC link. */
  lcscCode?: string;
  /** The manufacturer part number, when the link has it (DigiKey, Mouser). */
  mpn?: string;
  /** The manufacturer as written in the link (DigiKey, Mouser). */
  manufacturer?: string;
  /** Read from another site's link for the same part: JLCPCB's parts are LCSC's. */
  via?: 'jlcpcb';
}

const segment = (s: string) => decodeURIComponent(s).replace(/\+/g, ' ').trim();

/** What a link says about the product, or null when it isn't a product page we know. */
export function parseProductLink(raw: string): ProductLink | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (/(^|\.)lcsc\.com$/.test(host)) {
    // /product-detail/Multilayer-Ceramic-Capacitors-MLCC-SMD-SMT_PSA-FM31X104K251EEG_C365814.html, or /product-detail/C365814.html
    const code = path.match(/(?:^|[/_-])(C\d{2,})(?:\.html)?\/?$/i)?.[1];
    return code ? { supplier: 'lcsc', lcscCode: code.toUpperCase() } : null;
  }
  if (/(^|\.)jlcpcb\.com$/.test(host)) {
    // JLCPCB's parts are LCSC's: /partdetail/<manufacturer>-<mpn>/C1509156 is LCSC part C1509156.
    const code = path.match(/\/partdetail\/(?:[^/]*\/)?(C\d{2,})\/?$/i)?.[1];
    return code ? { supplier: 'lcsc', lcscCode: code.toUpperCase(), via: 'jlcpcb' } : null;
  }
  if (/(^|\.)digikey\.[a-z.]+$/.test(host)) {
    // /en/products/detail/<manufacturer>/<mpn>/<digikey id>
    const m = path.match(/\/products\/detail\/([^/]+)\/([^/]+)/i);
    return m ? { supplier: 'digikey', manufacturer: segment(m[1]).replace(/-/g, ' '), mpn: segment(m[2]) } : null;
  }
  if (/(^|\.)mouser\.[a-z.]+$/.test(host)) {
    // /ProductDetail/<manufacturer>/<mpn>?qs=…, or /ProductDetail/<mouser part number>
    const m = path.match(/\/ProductDetail\/([^/]+)(?:\/([^/]+))?/i);
    if (!m) return null;
    return m[2] ? { supplier: 'mouser', manufacturer: segment(m[1]).replace(/-/g, ' '), mpn: segment(m[2]) } : { supplier: 'mouser', mpn: segment(m[1]) };
  }
  return null;
}

/** Whether a link can be looked up: a supplier's product page, or any other web page. */
export function canLookUp(raw: string): boolean {
  if (parseProductLink(raw)) return true;
  try {
    const url = new URL(raw.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.');
  } catch {
    return false;
  }
}

/** A product's details, as the lookup returns them. Missing ones are null. */
export interface ProductDetails {
  /** 'other': any other shop's page, read by ./pageProduct. */
  supplier: LinkSupplier | 'other';
  supplierName: string;
  supplierPartNumber: string | null;
  manufacturerPartNumber: string | null;
  manufacturer: string | null;
  description: string | null;
  value: string | null;
  tolerance: string | null;
  package: string | null;
  datasheet: string | null;
  /** Other parameters (Voltage Rating, Temperature Coefficient…), for the note. */
  extra: Array<{ name: string; value: string }>;
  /** The supplier's numbers for other packagings of the same part (DigiKey's
   *  cut tape -1-ND, reel -2-ND, Digi-Reel -6-ND): an item with any of them
   *  already has this supplier's number. */
  otherSupplierPartNumbers?: string[];
}

export const SUPPLIER_NAMES: Record<LinkSupplier, string> = { lcsc: 'LCSC', mouser: 'Mouser', digikey: 'DigiKey' };
/** Supplier part-number slot (0-based): 1 Mouser, 2 DigiKey, 3 LCSC. */
const SLOT: Record<LinkSupplier, number> = { mouser: 0, digikey: 1, lcsc: 2 };

/** The item fields the product fills in, as a patch. */
export interface ItemFill {
  description?: string;
  value?: string;
  tolerance?: string;
  packageName?: string;
  size?: string;
  datasheet?: string;
  supplier?: string;
  manPns?: string[];
  supPns?: string[];
  manufacturer?: string;
}

const blank = (v: unknown) => !String(v ?? '').trim() || ['N/A', 'NA', '-', 'GENERIC'].includes(String(v).trim().toUpperCase());

export type FillField = 'description' | 'value' | 'tolerance' | 'packageName' | 'size' | 'datasheet' | 'supplier' | 'manPn' | 'supPn';

/** One line of the checklist: a value the product has for a field. */
export interface FillOption {
  field: FillField;
  label: string;
  value: string;
  /** What the item has there now ('' when empty). */
  current: string;
  /** Ticked to start with: the field is empty. */
  checked: boolean;
  /** For a part number: the slot (0-based) it goes in. */
  slot?: number;
}

type FillItem = {
  description?: string; value?: string; tolerance?: string; packageName?: string; size?: string; datasheet?: string;
  supplier?: string; manPns?: string[]; supPns?: string[];
};

const slots = (list: string[] | undefined) => Array.from({ length: 5 }, (_, i) => String(list?.[i] ?? ''));

/**
 * The checklist for filling an item from a product's details: each value
 * the product has that the item doesn't already have. Empty fields are
 * ticked; a field holding something different is offered unticked (ticking
 * it replaces it). Both part numbers go in that supplier's slot (1 Mouser,
 * 2 DigiKey, 3 LCSC): the manufacturer part number as this supplier lists
 * it in Mfr PN n, its own number in Sup PN n. A supplier number the item
 * already has anywhere isn't offered. Another shop's page fills the "other"
 * slot its link is in (4 or 5; 4 when the link is elsewhere).
 */
export function fillOptions(item: FillItem, d: ProductDetails, linkSlot?: number): FillOption[] {
  const options: FillOption[] = [];
  const slot = d.supplier === 'other' ? (linkSlot === 3 || linkSlot === 4 ? linkSlot : 3) : SLOT[d.supplier];
  const offer = (field: FillField, label: string, value: string | null, current: unknown) => {
    if (!value) return;
    const now = blank(current) ? '' : String(current).trim();
    if (now.toLowerCase() === value.trim().toLowerCase()) return;
    options.push({ field, label, value, current: now, checked: !now, ...(field === 'manPn' || field === 'supPn' ? { slot } : {}) });
  };
  offer('description', 'Description', d.description, item.description);
  offer('value', 'Value', d.value, item.value);
  offer('tolerance', 'Tolerance', d.tolerance, item.tolerance);
  offer('packageName', 'Package', d.package, item.packageName);
  if (d.package && /^\d{4}$/.test(d.package)) offer('size', 'Size', d.package, item.size);
  offer('datasheet', 'Datasheet', d.datasheet, item.datasheet);
  offer('supplier', 'Preferred supplier', d.supplierName, item.supplier);
  const man = slots(item.manPns);
  if (d.manufacturerPartNumber) offer('manPn', `Manufacturer PN (Mfr PN ${slot + 1}, ${d.supplierName})`, d.manufacturerPartNumber, man[slot]);
  const sup = slots(item.supPns);
  const theirs = [d.supplierPartNumber, ...(d.otherSupplierPartNumbers ?? [])].filter(Boolean).map((v) => v!.toUpperCase());
  if (d.supplierPartNumber && !sup.some((v) => theirs.includes(v.trim().toUpperCase()))) {
    offer('supPn', `${d.supplierName} PN (Sup PN ${slot + 1})`, d.supplierPartNumber, sup[slot]);
  }
  return options;
}

/** The item fields to set for the chosen checklist lines. */
export function applyFill(item: FillItem, d: ProductDetails, chosen: FillOption[]): ItemFill {
  const patch: ItemFill = {};
  for (const o of chosen) {
    const slot = o.slot ?? (d.supplier === 'other' ? 3 : SLOT[d.supplier]);
    if (o.field === 'manPn') {
      const man = slots(item.manPns);
      man[slot] = o.value;
      patch.manPns = man;
      if (slot === 0) patch.manufacturer = o.value; // the form keeps it in step with Mfr PN 1
    } else if (o.field === 'supPn') {
      const sup = slots(item.supPns);
      sup[slot] = o.value;
      patch.supPns = sup;
    } else {
      (patch as any)[o.field] = o.value;
    }
  }
  return patch;
}
