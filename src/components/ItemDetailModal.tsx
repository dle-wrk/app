import React, { useState } from 'react';
import { Item } from '../types';
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
  HelpCircle
} from 'lucide-react';

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
}

export default function ItemDetailModal({ item, onClose, onSave }: ItemDetailModalProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [edited, setEdited] = useState<Item>(() => {
    const enriched = { ...item };
    if (!enriched.sizeMetric && enriched.size) {
      enriched.sizeMetric = deriveMetric(enriched.size);
    }
    if (enriched.bulkPriceZar === undefined || enriched.bulkPriceZar === null || enriched.bulkPriceZar === 0) {
      enriched.bulkPriceZar = enriched.price * 19;
    }
    return enriched;
  });

  const initialCategories = [
    "Resistor",
    "Capacitor",
    "IC (Integrated Circuit)",
    "Diode",
    "Transistor",
    "Connector",
    "LED",
    "Inductor",
    "Crystal / Oscillator",
    "Button / Tactile Switch",
    "Sensors",
    "Hardware / Other",
    "Antenna",
    "Sub-Assembly",
    "Battery",
    "Box",
    "Bracket",
    "Kit",
    "Buzzer",
    "Cable / Flylead",
    "Coax",
    "Jumper",
    "Fibre",
    "Ethernet",
    "Product",
    "Consumable",
    "Tool",
  ];
  const uniqueCategories = Array.from(new Set([...initialCategories, item.category].filter(Boolean)));
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
        // Sync with primary fields if it's the first element
        if (field === 'manPns' && index === 0) next.manufacturer = value;
        if (field === 'supPns' && index === 0) next.supplier = value;
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

      if (name === 'supplier') {
        const arr = [...(prev.supPns || [])];
        if (arr.length === 0) arr.push(value);
        else arr[0] = value;
        updated.supPns = arr;
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
        updated.bulkPriceZar = Number((finalValue * 19).toFixed(5));
      } else if (name === 'priceZar') {
        const zarVal = Number(value) || 0;
        updated.price = Number((zarVal / 19).toFixed(5));
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

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-110 p-md">
      <div className="bg-surface-container rounded-xl border border-outline-variant max-w-[768px] w-full max-h-[90vh] flex flex-col shadow-2xl relative animate-in fade-in duration-200">
        
        {/* Header toolbar */}
        <div className="px-lg py-md border-b border-outline-variant/60 flex items-center justify-between bg-surface-container-high/40 shrink-0">
          <div className="space-y-0.5">
            <span className="font-mono text-[10px] text-primary uppercase font-extrabold tracking-wider bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded">
              SKU: {item.partNumber}
            </span>
            <h3 className="font-bold text-base text-on-surface select-none pr-8">
              {isEditing ? `Edit SKU ${item.partNumber}` : item.name}
            </h3>
          </div>

          <div className="flex items-center gap-2">
            {!isEditing ? (
              <button
                onClick={() => setIsEditing(true)}
                className="bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 px-md py-1.5 rounded-lg text-xs font-bold transition-all duration-150 flex items-center gap-1"
                type="button"
                id="btn-edit-item"
              >
                <Edit3 className="w-3.5 h-3.5" />
                Edit Parameters
              </button>
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
                      {item.stockLevel.toLocaleString()} units
                    </span>
                    {item.stockLevel < (item.lowStockLvl || 50) && (
                      <span className="text-[9px] text-tertiary flex items-center gap-0.5 mt-0.5 font-bold">
                        <AlertTriangle className="w-2.5 h-2.5 shrink-0" /> Low Stock
                      </span>
                    )}
                  </div>

                  <div className="bg-surface-container-high/40 p-sm rounded-lg border border-outline-variant/50">
                    <span className="text-[10px] text-outline font-label-caps uppercase block mb-1">Standard Cost</span>
                    <div className="flex flex-col">
                      <span className="text-base font-black font-mono text-green-400 leading-none">
                        ${item.price.toFixed(3)}
                      </span>
                      <span className="text-[10px] font-mono text-outline mt-1 block">
                        R{(item.bulkPriceZar || item.price * 19).toFixed(3)} ZAR
                      </span>
                    </div>
                  </div>

                  <div className="bg-surface-container-high/40 p-sm rounded-lg border border-outline-variant/50">
                    <span className="text-[10px] text-outline font-label-caps uppercase block mb-1">Total Holding Value</span>
                    <div className="flex flex-col">
                      <span className="text-base font-black font-mono text-primary leading-none">
                        ${(item.price * item.stockLevel).toFixed(2)}
                      </span>
                      <span className="text-[10px] font-mono text-outline mt-1 block">
                        R{((item.bulkPriceZar || item.price * 19) * item.stockLevel).toFixed(2)} ZAR
                      </span>
                    </div>
                  </div>

                  <div className="bg-surface-container-high/40 p-sm rounded-lg border border-outline-variant/50">
                    <span className="text-[10px] text-outline font-label-caps uppercase block mb-1">Status</span>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 mt-0.5 rounded text-[9px] font-bold font-mono border ${
                      item.status === 'ACTIVE' ? 'bg-green-500/10 text-green-400 border-green-500/20' : 
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
                          <span className="font-mono font-semibold text-green-400">${(item.bulkPriceUsd || item.price).toFixed(3)}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-outline">Bulk Rate (ZAR):</span>
                          <span className="font-mono font-semibold text-green-400">R{(item.bulkPriceZar || item.price * 19).toFixed(2)}</span>
                        </div>
                      </div>

                    </div>
                  </div>
                </div>

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
                      <span className="font-mono font-semibold">{item.lastOrderQty ? `${item.lastOrderQty.toLocaleString()} units` : 'Unknown'}</span>
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

                     <div className="flex flex-col gap-2">
                      <div className="flex flex-col gap-1">
                        <label className="font-bold text-outline">Preferred Sourcing Category</label>
                        <select aria-label="Selection"
                          className="w-full bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary" 
                          name="category"
                          value={edited.category}
                          onChange={handleChange}
                          title="Preferred Sourcing Category"
                        >
                          {categories.map((cat) => (
                            <option key={cat} value={cat}>{cat}</option>
                          ))}
                        </select>
                      </div>

                      <div className="flex items-center gap-xs">
                        <input 
                          type="text"
                          placeholder="Or type new category..."
                          value={newCategory}
                          onChange={(e) => setNewCategory(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleAddCategory();
                            }
                          }}
                          className="flex-1 bg-surface-container-high border border-outline-variant rounded px-2.5 py-1 text-xs text-on-surface outline-none focus:border-primary placeholder-muted"
                        />
                        <button
                          type="button"
                          onClick={handleAddCategory}
                          className="bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 px-3 py-1 rounded text-xs font-bold transition-all shrink-0"
                        >
                          + Add
                        </button>
                      </div>
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
                      <div className="grid grid-cols-1 gap-1.5">
                        {[0, 1, 2, 3, 4].map((i) => (
                          <input
                            key={`manPns_${i}`}
                            name={`manPns_${i}`}
                            value={edited.manPns?.[i] || ''}
                            onChange={handleChange}
                            placeholder={`Mfr PN ${i + 1}`}
                            className="w-full bg-surface-container-high border border-outline-variant rounded px-2 py-1.5 text-on-surface outline-none focus:border-primary font-mono"
                          />
                        ))}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label className="font-bold text-outline block text-[10px] uppercase">Supplier Part Numbers (1-5)</label>
                      <div className="grid grid-cols-1 gap-1.5">
                        {[0, 1, 2, 3, 4].map((i) => (
                          <input
                            key={`supPns_${i}`}
                            name={`supPns_${i}`}
                            value={edited.supPns?.[i] || ''}
                            onChange={handleChange}
                            placeholder={`Sup PN ${i + 1}`}
                            className="w-full bg-surface-container-high border border-outline-variant rounded px-2 py-1.5 text-on-surface outline-none focus:border-primary font-mono"
                          />
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="font-bold text-outline block text-[10px] uppercase">External Web Links (1-5)</label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-sm">
                      {[0, 1, 2, 3, 4].map((i) => (
                        <input
                          key={`weblinks_${i}`}
                          name={`weblinks_${i}`}
                          value={edited.weblinks?.[i] || ''}
                          onChange={handleChange}
                          placeholder={`Web Link ${i + 1} URL`}
                          className="w-full bg-surface-container-high border border-outline-variant rounded px-2 py-1.5 text-on-surface outline-none focus:border-primary font-mono"
                        />
                      ))}
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
                        step="0.0001"
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
                        step="0.001"
                        min="0"
                        title="Standard cost per unit in ZAR. This is used for financial calculations and can be adjusted based on supplier quotes or market changes."
                        value={edited.bulkPriceZar !== undefined ? Number(edited.bulkPriceZar.toFixed(5)) : Number((edited.price * 19).toFixed(5))}
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
      </div>
    </div>
  );
}
