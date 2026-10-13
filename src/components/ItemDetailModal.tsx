import React, { useState } from 'react';
import { canChange } from '../lib/changeAccess';
import { useEscapeKey } from '../lib/useEscapeKey';
import { Item } from '../types';
import { fmtUSD, fmtZAR, fmtNumber } from '../lib/formatMoney';
import { detectLedSwatch, ledSwatchBackground } from '../lib/ledColor';
import { ITEM_CATEGORIES } from '../lib/itemCategories';
import { SUPPLIER_SLOTS, rightSlotFor } from '../lib/partNumbers';
import { linkSupplier } from '../lib/partAlign';
import { usdToZarRate } from '../lib/usdToZar';
import { applyFill, canLookUp, fillOptions, type FillOption, type ProductDetails } from '../lib/productLink';
import { CategoryCombobox } from './CategoryCombobox';
import {
  X,
  Edit3,
  Save,
  FileText,
  Tag,
  Layers,
  AlertTriangle,
  ExternalLink,
  DollarSign,
  Package,
  Boxes,
  HelpCircle,
  Trash2,
  Truck,
} from 'lucide-react';

// View-mode tab identifiers. Keeping the enum tiny so a new tab is a
// deliberate addition rather than something a copy-paste stumbles into.
type ViewTab = 'OVERVIEW' | 'PARAMETERS' | 'SOURCING';

// Component costs run to sub-cent values (0402 resistors at $0.006, R0.0871),
// so prices carry up to 7 decimal places. The inputs use step="any" to accept
// anything from a whole number up to that precision.
const PRICE_DECIMALS = 7;
const roundTo = (n: number, dp: number) => {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

const IMP_TO_METRIC: Record<string, string> = {
  "01005": "0402",
  "0201": "0603",
  "0402": "1005",
  "0603": "1608",
  "0805": "2012",
  "1206": "3216",
  "1210": "3225",
  "1812": "4532",
  "2010": "5025",
  "2512": "6332",
};

const METRIC_TO_IMP: Record<string, string> = {
  "0402": "01005",
  "0603": "0201",
  "1005": "0402",
  "1608": "0603",
  "2012": "0805",
  "3216": "1206",
  "3225": "1210",
  "4532": "1812",
  "5025": "2010",
  "6332": "2512",
};

export const deriveMetric = (sizeRaw: string | undefined): string => {
  if (!sizeRaw) return "";
  const clean = sizeRaw.trim().toLowerCase();
  if (IMP_TO_METRIC[clean]) return IMP_TO_METRIC[clean];
  const match = clean.match(/\b(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)\b/);
  if (match) {
    return IMP_TO_METRIC[match[1]] || "";
  }
  return "";
};

export const deriveImperial = (sizeMetricRaw: string | undefined): string => {
  if (!sizeMetricRaw) return "";
  const clean = sizeMetricRaw.trim().toLowerCase();
  if (METRIC_TO_IMP[clean]) return METRIC_TO_IMP[clean];
  const match = clean.match(/\b(0402|0603|1005|1608|2012|3216|3225|4532|5025|6332)\b/);
  if (match) {
    return METRIC_TO_IMP[match[1]] || "";
  }
  return "";
};

interface ItemDetailModalProps {
  item: Item;
  onClose: () => void;
  onSave: (updatedItem: Item) => void;
  onDelete?: (item: Item) => void;
  /** Total qty reserved for this part across every OPEN sales order.
   * Fed from the App-level /api/inventory/reservations/summary map.
   * Missing / 0 = the row hides the reserved-vs-available breakdown. */
  reservedQty?: number;
  /** The app's daily USD→ZAR rate, as App has it; a fallback until it loads. */
  liveUsdToZar?: number | null;
}

export default function ItemDetailModal({ item, onClose, onSave, onDelete, reservedQty = 0, liveUsdToZar }: ItemDetailModalProps) {
  const zarRate = usdToZarRate(liveUsdToZar).rate;
  const [isEditing, setIsEditing] = useState(false);
  // Which read-only tab is showing. Defaults to Overview so the headline
  // numbers + description are always the first thing the user sees.
  const [viewTab, setViewTab] = useState<ViewTab>('OVERVIEW');
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Escape closes the nested delete-confirm first (if open), else the
  // whole item modal. The guard on `showDeleteConfirm` means we only
  // bind the outer close listener when the confirm dialog is not open,
  // so one Escape press never fires both.
  useEscapeKey(() => setShowDeleteConfirm(false), showDeleteConfirm);
  useEscapeKey(onClose, !showDeleteConfirm);
  const [deleteReferences, setDeleteReferences] = useState<{ [key: string]: number }>({});
  const [cascadeDelete, setCascadeDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // USD<->ZAR conversion used when one price field derives the other. This was
  // hard-coded to 19, which no longer matches the stored rate (~16.69) and so
  // wrote a wrong figure into whichever field the user was not editing.
  const [usdToZar, setUsdToZar] = useState<number>(zarRate);

  React.useEffect(() => {
    fetch('/api/exchange-rate')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d && Number.isFinite(Number(d.usdToZar)) && Number(d.usdToZar) > 0) setUsdToZar(Number(d.usdToZar)); })
      .catch(() => { /* keep the previous value if the rate is unavailable */ });
  }, []);
  const [checkingReferences, setCheckingReferences] = useState(false);
  const [edited, setEdited] = useState<Item>(() => {
    const enriched = { ...item };
    if (!enriched.sizeMetric && enriched.size) {
      enriched.sizeMetric = deriveMetric(enriched.size);
    }
    if (enriched.bulkPriceZar === undefined || enriched.bulkPriceZar === null || enriched.bulkPriceZar === 0) {
      enriched.bulkPriceZar = enriched.price * zarRate;
    }
    return enriched;
  });

  // Categories come from the shared list in src/lib/itemCategories.ts
  // so the Edit and Add SKU forms never drift. Local state adds any
  // fresh category the operator types via "+ Add" plus whatever the
  // current row already has (in case a legacy row's category isn't in
  // the shared list yet).
  const uniqueCategories = Array.from(new Set([...ITEM_CATEGORIES, item.category].filter(Boolean)));
  const [categories, setCategories] = useState<string[]>(uniqueCategories);
  const [newCategory, setNewCategory] = useState("");

  const handleAddCategory = () => {
    const trimmed = newCategory.trim();
    if (!trimmed) return;
    
    if (!categories.includes(trimmed)) {
      setCategories(prev => [...prev, trimmed]);
    }
    setEdited(prev => ({
      ...prev,
      category: trimmed
    }));
    setNewCategory("");
  };

  // Adding a supplier product link looks the product up and lists what it
  // can fill in, as a checklist (src/lib/productLink.ts): empty fields are
  // ticked, fields holding something else are offered unticked. Nothing is
  // saved until Save, and Undo puts the applied fields back.
  const [linkNotice, setLinkNotice] = useState<null | { text: string; tone: 'ok' | 'info' | 'error'; undo?: Partial<Item> }>(null);
  const [linkChoices, setLinkChoices] = useState<null | { details: ProductDetails; options: FillOption[]; note: string | null }>(null);
  const lookedUp = React.useRef(new Set<string>());
  // A link is looked up once when typed or pasted; the Fill button next to
  // a link already there (force) looks it up again.
  const lookupLink = async (raw: string | undefined, slot: number, force = false) => {
    const url = String(raw ?? '').trim();
    if (!url || (!force && lookedUp.current.has(url)) || !canLookUp(url)) return;
    lookedUp.current.add(url);
    setLinkChoices(null);
    setLinkNotice({ text: 'Looking the product up…', tone: 'info' });
    try {
      const res = await fetch('/api/pricing/link-lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setLinkNotice({ text: data.error || 'The lookup failed.', tone: 'error' }); return; }
      const details: ProductDetails | null = data.details;
      if (!details) { setLinkNotice({ text: data.note || 'Nothing found for that link.', tone: 'info' }); return; }
      const options = fillOptions(editedRef.current, details, slot);
      if (!options.length) {
        setLinkNotice({ text: `${details.supplierName}: nothing new, the item already has everything it lists.${data.note ? ` ${data.note}` : ''}`, tone: 'info' });
        return;
      }
      setLinkNotice(null);
      setLinkChoices({ details, options, note: data.note ?? null });
    } catch (err: any) {
      setLinkNotice({ text: `The lookup failed: ${err?.message || err}`, tone: 'error' });
    }
  };
  const editedRef = React.useRef(edited);
  editedRef.current = edited;
  const toggleChoice = (index: number) => setLinkChoices(c => c && ({ ...c, options: c.options.map((o, i) => (i === index ? { ...o, checked: !o.checked } : o)) }));
  const applyChoices = () => {
    if (!linkChoices) return;
    const chosen = linkChoices.options.filter(o => o.checked);
    const patch = applyFill(editedRef.current, linkChoices.details, chosen);
    const undo = Object.fromEntries(Object.keys(patch).map(k => [k, (editedRef.current as any)[k]])) as Partial<Item>;
    setEdited(prev => ({ ...prev, ...patch }));
    setLinkChoices(null);
    setLinkNotice({ text: `Filled from ${linkChoices.details.supplierName}: ${chosen.map(o => o.label).join(', ')}. Save to keep it.`, tone: 'ok', undo });
  };
  const undoLinkFill = () => {
    const undo = linkNotice?.undo;
    if (undo) setEdited(prev => ({ ...prev, ...undo }));
    setLinkNotice(null);
  };

  // Swaps two supplier part-number slots, so a number typed into the wrong
  // supplier's slot moves to its own and nothing is lost.
  const moveSupplierPn = (from: number, to: number) => {
    setEdited(prev => {
      const arr = [...(prev.supPns || [])];
      while (arr.length < 5) arr.push('');
      [arr[from], arr[to]] = [arr[to], arr[from]];
      return { ...prev, supPns: arr };
    });
  };

  // The same for web links: a supplier's page moves to that supplier's slot.
  const moveWebLink = (from: number, to: number) => {
    setEdited(prev => {
      const arr = [...(prev.weblinks || [])];
      while (arr.length < 5) arr.push('');
      [arr[from], arr[to]] = [arr[to], arr[from]];
      return { ...prev, weblinks: arr };
    });
  };

  // Handle change for basic text / select inputs
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    let finalValue: any = value;
    if (type === 'number') {
      finalValue = Number(value) || 0;
    }

    // Handle array fields (manPns, supPns, weblinks)
    if (name.startsWith('manPns_') || name.startsWith('supPns_') || name.startsWith('weblinks_')) {
      const [field, indexStr] = name.split('_');
      const index = parseInt(indexStr, 10);

      setEdited(prev => {
        const fieldKey = field as 'manPns' | 'supPns' | 'weblinks';
        const arr = [...(prev[fieldKey] || [])];
        // Ensure array is long enough
        while (arr.length <= index) arr.push('');
        arr[index] = value;

        const next = { ...prev, [fieldKey]: arr };
        // Sync with primary fields if it's the first element. (Not the
        // supplier: it has its own field, and a part number isn't a supplier.)
        if (field === 'manPns' && index === 0) next.manufacturer = value;
        return next;
      });
      return;
    }

    setEdited(prev => {
      const updated = { ...prev, [name]: finalValue };

      if (name === 'category') {
        updated.itemType = value;
      }

      if (name === 'manufacturer') {
        const arr = [...(prev.manPns || [])];
        if (arr.length === 0) arr.push(value);
        else arr[0] = value;
        updated.manPns = arr;
      }

      
      if (name === 'size') {
        const derived = deriveMetric(value);
        if (derived) {
          updated.sizeMetric = derived;
        }
      } else if (name === 'sizeMetric') {
        const derived = deriveImperial(value);
        if (derived) {
          updated.size = derived;
        }
      } else if (name === 'price') {
        // Round to 7 dp, not 5: the field accepts up to 7 decimals, so rounding
        // the derived value tighter than that silently discards what was typed.
        updated.bulkPriceZar = roundTo(finalValue * usdToZar, PRICE_DECIMALS);
      } else if (name === 'priceZar') {
        const zarVal = Number(value) || 0;
        updated.price = roundTo(zarVal / usdToZar, PRICE_DECIMALS);
        updated.bulkPriceZar = zarVal;
      }
      
      return updated;
    });
  };

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, checked } = e.target;
    setEdited(prev => ({
      ...prev,
      [name]: checked
    }));
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(edited);
    setIsEditing(false);
  };

  const handleDeleteClick = async () => {
    setCheckingReferences(true);
    setDeleteError(null);
    try {
      const response = await fetch(`/api/items/${item.partNumber}/references`);
      if (response.ok) {
        const data = await response.json();
        setDeleteReferences(data.references || {});
        setCascadeDelete(false);
      }
    } catch (error) {
      console.error('Error checking references:', error);
    } finally {
      setCheckingReferences(false);
      setShowDeleteConfirm(true);
    }
  };

  const handleConfirmDelete = async () => {
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/items/${item.partNumber}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cascadeDelete }),
      });

      if (!response.ok) {
        throw new Error('Failed to delete item');
      }

      // Close before handing off: onDelete triggers the parent's refetch, and
      // any state we set after unmount is a no-op React warns about.
      setIsDeleting(false);
      setShowDeleteConfirm(false);
      onClose();
      if (onDelete) {
        onDelete(item);
      }
    } catch (error) {
      console.error('Error deleting item:', error);
      setIsDeleting(false);
      setShowDeleteConfirm(false);
      setDeleteError(error instanceof Error ? error.message : 'Failed to delete item. Please try again.');
    }
  };

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-110 p-md">
      <div className="bg-surface-container rounded-xl border border-outline-variant max-w-[768px] w-full max-h-[calc(90vh/var(--app-zoom,1))] flex flex-col shadow-2xl relative animate-in fade-in duration-200">
        
        {/* Header toolbar */}
        <div className="px-lg py-md border-b border-outline-variant/60 flex items-center justify-between bg-surface-container-high/40 shrink-0">
          <div className="space-y-0.5">
            <span className="font-mono text-[10px] text-primary uppercase font-extrabold tracking-wider bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded">
              SKU: {item.partNumber}
            </span>
            <h3 className="font-bold text-base text-on-surface select-none pr-8 flex items-center gap-2">
              {(() => {
                if (isEditing) return <>Edit SKU {item.partNumber}</>;
                const led = detectLedSwatch(item);
                if (!led) return <>{item.name}</>;
                return (
                  <>
                    <span
                      className="inline-block w-4 h-4 rounded-full border border-outline-variant/60 shadow-inner shrink-0"
                      style={{ background: ledSwatchBackground(led) }}
                      title={`LED colour: ${led.label}`}
                    />
                    <span>{item.name}</span>
                    <span className="text-[10px] font-bold text-outline uppercase tracking-wider">· {led.label}</span>
                  </>
                );
              })()}
            </h3>
          </div>

          <div className="flex items-center gap-2">
            {!isEditing ? (
              <>
                {canChange('/api/items', 'PUT') && (
                <button
                  onClick={() => setIsEditing(true)}
                  className="bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 px-md py-1.5 rounded-lg text-xs font-bold transition-all duration-150 flex items-center gap-1"
                  type="button"
                  id="btn-edit-item"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  Edit Parameters
                </button>
                )}

                {canChange('/api/items', 'DELETE') && (
                <button
                  onClick={handleDeleteClick}
                  disabled={isDeleting || checkingReferences}
                  className="bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/30 px-md py-1.5 rounded-lg text-xs font-bold transition-all duration-150 flex items-center gap-1 disabled:opacity-50"
                  type="button"
                  id="btn-delete-item"
                  title="Delete this item"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </button>
                )}
              </>
            ) : null}

            <button
              onClick={onClose}
              className="text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high p-1.5 rounded-lg transition-colors border border-transparent hover:border-outline-variant"
              type="button"
              aria-label="Close item details modal"
              id="btn-close-detail-modal"
            >
              <X className="w-5 h-5" aria-label="Close" />
            </button>
          </div>
        </div>

        {/* Modal content body container with scroll */}
        <div className="flex-1 overflow-y-auto p-lg">
          <form id="item-detail-form" onSubmit={handleSave} className="space-y-lg">
            
            {/* View Mode */}
            {!isEditing ? (
              <div className="space-y-lg">
                {/* Highlight parameters row */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-md pb-md border-b border-outline-variant/40">
                  <div className="bg-surface-container-high/40 p-sm rounded-lg border border-outline-variant/50">
                    <span className="text-[10px] text-outline font-label-caps uppercase block mb-1">Stock Level</span>
                    <span className={`text-base font-black font-mono ${item.stockLevel < (item.lowStockLvl || 50) ? 'text-tertiary font-extrabold' : 'text-on-surface'}`}>
                      {fmtNumber(item.stockLevel)} units
                    </span>
                    {item.stockLevel < (item.lowStockLvl || 50) && (
                      <span className="text-[9px] text-tertiary flex items-center gap-0.5 mt-0.5 font-bold">
                        <AlertTriangle className="w-2.5 h-2.5 shrink-0" /> Low Stock
                      </span>
                    )}
                    {reservedQty > 0 && (() => {
                      const available = (item.stockLevel ?? 0) - reservedQty;
                      if (available < 0) {
                        return (
                          <span
                            className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold border bg-error/10 text-error border-error/30 whitespace-nowrap"
                            title="Reservations from open sales orders exceed the physical stock on hand."
                          >
                            <AlertTriangle className="w-2.5 h-2.5 shrink-0" /> OVERBOOKED · short {fmtNumber(-available)}
                          </span>
                        );
                      }
                      return (
                        <div
                          className="mt-1 text-[10px] font-mono text-outline leading-tight"
                          title="Reserved by open sales orders — released when the SO is invoiced with deduct-stock or the delivery-note is completed."
                        >
                          <div>{fmtNumber(reservedQty)} reserved</div>
                          <div className="text-on-surface-variant font-bold">{fmtNumber(available)} available</div>
                        </div>
                      );
                    })()}
                  </div>

                  <div className="bg-surface-container-high/40 p-sm rounded-lg border border-outline-variant/50">
                    <span className="text-[10px] text-outline font-label-caps uppercase block mb-1">Standard Cost</span>
                    <div className="flex flex-col">
                      <span className="text-base font-black font-mono text-green-400 leading-none">
                        {fmtUSD(item.price, 3)}
                      </span>
                      <span className="text-[10px] font-mono text-outline mt-1 block">
                        {fmtZAR(item.bulkPriceZar || item.price * zarRate, 3)} ZAR
                      </span>
                    </div>
                  </div>

                  <div className="bg-surface-container-high/40 p-sm rounded-lg border border-outline-variant/50">
                    <span className="text-[10px] text-outline font-label-caps uppercase block mb-1">Total Holding Value</span>
                    <div className="flex flex-col">
                      <span className="text-base font-black font-mono text-primary leading-none">
                        {fmtUSD(item.price * item.stockLevel)}
                      </span>
                      <span className="text-[10px] font-mono text-outline mt-1 block">
                        {fmtZAR((item.bulkPriceZar || item.price * zarRate) * item.stockLevel)} ZAR
                      </span>
                    </div>
                  </div>

                  <div className="bg-surface-container-high/40 p-sm rounded-lg border border-outline-variant/50">
                    <span className="text-[10px] text-outline font-label-caps uppercase block mb-1">Status</span>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 mt-0.5 rounded text-[9px] font-bold font-mono border ${
                      item.status === 'ACTIVE' ? 'bg-green-500/10 text-green-400 border-green-500/20' : 
                      item.status === 'DO NOT USE' ? 'bg-error text-white border-error' :
                      item.status === 'INACTIVE' ? 'bg-red-500/10 text-red-500 border-red-500/20' : 
                      item.status === 'BOOKED OUT' ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20' :
                      'bg-outline-variant/10 text-outline border-outline-variant/20'
                    }`}>
                      {item.status}
                    </span>
                  </div>

                  <div className="bg-surface-container-high/40 p-sm rounded-lg border border-outline-variant/50">
                    <span className="text-[10px] text-outline font-label-caps uppercase block mb-1">Category</span>
                    <span className="text-xs font-bold text-on-surface truncate block mt-0.5">
                      {item.category}
                    </span>
                  </div>
                </div>

                {/* View-mode tab strip. Sits below the always-visible
                    highlight row so the top-of-modal numbers stay put as
                    the user flips between what-this-part-is (Overview),
                    what-it-physically-is (Parameters), and where-it-comes-
                    from (Sourcing). Keeps the initial paint focused. */}
                <div className="flex gap-1 border-b border-outline-variant/30">
                  {([
                    { key: 'OVERVIEW' as const, label: 'Overview', icon: <FileText className="w-3.5 h-3.5" /> },
                    { key: 'PARAMETERS' as const, label: 'Parameters', icon: <Layers className="w-3.5 h-3.5" /> },
                    { key: 'SOURCING' as const, label: 'Sourcing', icon: <Truck className="w-3.5 h-3.5" /> },
                  ]).map(t => (
                    <button
                      key={t.key}
                      onClick={() => setViewTab(t.key)}
                      className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold whitespace-nowrap transition-all border-b-2 ${viewTab === t.key ? 'text-primary border-primary' : 'text-on-surface-variant border-transparent hover:text-on-surface'}`}
                    >
                      {t.icon}{t.label}
                    </button>
                  ))}
                </div>

                {viewTab === 'OVERVIEW' && (<>
                {/* Primary Descriptions */}
                <div className="space-y-sm">
                  <h4 className="font-mono text-xs uppercase font-extrabold tracking-wider text-primary flex items-center gap-1">
                    <FileText className="w-4 h-4" /> Description & Sourcing
                  </h4>
                  <div className="bg-surface-container-high/20 border border-outline-variant/40 rounded-xl p-md space-y-sm text-xs leading-relaxed">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-md">
                      <div>
                        <span className="text-[10px] text-outline block">Official Comment / Label</span>
                        <p className="text-on-surface font-semibold text-sm">{item.name}</p>
                      </div>
                      <div>
                        <span className="text-[10px] text-outline block">Project Association</span>
                        <p className="font-semibold text-sm text-primary">{item.project || 'Unassigned'}</p>
                      </div>
                    </div>
                    <div>
                      <span className="text-[10px] text-outline block">Technical Specifications description</span>
                      <p className="text-on-surface-variant">{item.description || 'No detailed technical explanation provided.'}</p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-md pt-sm border-t border-outline-variant/30">
                      <div>
                        <span className="text-[10px] text-outline block">Manufacturer</span>
                        <p className="text-on-surface font-medium">{item.manufacturer || 'N/A'}</p>
                      </div>
                      <div>
                        <span className="text-[10px] text-outline block">Sourcing Preferred Supplier</span>
                        <p className="text-on-surface font-medium">{item.supplier || 'N/A'}</p>
                      </div>
                    </div>

                    {item.comment && (
                      <div className="pt-sm border-t border-outline-variant/30">
                        <span className="text-[10px] text-outline block">Internal Comment</span>
                        <p className="text-on-surface-variant italic">"{item.comment}"</p>
                      </div>
                    )}
                  </div>
                </div>

                </>)}

                {viewTab === 'PARAMETERS' && (<>
                {/* Parameter details table */}
                <div className="space-y-sm">
                  <h4 className="font-mono text-xs uppercase font-extrabold tracking-wider text-primary flex items-center gap-1">
                    <Layers className="w-4 h-4" /> CAD & Component Parameters
                  </h4>
                  
                  <div className="bg-surface-container rounded-xl border border-outline-variant/60 overflow-hidden">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-outline-variant/40 text-xs">
                      
                      <div className="p-md space-y-md">
                        <div className="flex justify-between items-center pb-sm border-b border-outline-variant/20">
                          <span className="text-outline">Value:</span>
                          <span className="font-mono font-bold text-on-surface">{item.value || 'N/A'}</span>
                        </div>
                        <div className="flex justify-between items-center pb-sm border-b border-outline-variant/20">
                          <span className="text-outline">Size (Imperial):</span>
                          <span className="font-mono font-bold text-on-surface">{item.size || 'N/A'}</span>
                        </div>
                        <div className="flex justify-between items-center pb-sm border-b border-outline-variant/20">
                          <span className="text-outline">Size (Metric):</span>
                          <span className="font-mono font-bold text-on-surface">{item.sizeMetric || deriveMetric(item.size) || 'N/A'}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-outline">Footprint (CAD):</span>
                          <span className="font-mono font-bold text-on-surface">{item.footprint || 'N/A'}</span>
                        </div>
                      </div>

                      <div className="p-md space-y-md">
                        <div className="flex justify-between items-center pb-sm border-b border-outline-variant/20">
                          <span className="text-outline">Package Name:</span>
                          <span className="font-mono font-bold text-on-surface">{item.packageName || 'N/A'}</span>
                        </div>
                        <div className="flex justify-between items-center pb-sm border-b border-outline-variant/20">
                          <span className="text-outline">Tolerance:</span>
                          <span className="font-mono font-bold text-on-surface">{item.tolerance || 'N/A'}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-outline">Item Type:</span>
                          <span className="font-mono text-on-surface-variant font-semibold">{item.itemType || 'N/A'}</span>
                        </div>
                      </div>

                      <div className="p-md space-y-md">
                        <div className="flex justify-between items-center pb-sm border-b border-outline-variant/20">
                          <span className="text-outline">Trigger Threshold:</span>
                          <span className="font-mono font-semibold text-tertiary">{item.lowStockLvl || 50} units</span>
                        </div>
                        <div className="flex justify-between items-center pb-sm border-b border-outline-variant/20">
                          <span className="text-outline">Bulk Rate (USD):</span>
                          <span className="font-mono font-semibold text-green-400">{fmtUSD(item.bulkPriceUsd || item.price, 3)}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-outline">Bulk Rate (ZAR):</span>
                          <span className="font-mono font-semibold text-green-400">{fmtZAR(item.bulkPriceZar || item.price * zarRate)}</span>
                        </div>
                      </div>

                    </div>
                  </div>
                </div>

                </>)}

                {viewTab === 'SOURCING' && (<>
                {/* Additional sourcing metrics */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-md pt-xs">
                  <div className="p-md rounded-xl bg-surface-container-high/30 border border-outline-variant/40 space-y-1.5 text-xs">
                    <span className="font-mono text-[10px] text-outline uppercase font-black tracking-wide block">Order & Packaging</span>
                    <div className="flex justify-between">
                      <span className="text-outline">Packaging Type:</span>
                      <span className="font-mono font-semibold">{item.packaging || 'Standard'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-outline">Last Refill Quantity:</span>
                      <span className="font-mono font-semibold">{item.lastOrderQty ? `${fmtNumber(item.lastOrderQty)} units` : 'Unknown'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-outline">Last Ordered Date:</span>
                      <span className="font-mono font-semibold">{item.lastOrderDate || 'No record'}</span>
                    </div>
                  </div>

                  <div className="p-md rounded-xl bg-surface-container-high/30 border border-outline-variant/40 space-y-1.5 text-xs flex flex-col justify-between">
                    <div>
                      <span className="font-mono text-[10px] text-outline uppercase font-black tracking-wide block">Datasheet Reference Link</span>
                      {item.datasheet ? (
                        <a 
                          href={item.datasheet} 
                          target="_blank" 
                          rel="noreferrer" 
                          referrerPolicy="no-referrer"
                          className="mt-1 text-primary hover:underline flex items-center gap-1 font-mono text-[11px] truncate"
                        >
                          <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                          View CAD Library PDF Datasheet
                        </a>
                      ) : (
                        <span className="text-[#8c909f] block italic mt-1">No file attached to this component reference.</span>
                      )}
                    </div>
                  </div>
                </div>
                </>)}
              </div>
            ) : (
              /* 编辑模式 */
              <div className="space-y-lg text-xs">
                <div className="bg-primary/5 border border-primary/20 p-md rounded-lg mb-md leading-relaxed text-primary">
                  <strong>Notice:</strong> Modifying stock codes, descriptions, and footprint values will propagate instantly. Ensure adjustments align with direct engineering schemas.
                </div>

                {/* Basic Details */}
                <div className="space-y-sm">
                  <h4 className="font-mono text-xs uppercase font-extrabold tracking-wider text-primary">Primary Specifications</h4>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-sm">
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Component name / Comment</label>
                      <input 
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary" 
                        type="text" 
                        name="name"
                        title="Component name or official comment"
                        value={edited.name}
                        onChange={handleChange}
                        required
                      />
                    </div>

                     <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Preferred Sourcing Category</label>
                      {/* Same combobox the Add SKU form uses — start
                          typing to filter, hit Enter (or click "Add
                          '<typed>' as new category") to commit any
                          fresh value. Extras come from `categories`
                          which already includes whatever the current
                          row has stamped. */}
                      <CategoryCombobox
                        value={edited.category || ''}
                        onChange={(v) => {
                          setEdited(prev => ({ ...prev, category: v }));
                          if (v && !categories.some(c => c.toLowerCase() === v.toLowerCase())) {
                            setCategories(prev => [...prev, v]);
                          }
                        }}
                        extraOptions={categories}
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="font-bold text-outline">Technical Description</label>
                    <textarea 
                      rows={2}
                      className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary leading-normal font-sans" 
                      name="description"
                      value={edited.description}
                      onChange={handleChange}
                      title="Detailed technical specifications or notes about the component"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-sm">
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Manufacturer (Primary)</label>
                      <input 
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono" 
                        type="text" 
                        name="manufacturer"
                        value={edited.manufacturer}
                        onChange={handleChange}
                        title="Original component manufacturer, if known"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Preferred Sourcing Vendor (Supplier)</label>
                      <input 
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono" 
                        type="text" 
                        name="supplier"
                        value={edited.supplier || ''}
                        onChange={handleChange}
                        title="Preferred supplier or vendor for sourcing this component"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-sm">
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Project Association</label>
                      <input
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono"
                        type="text"
                        name="project"
                        value={edited.project || ''}
                        onChange={handleChange}
                        title="Associated project for this component"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Packaging Type</label>
                      <input
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono"
                        type="text"
                        name="packaging"
                        value={edited.packaging || ''}
                        onChange={handleChange}
                        title="Component packaging (e.g. Cut Tape, Reel, Box)"
                      />
                    </div>
                    {/* Colour marker — mainly for LEDs, but any SKU
                        that carries a colour value renders it in the
                        audit and BOM Manager views. Free-text so RGB
                        / Bi-colour / dual-die etc. can be typed in
                        as-is; empty saves as null. */}
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">
                        Colour
                        {String(edited.partNumber || '').toUpperCase().startsWith('LED') && (
                          <span className="ml-2 text-[10px] text-primary font-mono normal-case tracking-normal">LED — recommended</span>
                        )}
                      </label>
                      <input
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono"
                        type="text"
                        name="color"
                        value={edited.color || ''}
                        onChange={handleChange}
                        placeholder="e.g. Red, Green, Blue, RGB, Yellow-Green"
                        title="Free-text colour marker — shown on P&P Kit Booking + BOM Manager"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Internal Comment</label>
                      <input
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono"
                        type="text"
                        name="comment"
                        value={edited.comment || ''}
                        onChange={handleChange}
                        title="Additional internal notes or comments"
                      />
                    </div>
                  </div>
                </div>

                {/* Alternate PNs and Links */}
                <div className="space-y-sm">
                  <h4 className="font-mono text-xs uppercase font-extrabold tracking-wider text-primary">Alternate Manufacturer & Supplier PNs</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-md">
                    <div className="space-y-2">
                      <label className="font-bold text-outline block text-[10px] uppercase">Manufacturer Part Numbers (1-5)</label>
                      <p className="text-[10px] text-outline -mt-1">The component's part number as each supplier lists it, in the same slots: 1 Mouser, 2 DigiKey, 3 LCSC, 4-5 others. N/A where a supplier doesn't have it.</p>
                      <div className="grid grid-cols-1 gap-1.5">
                        {SUPPLIER_SLOTS.map((slot, i) => (
                          <div key={`manPns_${i}`} className="flex items-center gap-1.5">
                            <span className={`w-16 shrink-0 text-[10px] font-bold ${slot.supplier ? 'text-primary' : 'text-outline'}`}>{i + 1}. {slot.label}</span>
                            <input
                              name={`manPns_${i}`}
                              aria-label={`Manufacturer part number ${i + 1} (${slot.label})`}
                              value={edited.manPns?.[i] || ''}
                              onChange={handleChange}
                              placeholder={slot.supplier ? `Part number at ${slot.label}` : 'Other part number'}
                              className="w-full bg-surface-container-high border border-outline-variant rounded px-2 py-1.5 text-on-surface outline-none focus:border-primary font-mono"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label className="font-bold text-outline block text-[10px] uppercase">Supplier Part Numbers (1-5)</label>
                      <p className="text-[10px] text-outline -mt-1">Each slot is one supplier's, so BOM downloads can be filtered by supplier: 1 Mouser, 2 DigiKey, 3 LCSC, 4-5 others.</p>
                      <div className="grid grid-cols-1 gap-1.5">
                        {SUPPLIER_SLOTS.map((slot, i) => {
                          const value = edited.supPns?.[i] || '';
                          const right = value ? rightSlotFor(value, i) : null;
                          return (
                            <div key={`supPns_${i}`}>
                              <div className="flex items-center gap-1.5">
                                <span className={`w-16 shrink-0 text-[10px] font-bold ${slot.supplier ? 'text-primary' : 'text-outline'}`}>{i + 1}. {slot.label}</span>
                                <input
                                  name={`supPns_${i}`}
                                  aria-label={`Supplier part number ${i + 1} (${slot.label})`}
                                  value={value}
                                  onChange={handleChange}
                                  placeholder={slot.supplier ? `${slot.label} part number` : 'Other supplier part number'}
                                  className={`w-full bg-surface-container-high border rounded px-2 py-1.5 text-on-surface outline-none focus:border-primary font-mono ${right !== null ? 'border-amber-500/60' : 'border-outline-variant'}`}
                                />
                              </div>
                              {right !== null && (
                                <div className="ml-[4.4rem] mt-0.5 text-[10px] text-amber-500 flex items-center gap-1.5">
                                  Looks like a {SUPPLIER_SLOTS[right].label} number.
                                  <button type="button" onClick={() => moveSupplierPn(i, right)} className="font-bold underline hover:text-on-surface">
                                    Move to {right + 1}. {SUPPLIER_SLOTS[right].label}
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="font-bold text-outline block text-[10px] uppercase">External Web Links (1-5)</label>
                    <p className="text-[10px] text-outline -mt-1">Same slots: 1 Mouser, 2 DigiKey, 3 LCSC, 4-5 others. Add a product link (LCSC, Mouser, DigiKey or any other shop) to choose what to fill in from it.</p>
                    {linkNotice && (
                      <div role="status" data-testid="link-notice" className={`rounded border px-2 py-1.5 text-[11px] flex items-start justify-between gap-2 ${
                        linkNotice.tone === 'ok' ? 'border-green-500/30 bg-green-500/10 text-green-400' : linkNotice.tone === 'error' ? 'border-error/30 bg-error/10 text-error' : 'border-outline-variant bg-surface-container-high text-on-surface-variant'}`}>
                        <span>{linkNotice.text}</span>
                        {linkNotice.undo && <button type="button" onClick={undoLinkFill} className="font-bold underline shrink-0">Undo</button>}
                      </div>
                    )}
                    {linkChoices && (
                      <div data-testid="link-choices" className="rounded border border-primary/30 bg-primary/5 p-2 space-y-1.5 text-[11px]">
                        <div className="font-bold text-on-surface">
                          From {linkChoices.details.supplierName}{linkChoices.details.supplierPartNumber ? ` (${linkChoices.details.supplierPartNumber})` : ''}: tick what to fill in
                        </div>
                        <ul className="space-y-1">
                          {linkChoices.options.map((o, i) => (
                            <li key={o.field}>
                              <label className="flex items-start gap-2 cursor-pointer">
                                <input type="checkbox" className="mt-0.5" checked={o.checked} onChange={() => toggleChoice(i)} aria-label={`Fill ${o.label}`} />
                                <span className="min-w-0">
                                  <span className="font-bold text-on-surface">{o.label}: </span>
                                  <span className="font-mono break-all">{o.value}</span>
                                  {o.current && <span className="block text-amber-500">Replaces {o.current}</span>}
                                </span>
                              </label>
                            </li>
                          ))}
                        </ul>
                        {(linkChoices.details.extra.length > 0 || linkChoices.note) && (
                          <p className="text-outline">
                            {linkChoices.details.extra.length > 0 && `Also listed: ${linkChoices.details.extra.slice(0, 6).map(e => `${e.name} ${e.value}`).join(', ')}. `}
                            {linkChoices.note}
                          </p>
                        )}
                        <div className="flex justify-end gap-2">
                          <button type="button" onClick={() => setLinkChoices(null)} className="px-2 py-1 rounded border border-outline-variant text-on-surface-variant hover:text-on-surface">Dismiss</button>
                          <button type="button" onClick={applyChoices} disabled={!linkChoices.options.some(o => o.checked)} className="px-2 py-1 rounded bg-primary text-white font-bold disabled:opacity-40">
                            Fill {linkChoices.options.filter(o => o.checked).length} selected
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-sm">
                      {SUPPLIER_SLOTS.map((slot, i) => {
                        const value = edited.weblinks?.[i] || '';
                        const whose = linkSupplier(value);
                        const right = whose && whose !== 'other' ? SUPPLIER_SLOTS.findIndex((x) => x.supplier === whose) : -1;
                        return (
                          <div key={`weblinks_${i}`}>
                            <div className="flex items-center gap-1.5">
                              <span className={`w-16 shrink-0 text-[10px] font-bold ${slot.supplier ? 'text-primary' : 'text-outline'}`}>{i + 1}. {slot.label}</span>
                              <input
                                name={`weblinks_${i}`}
                                aria-label={`Web link ${i + 1} (${slot.label})`}
                                value={value}
                                onChange={handleChange}
                                onBlur={(e) => void lookupLink(e.currentTarget.value, i)}
                                onPaste={(e) => { const input = e.currentTarget; setTimeout(() => void lookupLink(input.value, i), 0); }}
                                placeholder={slot.supplier ? `${slot.label} product link` : 'Other link'}
                                className={`w-full bg-surface-container-high border rounded px-2 py-1.5 text-on-surface outline-none focus:border-primary font-mono ${right >= 0 && right !== i ? 'border-amber-500/60' : 'border-outline-variant'}`}
                              />
                              {canLookUp(value) && (
                                <button type="button" onClick={() => void lookupLink(value, i, true)} aria-label={`Fill from web link ${i + 1}`}
                                  title="Look this product up and choose what to fill in from it"
                                  className="shrink-0 px-2 py-1.5 rounded border border-primary/40 text-primary text-[10px] font-bold hover:bg-primary/10">
                                  Fill
                                </button>
                              )}
                            </div>
                            {right >= 0 && right !== i && (
                              <div className="ml-[4.4rem] mt-0.5 text-[10px] text-amber-500 flex items-center gap-1.5">
                                A {SUPPLIER_SLOTS[right].label} link.
                                <button type="button" onClick={() => moveWebLink(i, right)} className="font-bold underline hover:text-on-surface">
                                  Move to {right + 1}. {SUPPLIER_SLOTS[right].label}
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Quantitative metrics */}
                <div className="space-y-sm">
                  <h4 className="font-mono text-xs uppercase font-extrabold tracking-wider text-primary">Quantitative Parameters & Financials</h4>
                  
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-sm">
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Current stock count</label>
                      <input 
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono" 
                        type="number" 
                        name="stockLevel"
                        min="0"
                        value={edited.stockLevel}
                        onChange={handleChange}
                        title="Current quantity of this component in stock. Adjusting this will affect inventory levels immediately."
                        required
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Low stock limit</label>
                      <input 
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono" 
                        type="number" 
                        name="lowStockLvl"
                        min="0"
                        value={edited.lowStockLvl || 50}
                        onChange={handleChange}
                        title="Threshold for low stock warning. When current stock falls below this level, it will be highlighted as low stock."
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Standard cost $USD each</label>
                      <input 
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono" 
                        type="number"
                        name="price"
                        // step="any" accepts any number of decimals, 0 through 7+.
                        // A fixed step (was 0.0001) made the browser reject
                        // sub-step values outright: 144.0029 against step 0.001
                        // errored with "nearest valid values are 144.002 and
                        // 144.003". Component costs are genuinely sub-cent
                        // (resistors at $0.006), so the precision is needed.
                        step="any"
                        min="0"
                        value={edited.price}
                        onChange={handleChange}
                        required
                        title="Standard cost per unit in USD. This is used for financial calculations and can be adjusted based on supplier quotes or market changes."
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">standard cost ZAR each</label>
                      <input 
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono" 
                        type="number"
                        name="priceZar"
                        step="any"
                        min="0"
                        title="Standard cost per unit in ZAR. This is used for financial calculations and can be adjusted based on supplier quotes or market changes."
                        value={edited.bulkPriceZar !== undefined
                          ? roundTo(edited.bulkPriceZar, PRICE_DECIMALS)
                          : roundTo(edited.price * usdToZar, PRICE_DECIMALS)}
                        onChange={handleChange}
                        required
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Last Order Qty</label>
                      <input
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono"
                        type="number"
                        name="lastOrderQty"
                        value={edited.lastOrderQty || 0}
                        onChange={handleChange}
                        title="Quantity ordered in the last procurement cycle"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Last Order Date</label>
                      <input
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono"
                        type="text"
                        name="lastOrderDate"
                        placeholder="YYYY-MM-DD"
                        value={edited.lastOrderDate || ''}
                        onChange={handleChange}
                        title="Date of the last procurement order"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Status Code</label>
                      <select aria-label="Selection"
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono" 
                        name="status"
                        value={edited.status}
                        onChange={handleChange}
                        title="Current status of the component. Changing this will affect how the item is categorized in inventory views and reports."
                      >
                        <option value="ACTIVE">ACTIVE</option>
                        <option value="INACTIVE">INACTIVE</option>
                        <option value="BOOKED OUT">BOOKED OUT</option>
                        <option value="DISCONTINUED">DISCONTINUED</option>
                        <option value="DO NOT USE">DO NOT USE</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* Technical Specifications details */}
                <div className="space-y-sm">
                  <h4 className="font-mono text-xs uppercase font-extrabold tracking-wider text-primary">Technical Specs & CAD Footprints</h4>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-sm">
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Value (e.g. 10uF, 47k)</label>
                      <input 
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono" 
                        type="text" 
                        name="value"
                        value={edited.value || ''}
                        onChange={handleChange}
                        title='Primary value or rating of the component. For resistors, this would be resistance (e.g. "47k"). For capacitors, this would be capacitance (e.g. "10uF"). For ICs, this could be a key specification like "ATmega328P".'
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Size (Imperial)</label>
                      <input 
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono" 
                        type="text" 
                        name="size"
                        value={edited.size || ''}
                        onChange={handleChange}
                        title="Physical size of the component in imperial units (e.g. 0805, SOIC-8). Adjusting this may affect how the component is categorized and sourced."
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Size (Metric)</label>
                      <input 
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono" 
                        type="text" 
                        name="sizeMetric"
                        value={edited.sizeMetric || ''}
                        onChange={handleChange}
                        title="Physical size of the component in metric units (e.g. 2012, SOIC-8). This is often derived from the imperial size but can be manually adjusted if needed for clarity or specific sourcing requirements."
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Footprint (e.g. C0805, SO8)</label>
                      <input 
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono" 
                        type="text" 
                        name="footprint"
                        value={edited.footprint || ''}
                        onChange={handleChange}
                        title='CAD footprint reference for this component. This should correspond to the naming convention used in your CAD library (e.g. "C0805" for a capacitor in 0805 package, "SO8" for an SOIC-8 IC). Adjusting this will affect how the component is linked to CAD models and may impact design integration.'
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-sm">
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Package Name</label>
                      <input 
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono" 
                        type="text" 
                        name="packageName"
                        value={edited.packageName || ''}
                        onChange={handleChange}
                        title='General package name or family for this component (e.g. "0805", "SOIC-8"). This can be used for broader categorization and may assist in sourcing similar components if an exact match is unavailable.'
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Tolerance</label>
                      <input 
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono" 
                        type="text" 
                        name="tolerance"
                        value={edited.tolerance || ''}
                        onChange={handleChange}
                        title='Tolerance specification for the component, if applicable (e.g. "±5%", "±10%"). This is particularly relevant for passive components like resistors and capacitors, where tolerance can affect performance and sourcing decisions.'
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="font-bold text-outline">Datasheet URL Path</label>
                      <input 
                        className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono" 
                        type="text" 
                        name="datasheet"
                        value={edited.datasheet || ''}
                        onChange={handleChange}
                        title='URL to the datasheet or CAD library reference for this component. This should be a direct link to a PDF or webpage that provides detailed specifications and CAD models for the component. Adjusting this will affect where users are directed when they click the datasheet link in the item details view.'
                      />
                    </div>
                  </div>
                </div>

                {/* CTA actions */}
                <div className="flex items-center justify-end gap-2 pt-md border-t border-outline-variant/60">
                  <button
                    type="button"
                    onClick={() => {
                      setEdited({ ...item });
                      setIsEditing(false);
                    }}
                    className="bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest border border-outline-variant px-lg py-2 rounded-lg font-bold"
                  >
                    Discard Changes
                  </button>

                  <button
                    type="submit"
                    className="bg-primary text-on-primary hover:brightness-110 active:scale-95 transition-all duration-150 px-lg py-2 rounded-lg font-bold flex items-center gap-1 shadow"
                  >
                    <Save className="w-4 h-4" />
                    Save Parameters
                  </button>
                </div>
              </div>
            )}
          </form>
        </div>

        {/* Delete Confirmation Dialog */}
        {showDeleteConfirm && (
          <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-111 p-md">
            <div className="bg-surface-container rounded-xl border border-outline-variant max-w-[512px] w-full shadow-2xl animate-in fade-in duration-200">
              <div className="px-lg py-md border-b border-outline-variant/60 flex items-center justify-between bg-surface-container-high/40">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-red-500" />
                  <h3 className="font-bold text-base text-on-surface">Delete Item</h3>
                </div>
              </div>

              <div className="px-lg py-md space-y-4">
                <p className="text-on-surface text-sm">
                  Are you sure you want to delete <span className="font-bold text-primary">{item.partNumber} - {item.name}</span>? This action cannot be undone.
                </p>

                {deleteError && (
                  <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-md">
                    <p className="text-xs font-bold text-red-500 flex items-center gap-1">
                      <AlertTriangle className="w-4 h-4" />
                      {deleteError}
                    </p>
                  </div>
                )}

                {Object.keys(deleteReferences).length > 0 && (
                  <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-md">
                    <p className="text-xs font-bold text-red-500 mb-2 flex items-center gap-1">
                      <AlertTriangle className="w-4 h-4" />
                      This item is referenced in:
                    </p>
                    <div className="space-y-1 text-xs text-on-surface-variant">
                      {Object.entries(deleteReferences).map(([table, count]) => (
                        <div key={table} className="flex justify-between">
                          <span>{table}</span>
                          <span className="font-bold text-on-surface">{count} entry/entries</span>
                        </div>
                      ))}
                    </div>
                    <label className="flex items-center gap-2 mt-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={cascadeDelete}
                        onChange={(e) => setCascadeDelete(e.target.checked)}
                        className="w-4 h-4"
                      />
                      <span className="text-xs text-on-surface font-semibold">Also remove from BOMs and pick notes</span>
                    </label>
                  </div>
                )}
              </div>

              <div className="px-lg py-md border-t border-outline-variant/60 flex justify-end gap-2">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  disabled={isDeleting}
                  className="px-md py-2 rounded-lg text-xs font-bold border border-outline hover:bg-surface-variant transition-colors"
                  type="button"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmDelete}
                  disabled={isDeleting}
                  className="bg-red-500 text-on-primary hover:bg-red-600 active:scale-95 transition-all duration-150 px-md py-2 rounded-lg font-bold text-xs flex items-center gap-1 disabled:opacity-50"
                  type="button"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {isDeleting ? 'Deleting...' : 'Delete Item'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
