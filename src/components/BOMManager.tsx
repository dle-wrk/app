import React, { useState, useEffect, useMemo } from 'react';
import { isDnfCode } from '../lib/dnf';
import { searchFields, searchWords } from '../lib/itemSearch';
import { canChange } from '../lib/changeAccess';
import { Item, Transaction, Project, BOMItem } from '../types';
import { mapDbRowsToItems } from '../lib/mapDbItem';
import { fmtNumber } from '../lib/formatMoney';
import { detectLedSwatch, ledSwatchBackground } from '../lib/ledColor';
import BuildQtyPicker from './BuildQtyPicker';
import SupplierOrderFiles from './SupplierOrderFiles';
import { colorToCssBackground, KitAllocationDialog, type MatchCandidate } from './views/KitBookingView';
import { allocateAllByTier, otherLinesParts, withPickedElsewhere } from '../lib/kitTierFill';
import { mergeBomLines } from '../lib/mergeBomLines';
import { confirmDialog } from '../lib/confirmDialog';
import { BomPickPanel, scannedBomLines, type PickView } from './BomPickPanel';
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
  Briefcase,
  Package
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
  /** Per-part reserved qty across every OPEN sales order. Displayed as
   * a soft annotation under the On-hand cell — the OK/SHORTAGE badge
   * still uses raw stock (changing that math would ripple into
   * procurement outputs and is out of scope for this display change). */
  reservedByPart?: Record<string, number>;
}

export default function BOMManager({
  items,
  setItems,
  transactions,
  setTransactions,
  projects,
  bomItems,
  triggerToast,
  onItemClick,
  reservedByPart = {},
}: BOMManagerProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<number>(1); // Default to TCU06

  React.useEffect(() => {
    if (projects.length > 0 && !projects.find(p => p.id === selectedProjectId)) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects]);
  const [pcbQty, setPcbQty] = useState<number>(50); // Default to 50 PCBs
  
  // Allocations, as in P&P Kit Booking: a BOM line can be covered by several
  // reels (its own SKU and alternates), each with a quantity. Book-out takes
  // each pick from its own SKU.
  const [allocations, setAllocations] = useState<Record<string, Array<{ allocatedCode: string; qty: number }>>>({});
  const [allocatingCode, setAllocatingCode] = useState<string | null>(null);
  const [autoAllocateBusy, setAutoAllocateBusy] = useState(false);

  // Reverse lookup: stockCode → names of saved kits that reference it,
  // so each row can advertise "in use by kits X, Y". One aggregate fetch
  // of /api/kits (compact stock-code arrays per kit) beats per-row
  // requests. Filtered to the currently-selected project so an audit
  // for TCU06 doesn't get cross-project noise from another kit.
  const [savedKits, setSavedKits] = useState<Array<{ id: number; name: string; projectId: number | null; buildQty: number; stockCodes: string[] }>>([]);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/kits')
      .then(r => r.ok ? r.json() : [])
      .then(data => { if (!cancelled && Array.isArray(data)) setSavedKits(data); })
      .catch(() => { /* no-op — the badge just doesn't render */ });
    return () => { cancelled = true; };
  }, []);
  const kitsByStockCode = useMemo(() => {
    const map: Record<string, Array<{ id: number; name: string }>> = {};
    for (const kit of savedKits) {
      if (kit.projectId != null && kit.projectId !== selectedProjectId) continue;
      for (const sc of (kit.stockCodes || [])) {
        if (!sc) continue;
        if (!map[sc]) map[sc] = [];
        map[sc].push({ id: kit.id, name: kit.name });
      }
    }
    return map;
  }, [savedKits, selectedProjectId]);
  
  // Active Project BOM lines
  // One line per stock code, as P&P Kit Booking's audit (lib/mergeBomLines):
  // a part the CAD export lists twice is added together, not shown twice.
  const projectBOM = useMemo(() => mergeBomLines(bomItems.filter(bom => bom.projectId === selectedProjectId)), [bomItems, selectedProjectId]);
  const activeProject = projects.find(p => p.id === selectedProjectId);
  // Free-text search across every practically searchable field on a
  // BOM line: stock code, substituted resolved code, description /
  // comment / designator, and the paired inventory row's description
  // + manufacturer PN so an operator searching by MPN can find the
  // BOM line that uses it. Empty query = pass everything through
  // (existing behaviour).
  const [bomSearch, setBomSearch] = useState<string>('');
  const filteredBOM = useMemo(() => {
    const words = searchWords(bomSearch);
    if (!words.length) return projectBOM;
    return projectBOM.filter(line => {
      const inv = items.find(i => i.partNumber === line.stockCode);
      const haystack = [line.stockCode, line.designator, line.description, line.comment, ...(inv ? searchFields(inv) : [])]
        .filter(Boolean).join(' ').toLowerCase();
      return words.every(w => haystack.includes(w));
    });
  }, [projectBOM, bomSearch, items]);

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
      i.status !== 'DO NOT USE' &&
      i.stockLevel > 0
    ).sort((a, b) => {
      // Priority scoring helper
      const getPriority = (item: Item) => {
        const str = (
          (item.partNumber || '') + ' ' + 
          (item.weblinks?.find(Boolean) || '') + ' ' +
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

  // A BOM line counts as "voided" — i.e. deliberately not populated on the
  // PCB — when the stock reference matches one of the industry-standard
  // do-not-fit conventions, is a placeholder test code, or has zero/blank
  // fields. These rows must NOT trigger shortage math because there's no
  // real part expected. They still appear in the audit table so the user
  // can see them, just with a distinct badge.
  //
  // The list intentionally covers the common tribal conventions (DNF, DNP,
  // "do not populate", NC = not connected). Test-prefix codes (TEST-001,
  // TEST-*, X-*) are treated the same — they're scaffolding rows a CAD
  // engineer leaves in during design and doesn't source.
  const VOIDED_STOCK_CODES = new Set(['DNF', 'DNP', 'DO NOT FIT', 'DO NOT POPULATE', 'NC', 'NA', 'N/A', 'NONE']);
  const isVoidedBomLine = (stockCode: string, quantity: number): boolean => {
    const trimmed = String(stockCode || '').trim();
    if (!trimmed) return true;
    if (quantity <= 0) return true;
    const upper = trimmed.toUpperCase();
    if (VOIDED_STOCK_CODES.has(upper)) return true;
    if (isDnfCode(trimmed)) return true; // DNF-013, DNP_2, … (../lib/dnf)
    if (/^(TEST|PLACEHOLDER|TBD|XXX)[-_ ]?\d*$/i.test(trimmed)) return true;
    return false;
  };

  // Perform a live, reactive inventory audit
  const auditResults = projectBOM.map(line => {
    const isVoided = isVoidedBomLine(line.stockCode, line.quantity);
    const picks = (allocations[line.stockCode] || []).filter(p => p.qty > 0);
    const picked = picks.reduce((sum, p) => sum + p.qty, 0);
    const resolvedCode = line.stockCode;
    const inventoryItem = items.find(i => i.partNumber === resolvedCode);

    const requiredTotal = line.quantity * pcbQty;
    const currentStock = inventoryItem ? inventoryItem.stockLevel : 0;
    // With picks, the line is covered by what's picked across its reels;
    // without, by its own stock (as before).
    const remainingStock = picks.length ? picked - requiredTotal : currentStock - requiredTotal;
    // Voided lines never count as shortages, regardless of what stock math
    // says. There's no part to source and no PCB position to fill.
    const isShortage = !isVoided && remainingStock < 0;
    const isPrimaryReplenished = picks.some(p => p.allocatedCode !== line.stockCode);

    return {
      line,
      isVoided,
      picks,
      picked,
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
  const totalVoidedCount = auditResults.filter(r => r.isVoided).length;
  // Table-only filtered view — keep the sidebar counts against the
  // full audit so a stale search text can't hide the actual state.
  const displayedAudit = useMemo(() => {
    const q = bomSearch.trim().toLowerCase();
    if (!q) return auditResults;
    return auditResults.filter(r => {
      const inv = r.inventoryItem;
      const haystack = [
        r.line.stockCode,
        r.resolvedCode,
        r.line.designator,
        r.line.description,
        r.line.comment,
        inv?.description,
        inv?.name,
        ...(inv?.manPns || []),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [auditResults, bomSearch]);

  // Auto-allocate: the per-line "Auto-fill by tier" (lib/kitTierFill) on
  // every line, for the PCB quantity chosen, the same as P&P Kit Booking.
  // A line with no T1/T2 candidate keeps its picks (hand-chosen swaps).
  const autoAllocateAll = async () => {
    const targets = auditResults.filter(r => !r.isVoided);
    if (!targets.length) { triggerToast('Nothing to allocate: every line is voided.', 'INFO'); return; }
    const withPicks = targets.filter(r => r.picks.length > 0).length;
    if (withPicks > 0 && !(await confirmDialog({
      title: 'Auto-allocate',
      message: `Fill every line by tier (T1 exact, then T2 same value and footprint) for ${pcbQty} PCB${pcbQty === 1 ? '' : 's'}, across as many reels as needed? This replaces the picks on ${withPicks} line${withPicks === 1 ? '' : 's'}. Lines with no T1/T2 match keep theirs.`,
      confirmLabel: 'Auto-allocate',
    }))) return;
    setAutoAllocateBusy(true);
    try {
      const res = await fetch('/api/kits/match/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stockCodes: targets.map(r => r.line.stockCode) }),
      });
      if (!res.ok) throw new Error(`Match lookup failed (${res.status})`);
      const matches: Record<string, MatchCandidate[]> = await res.json();
      // Whole BOM at once: another line's own part is never an alternate,
      // and what earlier lines took from a reel counts as used.
      const result = allocateAllByTier(targets.map(r => ({ code: r.line.stockCode, needed: r.requiredTotal })), matches, reservedByPart);
      const { filled, short } = result;
      setAllocations({ ...allocations, ...result.allocations });
      const skipped = targets.length - filled;
      const parts = [`${filled} line${filled === 1 ? '' : 's'} filled for ${pcbQty} PCB${pcbQty === 1 ? '' : 's'}`];
      if (short) parts.push(`${short} still short after fill`);
      if (skipped) parts.push(`${skipped} had no T1/T2 candidates (left as they were)`);
      triggerToast(parts.join(' · '), short ? 'INFO' : 'SUCCESS');
    } catch (err: any) {
      triggerToast(`Auto-allocate failed: ${err.message}`, 'ERROR');
    } finally {
      setAutoAllocateBusy(false);
    }
  };

  // ---- Booking the BOM out by scanning (BomPickPanel, src/lib/bomPicks.ts)
  // "Book Out Entire BOM" starts a pick: the phone scans each item, lines go
  // green here, and a final check books out what was scanned.
  const [pick, setPick] = useState<PickView | null>(null);
  const [pickPanel, setPickPanel] = useState(false);
  const scannedLines = useMemo(() => scannedBomLines(pick), [pick]);
  // Items already scanned for a green line: not offered as another line's alternate.
  const scannedCodes = useMemo(() => (pick?.status === 'OPEN' ? pick.lines.filter(l => scannedLines.has(l.bomCode)).map(l => l.code) : []), [pick, scannedLines]);
  const pickRequestLines = () => auditResults.filter(r => !r.isVoided).map(r => ({ bomCode: r.line.stockCode, need: r.requiredTotal, picks: r.picks.map(p => ({ code: p.allocatedCode, qty: p.qty })) }));
  const loadPick = async (id: number): Promise<PickView | null> => {
    const r = await fetch(`/api/bom-picks/${id}`);
    return r.ok ? r.json() : null;
  };
  // A project's open pick, picked up again after a reload: its board count and allocations come back too.
  useEffect(() => {
    let gone = false;
    setPick(null); setPickPanel(false);
    fetch(`/api/bom-picks?status=OPEN&projectId=${selectedProjectId}`).then(r => (r.ok ? r.json() : { items: [] })).then(async (d) => {
      const first = d.items?.[0];
      const full = first ? await loadPick(first.id) : null;
      if (gone || !full) return;
      setPick(full);
      setPcbQty(full.buildQty);
      const restored: Record<string, Array<{ allocatedCode: string; qty: number }>> = {};
      for (const l of full.lines) if (l.code !== l.bomCode || l.itemsForBomLine > 1) (restored[l.bomCode] ??= []).push({ allocatedCode: l.code, qty: l.need });
      setAllocations(restored);
    }).catch(() => {});
    return () => { gone = true; };
  }, [selectedProjectId]);
  // Live: the lines turn green while the phone scans.
  useEffect(() => {
    if (!pick || pick.status !== 'OPEN') return;
    const t = window.setInterval(() => { if (!document.hidden) void loadPick(pick.id).then(p => { if (p) setPick(p); }); }, 3000);
    return () => window.clearInterval(t);
  }, [pick?.id, pick?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  // Allocations or the board count changed while scanning: the lines not scanned yet follow.
  const sentKey = React.useRef('');
  useEffect(() => {
    if (!pick || pick.status !== 'OPEN') { sentKey.current = ''; return; }
    const lines = pickRequestLines();
    const key = JSON.stringify([pcbQty, lines]);
    if (!sentKey.current) { sentKey.current = key; return; }
    if (key === sentKey.current) return;
    const t = window.setTimeout(() => {
      sentKey.current = key;
      fetch(`/api/bom-picks/${pick.id}/lines`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buildQty: pcbQty, lines }) })
        .then(async r => { const d = await r.json(); if (r.ok) setPick(d); else triggerToast(d.error || 'Could not update the BOM pick', 'ERROR'); })
        .catch(() => {});
    }, 600);
    return () => window.clearTimeout(t);
  }, [allocations, pcbQty, pick?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const requestBookOut = async () => {
    if (pcbQty <= 0) {
      triggerToast('Please enter a valid PCB quantity of 1 or more.', 'ERROR');
      return;
    }
    if (auditResults.length === 0) {
      triggerToast('No BOM lines to book out for this project.', 'ERROR');
      return;
    }
    if (pick?.status === 'OPEN') { setPickPanel(true); return; }
    try {
      const r = await fetch('/api/bom-picks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: selectedProjectId, buildQty: pcbQty, lines: pickRequestLines() }) });
      const d = await r.json();
      if (r.status === 409 && d.id) { const p = await loadPick(d.id); if (p) { setPick(p); setPickPanel(true); } return; }
      if (!r.ok) throw new Error(d.error || 'Could not start the BOM pick');
      sentKey.current = '';
      setPick(d); setPickPanel(true);
      triggerToast('Waiting for the scanner: open /scan on the phone and tap SCAN BOM ITEMS.', 'INFO');
    } catch (err: any) { triggerToast(err.message, 'ERROR'); }
  };

  const cancelPick = async () => {
    if (!pick) return;
    if (!(await confirmDialog({ title: 'Cancel the BOM pick', message: `Stop scanning ${activeProject?.projectName || 'this BOM'}? ${pick.lines.some(l => l.picked > 0) ? 'What was scanned is forgotten; ' : ''}nothing is booked out.`, confirmLabel: 'Cancel the pick', destructive: true }))) return;
    const r = await fetch(`/api/bom-picks/${pick.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { triggerToast(d.error || 'Could not cancel it', 'ERROR'); return; }
    setPick(null); setPickPanel(false);
    triggerToast('BOM pick cancelled. Nothing was booked out.', 'INFO');
  };

  const bookOutPick = async () => {
    if (!pick) return;
    const r = await fetch(`/api/bom-picks/${pick.id}/book-out`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { triggerToast(`Booking failed: ${d.error || r.statusText}`, 'ERROR'); const p = await loadPick(pick.id); if (p) setPick(p); return; }
    const [newItems, newTrx] = await Promise.all([fetch('/api/items').then(x => x.json()), fetch('/api/transactions').then(x => x.json())]);
    const mappedItems: Item[] = mapDbRowsToItems(newItems);
    if (mappedItems.length > 0) setItems(mappedItems);
    setTransactions(newTrx);
    setAllocations({}); setPick(null); setPickPanel(false);
    triggerToast(`Booked out ${fmtNumber(d.result?.units ?? 0)} units of ${d.result?.items?.length ?? 0} items for ${pcbQty} × ${activeProject?.projectName}, as scanned.`);
  };

  return (
    <div className="p-container-margin space-y-lg max-w-[1600px] mx-auto w-full select-none">
      
      {pick && pickPanel && pick.status === 'OPEN' && (
        <BomPickPanel pick={pick} onClose={() => setPickPanel(false)} onCancelPick={() => void cancelPick()} onBookOut={bookOutPick} />
      )}

      {allocatingCode && (() => {
        const row = auditResults.find(r => r.line.stockCode === allocatingCode);
        if (!row) return null;
        return (
          <KitAllocationDialog
            stockCode={allocatingCode}
            needed={row.requiredTotal}
            existing={allocations[allocatingCode] || []}
            autoResolved={allocatingCode}
            reservations={withPickedElsewhere(reservedByPart, allocations, allocatingCode)}
            excludeCodes={[...otherLinesParts(projectBOM.map(l => l.stockCode), allocatingCode), ...scannedCodes]}
            onClose={() => setAllocatingCode(null)}
            onSave={(picks) => {
              setAllocations(prev => {
                const next = { ...prev };
                if (picks.length) next[allocatingCode] = picks; else delete next[allocatingCode];
                return next;
              });
              setAllocatingCode(null);
            }}
            triggerToast={(m, t) => triggerToast(m, t === 'ERROR' ? 'ERROR' : t === 'INFO' ? 'INFO' : 'SUCCESS')}
          />
        );
      })()}

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
              setAllocations({});
            }}
          >
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.projectName}</option>
            ))}
          </select>
        </div>
      </div>

      {/* One upload file per supplier, from the audit (allocations included) */}
      <SupplierOrderFiles
        projectName={activeProject?.projectName || 'project'}
        pcbQty={pcbQty}
        onShowNotification={triggerToast}
        lines={auditResults.filter(r => !r.isVoided).map(r => ({
          stockCode: r.resolvedCode,
          description: r.inventoryItem?.description || r.line.description || r.line.comment || '',
          footprint: r.inventoryItem?.footprint || r.line.footprint || '',
          supPns: r.inventoryItem?.supPns,
          required: r.requiredTotal,
          shortage: r.shortageAmount,
        }))}
      />

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
              <BuildQtyPicker
                label="PCB Assembly Target (Multiplier)"
                value={pcbQty}
                onChange={setPcbQty}
              />
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
            
            <div className="grid grid-cols-3 gap-sm">
              <div className="bg-surface-container-high/40 p-sm rounded-lg border border-outline-variant/60 flex flex-col justify-between" title="Lines with real parts but insufficient stock. Voided lines (DNF, TEST-*, blank) are excluded.">
                <span className="text-[9px] text-outline font-label-caps uppercase leading-none block mb-1">Stock Shortages</span>
                <span className={`text-xl font-black font-mono leading-none ${totalShortagesCount > 0 ? 'text-tertiary animate-pulse' : 'text-green-400'}`}>
                  {totalShortagesCount}
                </span>
              </div>

              <div className="bg-surface-container-high/40 p-sm rounded-lg border border-outline-variant/60 flex flex-col justify-between" title="Lines with reels allocated to them (their own SKU and/or alternates).">
                <span className="text-[9px] text-outline font-label-caps uppercase leading-none block mb-1">Allocated</span>
                <span className="text-xl font-black font-mono leading-none text-primary">
                  {auditResults.filter(r => r.picks.length > 0).length}
                </span>
              </div>

              {/* Voided count — informational only. These lines are DNF, DNP,
                  test placeholders, or zero-quantity rows and don't need
                  sourcing. Grey styling so the eye doesn't read this as an
                  alarm state alongside the red shortage tile. */}
              <div className="bg-surface-container-high/40 p-sm rounded-lg border border-outline-variant/60 flex flex-col justify-between" title="Do-not-fit / do-not-populate / test-placeholder / zero-qty lines. Not sourced.">
                <span className="text-[9px] text-outline font-label-caps uppercase leading-none block mb-1">Voided</span>
                <span className={`text-xl font-black font-mono leading-none ${totalVoidedCount > 0 ? 'text-outline' : 'text-green-400'}`}>
                  {totalVoidedCount}
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

            {canChange('/api/kit-booking/execute') && pick?.status === 'OPEN' && (
              <div className="rounded-lg border border-primary/40 bg-primary/10 p-sm text-[11px] text-on-surface space-y-1" data-testid="bom-pick-status">
                <div className="flex items-center justify-between font-bold"><span>Scanning: {pick.done} of {pick.total} items picked</span><span className="font-mono">{pick.total ? Math.round((pick.done / pick.total) * 100) : 0}%</span></div>
                <div className="h-1.5 rounded-full bg-surface-container-highest overflow-hidden"><div className="h-full bg-green-500 transition-all" style={{ width: `${pick.total ? (pick.done / pick.total) * 100 : 0}%` }} /></div>
                <div className="text-outline">{pick.picker ? `${pick.picker} is scanning` : 'Waiting for a phone: /scan > SCAN BOM ITEMS'}{pick.complete ? ' · ready for the final check' : ''}</div>
              </div>
            )}
            {canChange('/api/kit-booking/execute') && <button
              onClick={() => void requestBookOut()}
              className={`w-full font-bold px-lg py-sm rounded-lg flex items-center justify-center gap-xs shadow text-xs uppercase tracking-wider transition-all duration-150 ${
                totalShortagesCount > 0 
                  ? 'bg-surface-container-highest hover:brightness-110 border border-outline-variant text-on-surface'
                  : 'bg-primary text-on-primary hover:brightness-110 active:scale-95'
              }`}
            >
              <ShoppingBag className="w-3.5 h-3.5" />
              {pick?.status === 'OPEN' ? (pick.complete ? 'Final check & book out' : 'Show the scan progress') : `Book Out Entire BOM (${auditResults.length} Lines)`}
            </button>}
          </div>
        </div>

        {/* Right Side: Interactive audit lists with alternations mapping */}
        <div className="col-span-12 lg:col-span-8 flex flex-col space-y-md">
          <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden shadow-xl">
            <div className="px-lg py-sm border-b border-outline-variant bg-surface-container-high/30 flex flex-wrap justify-between items-center gap-sm text-xs">
              <span className="font-mono text-xs uppercase tracking-tight font-black text-on-surface-variant flex items-center gap-1.5">
                <Boxes className="w-4 h-4 text-primary" />
                Project {selectedProjectId} - Direct Component Audit Rows
                {bomSearch.trim() && (
                  <span className="ml-2 text-[10px] font-mono text-outline normal-case tracking-normal">
                    showing {displayedAudit.length} of {auditResults.length}
                  </span>
                )}
              </span>
              <div className="flex items-center gap-sm">
                {/* Free-text filter — matches stock code, substituted
                    code, designator, comment, description, and the
                    resolved inventory row's description + MPN so an
                    operator searching by MPN finds the BOM line. */}
                <div className="relative">
                  <input
                    type="search"
                    value={bomSearch}
                    onChange={(e) => setBomSearch(e.target.value)}
                    placeholder="Search stock code, description, MPN…"
                    className="bg-surface-container-high border border-outline-variant rounded pl-2 pr-2 py-1 text-xs text-on-surface outline-none focus:border-primary w-[260px] placeholder:text-outline/60 font-mono"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void autoAllocateAll()}
                  disabled={autoAllocateBusy || auditResults.length === 0}
                  title="Fill every line by tier (T1 exact, then T2 same value and footprint) for this PCB quantity, across as many reels as needed, as P&P Kit Booking does. Replaces existing picks (asks first); lines with no T1/T2 match keep theirs."
                  className="h-7 px-2 rounded flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider border border-primary/40 text-primary bg-primary/10 hover:bg-primary/20 disabled:opacity-40"
                >
                  <ArrowRightLeft className="w-3 h-3" />
                  {autoAllocateBusy ? 'Allocating…' : 'Auto-allocate'}
                </button>
                <span className="font-mono text-[10px] text-outline">Multiplier: {pcbQty} PCBs</span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="stacked-mobile w-full text-left border-collapse min-w-[750px]">
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
                  {displayedAudit.map(({ line, isVoided, picks, picked, resolvedCode, inventoryItem, requiredTotal, currentStock, remainingStock, isShortage, isPrimaryReplenished, shortageAmount }) => {
                    // Check if alternates are available for substitution
                    const altOptions = getAlternatesFor(line.stockCode);
                    // While the BOM is being scanned: green once every item for this line is in.
                    const scanned = scannedLines.has(line.stockCode);
                    const scanLines = pick?.status === 'OPEN' ? pick.lines.filter(l => l.bomCode === line.stockCode) : [];
                    const scanPart = !scanned && scanLines.some(l => l.picked > 0);

                    return (
                      <tr key={line.id} data-scan-state={scanned ? 'done' : scanPart ? 'part' : undefined} className={`hover:bg-surface-variant/20 transition-all ${
                        scanned ? 'bg-green-500/10'
                        : isVoided ? 'opacity-60 bg-surface-container-highest/20'
                        : isShortage ? 'bg-red-500/5'
                        : ''
                      }`}>
                        
                        {/* SKU Reference with hover tooltips */}
                        <td className="px-lg py-3" data-label="Part">
                          <div
                            onClick={() => onItemClick?.(resolvedCode)}
                            className="font-bold font-mono text-[13px] text-primary hover:underline cursor-pointer flex items-center gap-2 select-none w-fit"
                            title="Click to view/edit component details"
                          >
                            {resolvedCode}
                            {inventoryItem?.color ? (
                              <span
                                className="inline-block w-3.5 h-3.5 rounded-full border border-white/25 shadow-sm shrink-0"
                                style={{ background: colorToCssBackground(inventoryItem.color) }}
                                title={`Colour: ${inventoryItem.color}`}
                                aria-label={`Colour: ${inventoryItem.color}`}
                              />
                            ) : (() => {
                              // Fall back to LED colour detection so LED
                              // rows still get a swatch even when nobody
                              // has stamped the color column by hand.
                              // Manually-set colour above always wins.
                              const led = detectLedSwatch(inventoryItem || { partNumber: resolvedCode });
                              if (!led) return null;
                              return (
                                <span
                                  className="inline-block w-3.5 h-3.5 rounded-full border border-outline-variant/60 shadow-inner shrink-0"
                                  style={{ background: ledSwatchBackground(led) }}
                                  title={`LED colour: ${led.label}`}
                                  aria-label={`LED colour: ${led.label}`}
                                />
                              );
                            })()}
                          </div>
                          <span className="text-[10px] text-outline block max-w-[220px] truncate leading-normal">
                            {inventoryItem ? inventoryItem.description : line.comment}
                          </span>
                          
                          {/* Substitution badge */}
                          {isPrimaryReplenished && (
                            <span className="mt-1 inline-flex items-center gap-1 text-[8.5px] font-bold text-primary font-mono uppercase bg-primary/10 border border-primary/20 px-1 py-0.5 rounded">
                              <ArrowRightLeft className="w-2.5 h-2.5" />
                              Uses alternates: {picks.filter(p => p.allocatedCode !== line.stockCode).map(p => p.allocatedCode).join(', ')}
                            </span>
                          )}

                          {line.mergedFrom > 1 && (
                            <span
                              className="mt-1 mr-1 inline-flex items-center gap-1 text-[8.5px] font-bold text-amber-500 font-mono uppercase bg-amber-500/10 border border-amber-500/20 px-1 py-0.5 rounded"
                              title={`The BOM lists ${line.stockCode} on ${line.mergedFrom} rows (the CAD export grouped its designators apart). Shown as one line: quantities added, designators ${line.designator}.`}
                            >
                              <Layers className="w-2.5 h-2.5" />
                              Merged from {line.mergedFrom} BOM rows
                            </span>
                          )}

                          {/* Saved-kit badge: names the plans that
                              reference this stockCode so the operator
                              sees at a glance whether a change here
                              affects live production plans. */}
                          {(() => {
                            const kits = kitsByStockCode[line.stockCode] || kitsByStockCode[resolvedCode] || [];
                            if (kits.length === 0) return null;
                            const label = kits.slice(0, 2).map(k => k.name).join(', ');
                            const more = kits.length > 2 ? ` +${kits.length - 2}` : '';
                            return (
                              <span
                                className="mt-1 inline-flex items-center gap-1 text-[8.5px] font-bold text-secondary font-mono uppercase bg-secondary/10 border border-secondary/20 px-1 py-0.5 rounded"
                                title={`Used in ${kits.length} saved kit${kits.length === 1 ? '' : 's'}: ${kits.map(k => k.name).join(', ')}`}
                              >
                                <Package className="w-2.5 h-2.5" />
                                In kit{kits.length === 1 ? '' : 's'}: {label}{more}
                              </span>
                            );
                          })()}
                        </td>

                        {/* Qty Per PCB */}
                        <td className="px-lg py-3 text-right font-mono text-on-surface-variant font-semibold" data-label="Per PCB">
                          {line.quantity}
                        </td>

                        {/* Calculated Target total required */}
                        <td className="px-lg py-3 text-right font-mono font-bold text-on-surface" data-label="Total needed">
                          {fmtNumber(requiredTotal)}
                        </td>

                        {/* Current inventory level */}
                        <td className="px-lg py-3 text-right font-mono" data-label="On hand">
                          <span className={`font-semibold ${currentStock < 10 ? 'text-red-400 font-black' : 'text-on-surface-variant'}`}>
                            {fmtNumber(currentStock)}
                          </span>
                          <span className="text-[9px] text-[#8c909f] block">
                            {inventoryItem?.status === 'DISCONTINUED' ? 'DISCONTINUED' : 'In Stock'}
                          </span>
                          {(() => {
                            const reserved = reservedByPart[resolvedCode] || 0;
                            if (reserved <= 0) return null;
                            const available = currentStock - reserved;
                            return (
                              <span
                                className={`text-[9px] font-mono block mt-0.5 ${available < 0 ? 'text-error font-bold' : 'text-outline'}`}
                                title="Reserved by open sales orders — the OK/SHORTAGE badge above still uses raw on-hand stock; this is the softer picture."
                              >
                                {fmtNumber(reserved)} reserved · {fmtNumber(available)} free
                              </span>
                            );
                          })()}
                        </td>

                        {/* Status checks */}
                        <td className="px-lg py-3 text-center" data-label="Status">
                          {scanned ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-green-500/20 text-green-400 border border-green-500/30 font-mono" title="Scanned on the phone">
                              <CheckCircle2 className="w-3 h-3" />
                              SCANNED
                            </span>
                          ) : isVoided ? (
                            <span
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-outline-variant/20 text-outline border border-outline-variant/40 font-mono"
                              title="Voided line — do-not-fit, test placeholder, or zero quantity. Not counted as a shortage."
                            >
                              <CornerDownRight className="w-3 h-3" />
                              VOIDED
                            </span>
                          ) : isShortage ? (
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

                        {/* Allocations across reels, as in P&P Kit Booking */}
                        <td className="px-lg py-3 text-center" data-label="Allocations">
                          {isVoided ? (
                            <span className="text-[10px] text-outline italic">Not needed</span>
                          ) : scanned ? (
                            <span className="text-[10px] text-green-400 font-bold" title="Scanned: its allocation can no longer be changed">
                              {scanLines.map(l => `${l.code} ×${fmtNumber(l.picked)}`).join(', ')}
                            </span>
                          ) : (
                            <div className="flex flex-col items-center gap-1">
                              {picks.length > 0 && (
                                <div className="flex flex-wrap justify-center gap-1 max-w-[220px]">
                                  {picks.map(p => (
                                    <span key={p.allocatedCode} className={`text-[9px] font-mono px-1 py-0.5 rounded border ${p.allocatedCode === line.stockCode ? 'border-outline-variant text-on-surface-variant' : 'border-primary/30 text-primary bg-primary/5'}`}>
                                      {p.allocatedCode} ×{fmtNumber(p.qty)}
                                    </span>
                                  ))}
                                </div>
                              )}
                              <button
                                type="button"
                                onClick={() => setAllocatingCode(line.stockCode)}
                                aria-label={`Allocate reels for ${line.stockCode}`}
                                className="text-[10px] font-bold px-2 py-0.5 rounded border border-primary/40 text-primary hover:bg-primary/10"
                              >
                                {picks.length ? 'Edit allocation' : 'Allocate'}
                              </button>
                              <span className={`text-[9px] font-mono ${picks.length ? (picked >= requiredTotal ? 'text-green-400' : 'text-red-400') : 'text-[#8c909f]'}`}>
                                {picks.length
                                  ? `${fmtNumber(picked)}/${fmtNumber(requiredTotal)} from ${picks.length} reel${picks.length === 1 ? '' : 's'}`
                                  : (() => { const n = getAlternatesFor(line.stockCode).filter(a => !scannedCodes.includes(a.partNumber)).length; return n ? `${n} alternate${n === 1 ? '' : 's'} in stock` : 'Own stock only'; })()}
                              </span>
                              {scanPart && <span className="text-[9px] font-mono text-amber-400">scanning: {scanLines.map(l => `${l.code} ${fmtNumber(l.picked)}/${fmtNumber(l.need)}`).join(', ')}</span>}
                            </div>
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
    </div>
  );
}
