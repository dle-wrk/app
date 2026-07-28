import React, { useState } from 'react';
import { Item, Transaction, Project, BOMItem } from '../types';
import { mapDbRowsToItems } from '../lib/mapDbItem';
import { 
  ClipboardCheck, 
  Layers, 
  Sparkles, 
  AlertCircle, 
  CheckCircle2, 
  ArrowRightLeft, 
  ChevronRight, 
  ShoppingBag,
  History,
  TrendingDown,
  CornerDownRight,
  TrendingUp,
  User,
  ShieldAlert,
  Boxes,
  Briefcase
} from 'lucide-react';

interface BOMManagerProps {
  items: Item[];
  setItems: React.Dispatch<React.SetStateAction<Item[]>>;
  transactions: Transaction[];
  setTransactions: React.Dispatch<React.SetStateAction<Transaction[]>>;
  projects: Project[];
  bomItems: BOMItem[];
  triggerToast: (msg: string, type?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
  onItemClick?: (partNumber: string) => void;
}

export default function BOMManager({
  items,
  setItems,
  transactions,
  setTransactions,
  projects,
  bomItems,
  triggerToast,
  onItemClick
}: BOMManagerProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<number>(1); // Default to TCU06

  React.useEffect(() => {
    if (projects.length > 0 && !projects.find(p => p.id === selectedProjectId)) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects]);
  const [pcbQty, setPcbQty] = useState<number>(50); // Default to 50 PCBs
  
  // Custom substitutions mapped as: { stockCode: substitutedAlternateStockCode }
  const [substitutions, setSubstitutions] = useState<Record<string, string>>({});
  
  // Active Project BOM lines
  const projectBOM = bomItems.filter(bom => bom.projectId === selectedProjectId);
  const activeProject = projects.find(p => p.id === selectedProjectId);

  // Group alternates by matching exact specification values for safe interchangeability
  const getAlternatesFor = (stockCode: string) => {
    const primary = items.find(i => i.partNumber === stockCode);
    if (!primary) return [];

    const clean = (str: string | undefined): string => {
      if (!str) return '';
      return str.trim().toLowerCase().replace(/\s+/g, '');
    };

    const targetName = clean(primary.name);
    const targetValue = clean(primary.value);
    const targetFootprint = clean(primary.footprint);
    const targetDesc = clean(primary.description);

    return items.filter(i => 
      i.partNumber !== stockCode && 
      clean(i.name) === targetName &&
      clean(i.value) === targetValue &&
      clean(i.footprint) === targetFootprint &&
      clean(i.description) === targetDesc &&
      i.status !== 'DISCONTINUED' &&
      i.stockLevel > 0
    ).sort((a, b) => {
      // Priority scoring helper
      const getPriority = (item: Item) => {
        const str = (
          (item.partNumber || '') + ' ' + 
          (item.weblinks?.[0] || '') + ' ' + 
          (item.supplier || '') + ' ' + 
          (item.description || '')
        ).toLowerCase();
        if (str.includes('mouser')) return 1;
        if (str.includes('digikey') || str.includes('digi-key')) return 2;
        if (str.includes('lcsc')) return 3;
        return 4;
      };
      return getPriority(a) - getPriority(b);
    });
  };

  // Perform a live, reactive inventory audit
  const auditResults = projectBOM.map(line => {
    const isSubstituted = substitutions[line.stockCode];
    const resolvedCode = isSubstituted || line.stockCode;
    const inventoryItem = items.find(i => i.partNumber === resolvedCode);
    
    const requiredTotal = line.quantity * pcbQty;
    const currentStock = inventoryItem ? inventoryItem.stockLevel : 0;
    const remainingStock = currentStock - requiredTotal;
    const isShortage = remainingStock < 0;
    const isPrimaryReplenished = line.stockCode !== resolvedCode;

    return {
      line,
      isSubstituted,
      resolvedCode,
      inventoryItem,
      requiredTotal,
      currentStock,
      remainingStock,
      isShortage,
      isPrimaryReplenished,
      shortageAmount: isShortage ? Math.abs(remainingStock) : 0
    };
  });

  const totalShortagesCount = auditResults.filter(r => r.isShortage).length;

  const [showBookOutConfirm, setShowBookOutConfirm] = useState(false);

  const requestBookOut = () => {
    if (pcbQty <= 0) {
      triggerToast('Please enter a valid PCB quantity of 1 or more.', 'ERROR');
      return;
    }
    if (auditResults.length === 0) {
      triggerToast('No BOM lines to book out for this project.', 'ERROR');
      return;
    }
    setShowBookOutConfirm(true);
  };

  // Handles booking out the entire BOM using the unified kit-booking API
  const handleBookOutEntireBOM = async () => {
    setShowBookOutConfirm(false);
    try {
      // Use the unified kit-booking API for atomic execution
      const res = await fetch('/api/kit-booking/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: selectedProjectId,
          buildQty: pcbQty
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to process kit booking');
      }

      // Refresh items and transactions from API to ensure frontend sync
      const [itemsRes, trxRes] = await Promise.all([
        fetch('/api/items'),
        fetch('/api/transactions')
      ]);

      const [newItems, newTrx] = await Promise.all([
        itemsRes.json(),
        trxRes.json()
      ]);

      // Map backend inventory to the frontend Item interface via the shared
      // mapper — a partial mapping here strips fields (value/footprint/weblinks)
      // that other views rely on for spec matching.
      const mappedItems: Item[] = mapDbRowsToItems(newItems);

      if (mappedItems.length > 0) setItems(mappedItems);
      setTransactions(newTrx);
      setSubstitutions({});
      triggerToast(`Unified Workflow: Successfully booked out stock for ${pcbQty} x ${activeProject?.projectName}.`);
    } catch (err: any) {
      console.error('Failed to persist BOM book-out:', err);
      triggerToast(`Booking failed: ${err.message}`, "ERROR");
    }
  };

  return (
    <div className="p-container-margin space-y-lg max-w-[1600px] mx-auto w-full select-none">
      
      {/* Title Header summary banner */}
      <div className="bg-surface-container border border-outline-variant p-lg rounded-xl flex flex-wrap lg:items-center justify-between gap-md relative overflow-hidden">
        <div className="space-y-1 flex-1 min-w-[300px]">
          <div className="flex items-center gap-xs text-primary">
            <ClipboardCheck className="w-5 h-5" />
            <span className="font-label-caps text-[10px] uppercase font-bold tracking-wider">Interactive Stock-Matching Engine</span>
          </div>
          <h3 className="font-headline-sm text-lg font-black text-on-surface">Bill of Materials (BOM) Database Controller</h3>
          <p className="text-on-surface-variant text-xs max-w-[576px]">
            Audit inventory assets against direct project CAD blueprints. Simulate shortages, allocate primary components, or trade up for priority sourcing alternates.
          </p>
        </div>

        {/* Dynamic Project Quick Picker UI */}
        <div className="flex items-center gap-sm shrink-0 bg-surface-container-high/60 border border-outline-variant p-1.5 rounded-lg">
          <span className="text-[10px] text-outline font-black uppercase tracking-wider ml-xs">Active Project:</span>
          <select
            className="bg-surface-container-high border border-outline-variant rounded px-sm py-1 text-xs font-bold text-on-surface outline-none focus:border-primary min-w-[160px]"
            value={selectedProjectId}
            onChange={(e) => {
              setSelectedProjectId(Number(e.target.value));
              setSubstitutions({});
            }}
          >
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.projectName}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Main Operations Split Panels */}
      <div className="grid grid-cols-12 gap-lg items-start">
        
        {/* Left Side: Audit parameters and substitution manager */}
        <div className="col-span-12 lg:col-span-4 space-y-lg">
          
          {/* Target specifications card */}
          <div className="bg-surface-container p-lg rounded-xl border border-outline-variant space-y-md">
            <div className="flex items-center gap-xs justify-between">
              <h4 className="font-bold text-sm text-primary flex items-center gap-xs">
                <Layers className="w-4 h-4" />
                Audit Specifications
              </h4>
              <span className="font-mono text-[10px] text-outline bg-surface-container-high px-1.5 py-0.5 rounded leading-none border border-outline-variant">
                {activeProject?.status || 'Active'}
              </span>
            </div>

            <div className="space-y-sm text-xs border-y border-outline-variant/30 py-sm">
              <div className="flex justify-between">
                <span className="text-on-surface-variant">Project Name:</span>
                <span className="font-bold text-on-surface">{activeProject?.projectName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-on-surface-variant">CAD Description:</span>
                <span className="text-[#8c909f] max-w-[200px] text-right truncate">{activeProject?.description}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-on-surface-variant">BOM Line Items:</span>
                <span className="font-semibold font-mono">{projectBOM.length} component types</span>
              </div>
            </div>

            {/* Quantity multiplier input */}
            <div className="bg-surface-container-high/60 border border-outline-variant p-md rounded-xl space-y-sm">
              <label className="font-bold text-outline uppercase font-label-caps text-[10px] block">
                PCB Assembly Target (Multiplier)
              </label>
              <div className="flex items-center gap-sm">
<input
                   type="number"
                   min="1"
                   max="1000"
                   placeholder="Enter PCB quantity"
                   className="flex-1 bg-surface border border-outline-variant rounded p-sm font-mono text-center text-sm font-bold text-on-surface focus:border-primary outline-none"
                   value={pcbQty}
                   onChange={(e) => setPcbQty(Math.max(1, parseInt(e.target.value) || 0))}
                 />
                <span className="font-mono text-xs text-outline shrink-0">PCBs to assemble</span>
              </div>
              <p className="text-[10px] text-on-surface-variant leading-relaxed">
                Scales individual quantities dynamically to assess floor preparation stocks.
              </p>
            </div>
          </div>

          {/* Sourcing summary diagnostics panel */}
          <div className="bg-surface-container p-lg rounded-xl border border-outline-variant space-y-md">
            <h4 className="font-bold text-xs uppercase tracking-wider text-outline font-label-caps">
              Sourcing Diagnostics
            </h4>
            
            <div className="grid grid-cols-2 gap-sm">
              <div className="bg-surface-container-high/40 p-sm rounded-lg border border-outline-variant/60 flex flex-col justify-between">
                <span className="text-[9px] text-outline font-label-caps uppercase leading-none block mb-1">Stock Shortages</span>
                <span className={`text-xl font-black font-mono leading-none ${totalShortagesCount > 0 ? 'text-tertiary animate-pulse' : 'text-green-400'}`}>
                  {totalShortagesCount}
                </span>
              </div>

              <div className="bg-surface-container-high/40 p-sm rounded-lg border border-outline-variant/60 flex flex-col justify-between">
                <span className="text-[9px] text-outline font-label-caps uppercase leading-none block mb-1">Substitutions Active</span>
                <span className="text-xl font-black font-mono leading-none text-primary">
                  {Object.keys(substitutions).length}
                </span>
              </div>
            </div>

            {totalShortagesCount > 0 ? (
              <div className="p-3 bg-red-500/10 text-red-400 font-mono text-[11px] rounded-lg border border-red-500/15 flex gap-2">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold uppercase block mb-1">PROVISION ALERTS ACTIVE</span>
                  Missing stock detected! Utilize the Alternate components drawer to resolve supply limits before booking out.
                </div>
              </div>
            ) : (
              <div className="p-3 bg-green-500/10 text-green-400 font-mono text-[11px] rounded-lg border border-green-500/15 flex gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold uppercase block">STOCK READY</span>
                  All physical items are fully verified. Stocks can be booked out onto demans safely.
                </div>
              </div>
            )}

            <button
              onClick={requestBookOut}
              className={`w-full font-bold px-lg py-sm rounded-lg flex items-center justify-center gap-xs shadow text-xs uppercase tracking-wider transition-all duration-150 ${
                totalShortagesCount > 0 
                  ? 'bg-surface-container-highest hover:brightness-110 border border-outline-variant text-on-surface'
                  : 'bg-primary text-on-primary hover:brightness-110 active:scale-95'
              }`}
            >
              <ShoppingBag className="w-3.5 h-3.5" />
              Book Out Entire BOM ({auditResults.length} Lines)
            </button>
          </div>
        </div>

        {/* Right Side: Interactive audit lists with alternations mapping */}
        <div className="col-span-12 lg:col-span-8 flex flex-col space-y-md">
          <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden shadow-xl">
            <div className="px-lg py-sm border-b border-outline-variant bg-surface-container-high/30 flex justify-between items-center text-xs">
              <span className="font-mono text-xs uppercase tracking-tight font-black text-on-surface-variant flex items-center gap-1.5">
                <Boxes className="w-4 h-4 text-primary" />
                Project {selectedProjectId} - Direct Component Audit Rows
              </span>
              <span className="font-mono text-[10px] text-outline">Multiplier: {pcbQty} PCBs</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[750px]">
                <thead>
                  <tr className="bg-surface-container-high text-[10px] uppercase font-mono text-outline border-b border-outline-variant">
                    <th className="px-lg py-2">Stock Reference</th>
                    <th className="px-lg py-2 text-right">Required (Per PCB)</th>
                    <th className="px-lg py-2 text-right">Total Needed</th>
                    <th className="px-lg py-2 text-right">Current Stock</th>
                    <th className="px-lg py-2 text-center">Status</th>
                    <th className="px-lg py-2 text-center">Allocations & Alternates</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant/30 text-xs">
                  {auditResults.map(({ line, isSubstituted, resolvedCode, inventoryItem, requiredTotal, currentStock, remainingStock, isShortage, isPrimaryReplenished, shortageAmount }) => {
                    // Check if alternates are available for substitution
                    const altOptions = getAlternatesFor(line.stockCode);
                    
                    return (
                      <tr key={line.id} className={`hover:bg-surface-variant/20 transition-all ${isShortage ? 'bg-red-500/5' : ''}`}>
                        
                        {/* SKU Reference with hover tooltips */}
                        <td className="px-lg py-3">
                          <div 
                            onClick={() => onItemClick?.(resolvedCode)}
                            className="font-bold font-mono text-[13px] text-primary hover:underline cursor-pointer flex items-center gap-1 select-none w-fit"
                            title="Click to view/edit component details"
                          >
                            {resolvedCode}
                          </div>
                          <span className="text-[10px] text-outline block max-w-[220px] truncate leading-normal">
                            {inventoryItem ? inventoryItem.description : line.comment}
                          </span>
                          
                          {/* Substitution badge */}
                          {isPrimaryReplenished && (
                            <span className="mt-1 inline-flex items-center gap-1 text-[8.5px] font-bold text-primary font-mono uppercase bg-primary/10 border border-primary/20 px-1 py-0.5 rounded">
                              <ArrowRightLeft className="w-2.5 h-2.5" />
                              Subbed: {line.stockCode} → {resolvedCode}
                            </span>
                          )}
                        </td>

                        {/* Qty Per PCB */}
                        <td className="px-lg py-3 text-right font-mono text-on-surface-variant font-semibold">
                          {line.quantity}
                        </td>

                        {/* Calculated Target total required */}
                        <td className="px-lg py-3 text-right font-mono font-bold text-on-surface">
                          {requiredTotal.toLocaleString()}
                        </td>

                        {/* Current inventory level */}
                        <td className="px-lg py-3 text-right font-mono">
                          <span className={`font-semibold ${currentStock < 10 ? 'text-red-400 font-black' : 'text-on-surface-variant'}`}>
                            {currentStock.toLocaleString()}
                          </span>
                          <span className="text-[9px] text-[#8c909f] block">
                            {inventoryItem?.status === 'DISCONTINUED' ? 'DISCONTINUED' : 'In Stock'}
                          </span>
                        </td>

                        {/* Status checks */}
                        <td className="px-lg py-3 text-center">
                          {isShortage ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-red-500/10 text-red-400 border border-red-500/15 font-mono">
                              <AlertCircle className="w-3 h-3" />
                              SHORTAGE: -{shortageAmount}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-green-500/10 text-green-400 border border-green-500/15 font-mono">
                              <CheckCircle2 className="w-3 h-3" />
                              OK (+{remainingStock})
                            </span>
                          )}
                        </td>

                        {/* Alternates prompt portal dropdown */}
                        <td className="px-lg py-3 text-center">
                          {altOptions.length > 0 ? (
                            <div className="flex flex-col items-center gap-1">
                              <select
                                className="bg-surface-container border border-outline-variant p-1 rounded font-mono text-[10px] text-on-surface outline-none focus:border-primary max-w-140px"
                                aria-label={`Select alternate for ${line.stockCode}`}
                                value={isSubstituted || ""}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  if (val === "") {
                                    const { [line.stockCode]: removed, ...rest } = substitutions;
                                    setSubstitutions(rest);
                                    triggerToast(`Restored primary specification: ${line.stockCode}`);
                                  } else {
                                    setSubstitutions({ ...substitutions, [line.stockCode]: val });
                                    triggerToast(`Substituted with alternative stock: ${val}`);
                                  }
                                }}
                              >
                                <option value="">Primary Spec ({line.stockCode})</option>
                                {altOptions.map(alt => (
                                  <option key={alt.partNumber} value={alt.partNumber}>
                                    {alt.partNumber} (Stock: {alt.stockLevel})
                                  </option>
                                ))}
                              </select>
                              <span className="text-[9px] text-[#8c909f] font-mono">
                                {altOptions.length} alternates found
                              </span>
                            </div>
                          ) : (
                            <span className="text-[10px] text-outline italic">
                              No compatible alternates
                            </span>
                          )}
                        </td>

                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {showBookOutConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowBookOutConfirm(false)}>
          <div className="bg-surface-container border border-outline-variant rounded-xl shadow-2xl max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="px-lg py-md border-b border-outline-variant flex items-center gap-xs">
              <ShoppingBag className="w-4 h-4 text-primary" />
              <h4 className="font-bold text-sm text-on-surface">Confirm BOM Book-Out</h4>
            </div>
            <div className="px-lg py-md text-xs text-on-surface-variant space-y-2">
              <p>
                Book out the entire BOM ({auditResults.length} line{auditResults.length === 1 ? '' : 's'}) for{' '}
                <span className="font-bold text-on-surface">{pcbQty} PCB{pcbQty === 1 ? '' : 's'}</span> of{' '}
                <span className="font-bold text-primary">{activeProject?.projectName || 'selected project'}</span>?
              </p>
              {totalShortagesCount > 0 && (
                <p className="flex items-start gap-1.5 text-red-400 font-semibold">
                  <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                  {totalShortagesCount} line{totalShortagesCount === 1 ? ' has' : 's have'} stock shortages — proceeding will exhaust remaining stock on those lines.
                </p>
              )}
            </div>
            <div className="px-lg py-md border-t border-outline-variant flex justify-end gap-sm">
              <button
                onClick={() => setShowBookOutConfirm(false)}
                className="px-md py-1.5 rounded-lg text-xs font-bold border border-outline-variant text-on-surface hover:bg-surface-variant/40 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleBookOutEntireBOM}
                className="px-md py-1.5 rounded-lg text-xs font-bold bg-primary text-on-primary hover:brightness-110 active:scale-95 transition-all flex items-center gap-xs"
              >
                <ShoppingBag className="w-3 h-3" />
                Book Out BOM
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
