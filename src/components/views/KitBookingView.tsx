import React, { useState, useEffect, useMemo } from 'react';
import { Project } from '../../types';
import ShortageToPOModal from '../ShortageToPOModal';
import BomLineEditorModal from '../BomLineEditorModal';
import BuildQtyPicker from '../BuildQtyPicker';
import { useEscapeKey } from '../../lib/useEscapeKey';
import {
  Package,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Play,
  Loader2,
  Layers,
  ArrowRightLeft,
  ShoppingCart,
  Search,
  X,
  Pencil,
  Plus,
  Save,
  FolderOpen,
  Download,
  Ban,
  Lock,
  Trash2,
  Upload,
  FileText,
} from 'lucide-react';

interface ParsedKitImport {
  suggestedName: string;
  projectId: number | null;
  buildQty: number;
  notes: string;
  bom: Array<{ stockCode: string; qtyPerPcb: number; designator: string; description: string; footprint: string }>;
  allocations: Array<{ stockCode: string; allocatedCode: string; qty: number }>;
  dnf: string[];
}

// Tolerant CSV parser for BOM imports. Handles quoted fields, escaped
// quotes ("" inside "…"), CRLF line endings, and header aliases. Column
// aliases mirror the reference kitting tool's expectations:
//   part      ← stock_code, stockcode, part_number, partno, part, component
//   qty       ← qty, quantity, qty_per_pcb, qtyperpcb
//   designator← designator, ref_des, refdes
//   description ← description, desc
//   footprint ← footprint, package
function parseCsvBom(text: string): ParsedKitImport['bom'] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cell += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { cur.push(cell); cell = ''; }
      else if (ch === '\n') { cur.push(cell); rows.push(cur); cur = []; cell = ''; }
      else if (ch === '\r') { /* ignore, handled with the following \n */ }
      else cell += ch;
    }
  }
  if (cell.length || cur.length) { cur.push(cell); rows.push(cur); }
  if (rows.length < 2) return [];
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
  const header = rows[0].map(norm);
  const findCol = (aliases: string[]) => {
    for (const a of aliases) {
      const idx = header.indexOf(norm(a));
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const iPart = findCol(['stock_code', 'stockcode', 'part_number', 'partno', 'part', 'component']);
  const iQty = findCol(['qty', 'quantity', 'qty_per_pcb', 'qtyperpcb']);
  const iDes = findCol(['designator', 'ref_des', 'refdes']);
  const iDesc = findCol(['description', 'desc']);
  const iFp = findCol(['footprint', 'package']);
  if (iPart < 0 || iQty < 0) return [];
  const out: ParsedKitImport['bom'] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(c => !c.trim())) continue;
    const stockCode = String(row[iPart] || '').trim();
    const qty = parseInt(String(row[iQty] || '').trim() || '0', 10);
    if (!stockCode || !qty || qty <= 0) continue;
    out.push({
      stockCode,
      qtyPerPcb: qty,
      designator: iDes >= 0 ? String(row[iDes] || '').trim() : '',
      description: iDesc >= 0 ? String(row[iDesc] || '').trim() : '',
      footprint: iFp >= 0 ? String(row[iFp] || '').trim() : '',
    });
  }
  return out;
}

interface AuditResult {
  component_id: string;
  resolved_part_number: string;
  used_alternative: boolean;
  qty_required: number;
  qty_on_hand: number;
  shortage_qty: number;
  description: string;
  comment: string;
  designator?: string;
  supplier_links: string[];
}

interface KitBookingViewProps {
  projects: Project[];
  triggerToast: (msg: string, type?: string) => void;
  currentUser?: { role?: string } | null;
  // Called after the admin BOM editor saves. The parent uses this to
  // refetch the app-wide bomItems cache so BOM Manager (and any other
  // view reading from that state) shows the edit without waiting for
  // the next full-page reload.
  onBomChanged?: () => void;
}

export default function KitBookingView({ projects, triggerToast, currentUser, onBomChanged }: KitBookingViewProps) {
  // Admin gate for the BOM editor. The endpoints themselves are
  // admin-gated too — this just hides the affordance for non-admins so
  // they don't get error toasts trying to open something they can't use.
  const isAdmin = String(currentUser?.role || '').toLowerCase() === 'admin';
  // stockCode of the audit row currently being edited, or the sentinel
  // '' for "add a brand-new BOM line". null means the editor is closed.
  const [editorStockCode, setEditorStockCode] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<number>(projects[0]?.id || 1);
  const [buildQty, setBuildQty] = useState<number>(1);
  const [auditResults, setAuditResults] = useState<AuditResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [showShortagePOModal, setShowShortagePOModal] = useState(false);
  const [showConfirmBooking, setShowConfirmBooking] = useState(false);
  const [search, setSearch] = useState('');
  // Per-kit DNF override — a user-driven "skip this line" flag layered
  // on top of the server-side auto-DNF detection. Persisted into
  // kit_dnf on save; hydrated from a loaded kit.
  const [dnfOverride, setDnfOverride] = useState<Set<string>>(new Set());
  // Saved-kit state. currentKitName is empty until you load or save.
  const [savedKits, setSavedKits] = useState<Array<{ id: number; name: string; projectId: number | null; projectName: string | null; buildQty: number; lockMode: boolean; updatedAt: string; bomLines: number; allocationLines: number; dnfCount: number }>>([]);
  const [currentKitName, setCurrentKitName] = useState<string>('');
  const [currentKitId, setCurrentKitId] = useState<number | null>(null);
  // Per-BOM-line allocation overrides. Empty means "use the audit's
  // resolved code with the full needed qty". When the operator picks
  // specific SKUs and quantities via the allocation dialog, each row
  // ends up as { stockCode: [{allocatedCode, qty}, …] }. On kit save
  // this flat-maps into the kit_allocations payload.
  const [allocations, setAllocations] = useState<Record<string, Array<{ allocatedCode: string; qty: number }>>>({});
  const [allocatingStockCode, setAllocatingStockCode] = useState<string | null>(null);
  const [showSaveKit, setShowSaveKit] = useState<boolean>(false);
  const [showKitBrowser, setShowKitBrowser] = useState<boolean>(false);
  const [showCsvExport, setShowCsvExport] = useState<boolean>(false);
  const [kitBusy, setKitBusy] = useState<boolean>(false);
  // Reservations from other kits — subtracted from qty_on_hand in the
  // display so the operator sees "available to this kit" rather than
  // "on the shelf". The book-out flow still runs against the raw stock,
  // so a race can never overspend.
  const [reservations, setReservations] = useState<Record<string, number>>({});

  useEscapeKey(() => setShowSaveKit(false), showSaveKit);
  useEscapeKey(() => setShowKitBrowser(false), showKitBrowser);
  useEscapeKey(() => setShowCsvExport(false), showCsvExport);

  // Filter is a display-only lens over the audit — shortage math, the PO
  // modal, and the booking button all keep operating on the full result
  // set so a search box can't silently hide something the operator needs
  // to see before pressing "Process Booking".
  const filteredResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return auditResults;
    return auditResults.filter(r =>
      (r.component_id || '').toLowerCase().includes(q) ||
      (r.resolved_part_number || '').toLowerCase().includes(q) ||
      (r.description || '').toLowerCase().includes(q) ||
      (r.comment || '').toLowerCase().includes(q) ||
      (r.designator || '').toLowerCase().includes(q)
    );
  }, [auditResults, search]);

  useEscapeKey(() => setShowConfirmBooking(false), showConfirmBooking);
  useEscapeKey(() => setShowShortagePOModal(false), showShortagePOModal);

  useEffect(() => {
    if (projects.length > 0 && !projects.find(p => p.id === selectedProjectId)) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects]);

  useEffect(() => {
    handleValidate();
  }, [selectedProjectId, buildQty, currentKitId]);

  const handleValidate = async () => {
    if (!selectedProjectId || buildQty <= 0) return;
    setLoading(true);
    try {
      const auditRes = await fetch('/api/kit-booking/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: selectedProjectId,
          buildQty,
          // Loading a saved kit passes its own id so its reservations
          // aren't counted against itself — otherwise a locked kit
          // that reserves 50 of a 100-stock SKU would look like it
          // only has 50 available on reload.
          excludeKitId: currentKitId,
        })
      });
      const data = await auditRes.json();
      if (data.error) throw new Error(data.error);
      setAuditResults(data);
      // Rebuild the client-side reservation lookup from the audit
      // payload — the server already subtracted, this map is just for
      // the "−N reserved" hint.
      const nextRes: Record<string, number> = {};
      for (const r of data) {
        if (r.reserved_qty > 0) nextRes[r.resolved_part_number] = r.reserved_qty;
      }
      setReservations(nextRes);
    } catch (err: any) {
      triggerToast(`Validation failed: ${err.message}`, 'ERROR');
    } finally {
      setLoading(false);
    }
  };

  // ----- Saved-kit helpers ------------------------------------------------
  // The Save button records a snapshot: BOM lines from the current audit,
  // allocations (default = the audit's resolved code with required qty),
  // and any DNF overrides. Load hydrates all of that back and re-runs
  // validation so stock counts are always fresh — the snapshot is a
  // *plan*, not a cache of stock at save time.
  const loadSavedKits = React.useCallback(async () => {
    try {
      const res = await fetch('/api/kits');
      if (!res.ok) return;
      const data = await res.json();
      setSavedKits(Array.isArray(data) ? data : []);
    } catch {
      /* leave the list where it was; the browser modal shows an empty state */
    }
  }, []);

  useEffect(() => { loadSavedKits(); }, [loadSavedKits]);

  const handleSaveKit = async (name: string, lockMode: boolean, notes: string) => {
    if (!name.trim()) { triggerToast('Kit needs a name.', 'ERROR'); return; }
    if (auditResults.length === 0) { triggerToast('No BOM lines to save.', 'ERROR'); return; }
    setKitBusy(true);
    try {
      const bom = auditResults.map(r => ({
        stockCode: r.component_id,
        qtyPerPcb: buildQty > 0 ? Math.max(1, Math.round(r.qty_required / buildQty)) : r.qty_required,
        designator: r.designator || '',
        description: r.description || '',
        footprint: '',
      }));
      // Prefer the operator's per-line allocation overrides; where a
      // row has none, fall back to the audit's auto-resolved code with
      // the full required qty (mirrors the pre-override behaviour).
      const savedAllocations: Array<{ stockCode: string; allocatedCode: string; qty: number }> = [];
      for (const r of auditResults) {
        if (dnfOverride.has(r.component_id)) continue;
        const override = allocations[r.component_id];
        if (override && override.length > 0) {
          for (const a of override) {
            if (a.allocatedCode && a.qty > 0) {
              savedAllocations.push({ stockCode: r.component_id, allocatedCode: a.allocatedCode, qty: a.qty });
            }
          }
        } else if (r.resolved_part_number) {
          savedAllocations.push({ stockCode: r.component_id, allocatedCode: r.resolved_part_number, qty: r.qty_required });
        }
      }
      const dnf = Array.from(dnfOverride);
      const res = await fetch('/api/kits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          projectId: selectedProjectId,
          buildQty,
          lockMode,
          notes,
          bom,
          allocations: savedAllocations,
          dnf,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || 'Save failed');
      triggerToast(`Kit "${name.trim()}" saved.`, 'SUCCESS');
      setCurrentKitName(name.trim());
      if (body?.id) setCurrentKitId(body.id);
      setShowSaveKit(false);
      loadSavedKits();
      handleValidate();
    } catch (err: any) {
      triggerToast(`Save failed: ${err.message}`, 'ERROR');
    } finally {
      setKitBusy(false);
    }
  };

  const handleLoadKit = async (kitId: number) => {
    setKitBusy(true);
    try {
      const res = await fetch(`/api/kits/${kitId}`);
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const kit = await res.json();
      if (kit.projectId) setSelectedProjectId(kit.projectId);
      if (kit.buildQty) setBuildQty(kit.buildQty);
      setDnfOverride(new Set(kit.dnf || []));
      // Fold the saved kit_allocations back into the per-line map:
      // { stockCode: [{allocatedCode, qty}, …] }. A row with just one
      // allocation and allocatedCode === stockCode is effectively "no
      // override" — we still record it so the operator can see what
      // was saved.
      const nextAllocs: Record<string, Array<{ allocatedCode: string; qty: number }>> = {};
      for (const a of (kit.allocations || [])) {
        if (!nextAllocs[a.stockCode]) nextAllocs[a.stockCode] = [];
        nextAllocs[a.stockCode].push({ allocatedCode: a.allocatedCode, qty: a.qty });
      }
      setAllocations(nextAllocs);
      setCurrentKitName(kit.name || '');
      setCurrentKitId(kit.id);
      setShowKitBrowser(false);
      triggerToast(`Loaded kit "${kit.name}".`, 'SUCCESS');
      // handleValidate runs via the useEffect on buildQty/projectId/currentKitId change.
    } catch (err: any) {
      triggerToast(`Load failed: ${err.message}`, 'ERROR');
    } finally {
      setKitBusy(false);
    }
  };

  const handleDeleteKit = async (kitId: number, name: string) => {
    if (!window.confirm(`Delete kit "${name}"? Any reservations it holds will be freed.`)) return;
    setKitBusy(true);
    try {
      const res = await fetch(`/api/kits/${kitId}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Delete failed (${res.status})`);
      }
      triggerToast(`Kit "${name}" deleted.`, 'SUCCESS');
      if (currentKitName === name) setCurrentKitName('');
      loadSavedKits();
      handleValidate();
    } catch (err: any) {
      triggerToast(`Delete failed: ${err.message}`, 'ERROR');
    } finally {
      setKitBusy(false);
    }
  };

  // Import a kit from disk. Accepts .json (full kit shape) or .csv
  // (bom-only, needs project + name + buildQty from the operator). The
  // parser is tolerant: header casing / alias mismatches don't fail
  // silently, they surface as an error toast so the operator can fix
  // the file rather than getting an empty kit. Successful parses land
  // on the "review before import" step in the browser dialog.
  const handleImportKitFile = async (file: File): Promise<ParsedKitImport | null> => {
    const name = file.name.replace(/\.(json|csv|txt)$/i, '');
    const text = await file.text();
    const lower = file.name.toLowerCase();
    try {
      if (lower.endsWith('.json')) {
        const j = JSON.parse(text);
        // Accept either our own export shape (has bom[]) or a raw
        // array of {stockCode, qty, ...} — the latter is what a user
        // hand-writing a JSON dump would produce.
        const bomRaw: any[] = Array.isArray(j.bom) ? j.bom : Array.isArray(j) ? j : [];
        if (bomRaw.length === 0) throw new Error('No BOM lines in JSON');
        return {
          suggestedName: (j.name || name).toString().trim() || name,
          projectId: typeof j.projectId === 'number' ? j.projectId : null,
          buildQty: Number(j.buildQty) || 1,
          notes: (j.notes || '').toString(),
          bom: bomRaw.map(r => ({
            stockCode: String(r.stockCode || r.stock_code || r.part || r.partNumber || r.part_number || '').trim(),
            qtyPerPcb: Math.max(1, parseInt(r.qtyPerPcb || r.qty_per_pcb || r.qty || r.quantity || '1') || 1),
            designator: String(r.designator || r.ref_des || '').trim(),
            description: String(r.description || '').trim(),
            footprint: String(r.footprint || '').trim(),
          })).filter(l => l.stockCode),
          allocations: Array.isArray(j.allocations) ? j.allocations : [],
          dnf: Array.isArray(j.dnf) ? j.dnf : [],
        };
      }
      if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
        const bom = parseCsvBom(text);
        if (bom.length === 0) throw new Error('No BOM lines found in CSV. Need at least a stock-code column and a qty column.');
        return {
          suggestedName: name,
          projectId: null,
          buildQty: 1,
          notes: '',
          bom,
          allocations: [],
          dnf: [],
        };
      }
      throw new Error(`Unsupported file type: ${file.name.split('.').pop() || 'unknown'}. Accepts .json or .csv.`);
    } catch (err: any) {
      triggerToast(`Import failed: ${err.message}`, 'ERROR');
      return null;
    }
  };

  // Persist an imported/reviewed kit and load it back into the audit.
  // Runs the standard save endpoint so validation + reservations behave
  // exactly like an in-app Save Kit did, then loads by id.
  const handleCommitImportedKit = async (payload: {
    name: string; projectId: number; buildQty: number; notes: string;
    bom: Array<{ stockCode: string; qtyPerPcb: number; designator: string; description: string; footprint: string }>;
    allocations: Array<{ stockCode: string; allocatedCode: string; qty: number }>;
    dnf: string[];
  }) => {
    setKitBusy(true);
    try {
      const res = await fetch('/api/kits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, lockMode: false }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || 'Import save failed');
      triggerToast(`Imported "${payload.name}".`, 'SUCCESS');
      loadSavedKits();
      // Fall through to load — sets project, buildQty, dnf, allocations.
      await handleLoadKit(body.id);
    } catch (err: any) {
      triggerToast(`Import failed: ${err.message}`, 'ERROR');
    } finally {
      setKitBusy(false);
    }
  };

  // Serialise a kit into a JSON file the user can drop into another
  // browser / share with a colleague / stash for backup. Round-trips
  // through the same importer above.
  const handleExportKitToFile = async (kitId: number, kitName: string) => {
    try {
      const res = await fetch(`/api/kits/${kitId}`);
      if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
      const kit = await res.json();
      const blob = new Blob([JSON.stringify(kit, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${kitName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'kit'}.kit.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      triggerToast(`Export failed: ${err.message}`, 'ERROR');
    }
  };

  const toggleDnfOverride = (stockCode: string) => {
    setDnfOverride(prev => {
      const next = new Set(prev);
      if (next.has(stockCode)) next.delete(stockCode); else next.add(stockCode);
      return next;
    });
  };

  // CSV export flow: the button opens a small pre-download dialog so
  // the operator can choose whether DNF-marked rows should appear in
  // the file. Defaults to hiding them — the file's usual destination
  // is procurement, and DNF lines by definition aren't procured — but
  // audit-trail exports usually want everything, so it's one click to
  // include them (rendered with "DNF" in the Shortage column so the
  // reader can tell them apart).
  const exportShortagesCsv = (includeDnf: boolean) => {
    const inScope = auditResults.filter(r => {
      if (dnfOverride.has(r.component_id)) return includeDnf;
      return r.shortage_qty > 0;
    });
    if (inScope.length === 0) {
      triggerToast(includeDnf ? 'No shortages or DNF rows to export.' : 'No shortages to export.', 'INFO');
      return;
    }
    const esc = (v: any) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // Column order — Reserved elsewhere sits after Alternates used so
    // the substitution note reads next to the part it modifies, and the
    // stock accounting columns (On Hand / Shortage / Reserved) don't get
    // interrupted by the alternate lookup.
    const header = ['Part', 'Description', 'Designator', 'Qty per PCB', 'Needed', 'On Hand', 'Shortage', 'Alternates used', 'Reserved elsewhere'];
    const rows = inScope.map(r => {
      const isDnf = dnfOverride.has(r.component_id);
      const reserved = reservations[r.resolved_part_number] || 0;
      const qtyPerPcb = buildQty > 0 ? Math.round(r.qty_required / buildQty) : r.qty_required;
      return [
        r.component_id,
        r.description,
        r.designator || '',
        qtyPerPcb,
        r.qty_required,
        r.qty_on_hand,
        isDnf ? 'DNF' : r.shortage_qty,
        r.used_alternative ? r.resolved_part_number : '',
        reserved,
      ];
    });
    const csv = [header, ...rows].map(row => row.map(esc).join(',')).join('\n');
    const projectName = projects.find(p => p.id === selectedProjectId)?.projectName?.replace(/[^a-zA-Z0-9_-]/g, '_') || 'project';
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `${projectName}_${stamp}_shortages${includeDnf ? '_with_dnf' : ''}.csv`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    triggerToast(`Exported ${inScope.length} row(s) to ${filename}.`, 'SUCCESS');
    setShowCsvExport(false);
  };

  const handleExecute = async () => {
    setShowConfirmBooking(false);
    setExecuting(true);
    try {
      const res = await fetch('/api/kit-booking/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: selectedProjectId, buildQty })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      triggerToast('Booking processed successfully!');
      handleValidate(); // Refresh stock
    } catch (err: any) {
      triggerToast(`Booking failed: ${err.message}`);
    } finally {
      setExecuting(false);
    }
  };

  // DNF-overridden lines drop out of the shortage tally so the Process
  // Booking button is not blocked by parts the operator explicitly said
  // "do not fit for this kit". The BOM Manager's auto-void detection
  // (DNF-* stock codes) already runs server-side; this handles the
  // operator's explicit-per-kit choices layered on top.
  const totalShortages = auditResults.filter(r => !dnfOverride.has(r.component_id) && r.shortage_qty > 0).length;

  return (
    <div className="p-container-margin space-y-lg max-w-[1600px] mx-auto w-full select-none">
      <div className="bg-surface-container border border-outline-variant p-lg rounded-xl flex flex-wrap lg:items-center justify-between gap-md relative overflow-hidden">
        <div className="space-y-1 flex-1 min-w-[300px]">
          <div className="flex items-center gap-xs text-primary">
            <Package className="w-5 h-5" />
            <span className="font-label-caps text-[10px] uppercase font-bold tracking-wider">Production Logistics</span>
          </div>
          <h3 className="font-headline-sm text-lg font-black text-on-surface">Pick & Place (P&P) Kit Booking</h3>
          <p className="text-on-surface-variant text-xs max-w-[576px]">
            Audit inventory against BOM for production runs. Automatically resolves alternatives and identifies shortages.
          </p>
          {currentKitName && (
            <div className="inline-flex items-center gap-1.5 mt-1.5 px-2 py-0.5 rounded bg-primary/10 border border-primary/20 text-[10px] font-mono uppercase tracking-wider text-primary">
              <FolderOpen className="w-3 h-3" />
              Loaded kit: {currentKitName}
              <button
                type="button"
                onClick={() => { setCurrentKitName(''); setCurrentKitId(null); setDnfOverride(new Set()); setAllocations({}); }}
                className="ml-1 hover:text-on-surface"
                title="Clear the loaded-kit context"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-md">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-outline font-black uppercase tracking-wider">Project</label>
            <select
              className="bg-surface-container-high border border-outline-variant rounded px-sm py-1.5 text-xs font-bold text-on-surface outline-none focus:border-primary min-w-[200px]"
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(Number(e.target.value))}
            >
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.projectName}</option>
              ))}
            </select>
          </div>

          <BuildQtyPicker
            label="Build Quantity"
            value={buildQty}
            onChange={setBuildQty}
          />

          {/* Kit management — save the current audit as a named plan
              (with optional stock reservation), load an existing one
              back into this view, or export what's short as CSV so
              the same file can go to procurement or the shop floor. */}
          <div className="flex items-center gap-1 mt-auto">
            <button
              onClick={() => setShowSaveKit(true)}
              disabled={loading || auditResults.length === 0}
              title={auditResults.length === 0 ? 'Nothing to save yet.' : currentKitName ? `Save (currently loaded: ${currentKitName})` : 'Save this audit as a named kit'}
              className="h-9 px-3 rounded-lg flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider bg-surface-container-high border border-outline-variant text-on-surface hover:border-primary/60 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Save className="w-3.5 h-3.5" />
              Save Kit
            </button>
            <button
              onClick={() => { loadSavedKits(); setShowKitBrowser(true); }}
              disabled={loading}
              className="h-9 px-3 rounded-lg flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider bg-surface-container-high border border-outline-variant text-on-surface hover:border-primary/60 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Load Kit
            </button>
            <button
              onClick={() => setShowCsvExport(true)}
              disabled={loading || auditResults.length === 0}
              title="Download shortages for this audit as CSV"
              className="h-9 px-3 rounded-lg flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider bg-surface-container-high border border-outline-variant text-on-surface hover:border-primary/60 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Download className="w-3.5 h-3.5" />
              CSV
            </button>
          </div>

          {totalShortages > 0 && (
            <button
              onClick={() => setShowShortagePOModal(true)}
              className="mt-auto h-9 px-lg rounded-lg flex items-center gap-xs text-xs font-bold uppercase tracking-wider transition-all bg-error/10 text-error hover:bg-error/20 active:scale-95 border border-error/20"
            >
              <ShoppingCart className="w-3.5 h-3.5" />
              Generate PO
            </button>
          )}

          <button
            onClick={() => setShowConfirmBooking(true)}
            disabled={totalShortages > 0 || loading || executing || auditResults.length === 0}
            title={totalShortages > 0 ? `Booking blocked: ${totalShortages} component shortage(s). Resolve shortages or generate a PO first.` : auditResults.length === 0 ? 'No BOM data for this project.' : undefined}
            className={`mt-auto h-9 px-lg rounded-lg flex items-center gap-xs text-xs font-bold uppercase tracking-wider transition-all ${
              totalShortages > 0 || auditResults.length === 0
                ? 'bg-surface-container-highest text-outline cursor-not-allowed border border-outline-variant'
                : 'bg-primary text-on-primary hover:brightness-110 active:scale-95'
            }`}
          >
            {executing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {executing ? 'Processing...' : 'Process Booking'}
          </button>
        </div>
      </div>

      <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden shadow-xl">
        <div className="px-lg py-sm border-b border-outline-variant bg-surface-container-high/30 flex flex-wrap justify-between items-center gap-sm text-xs">
          <span className="font-mono text-xs uppercase tracking-tight font-black text-on-surface-variant flex items-center gap-1.5">
            <Layers className="w-4 h-4 text-primary" />
            Live Inventory Audit
            {/* Component count — the total number of distinct BOM
                rows the audit is tracking for this project. Rendered
                even when the search box is empty so the operator has
                a single at-a-glance number for "how big is this
                board's parts list". When a filter is on we swap to a
                showing/of readout so the number they see always
                matches the visible rows. */}
            {auditResults.length > 0 && (
              <span className="ml-2 text-[10px] font-mono text-outline normal-case tracking-normal">
                {search.trim()
                  ? `showing ${filteredResults.length} of ${auditResults.length} components`
                  : `components: ${auditResults.length}`}
              </span>
            )}
          </span>
          <div className="flex items-center gap-sm">
            {isAdmin && (
              <>
                <span
                  className="text-[10px] font-mono uppercase tracking-wider text-outline/70 italic hidden md:inline"
                  title="As an admin, double-click any row in the audit to edit its underlying BOM entries."
                >
                  double-click a row to edit
                </span>
                <button
                  type="button"
                  onClick={() => setEditorStockCode('')}
                  className="h-8 px-3 rounded-lg flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider border border-primary/40 text-primary hover:bg-primary/10 active:scale-95"
                  title="Add a new BOM line to this project"
                >
                  <Plus className="w-3 h-3" />
                  Add line
                </button>
              </>
            )}
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-outline pointer-events-none" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search part, description, designator…"
                className="bg-surface-container-high border border-outline-variant rounded pl-7 pr-7 py-1.5 text-xs text-on-surface outline-none focus:border-primary w-[280px] placeholder:text-outline/60"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-outline hover:text-on-surface p-0.5"
                  title="Clear search"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="stacked-mobile w-full text-left border-collapse min-w-[1000px]">
            <thead>
              <tr className="bg-surface-container-high text-[10px] uppercase font-mono text-outline border-b border-outline-variant">
                <th className="px-lg py-2">Component ID</th>
                <th className="px-lg py-2">Description / Comment</th>
                <th className="px-lg py-2 text-right">Required</th>
                <th className="px-lg py-2 text-right">On Hand</th>
                <th className="px-lg py-2 text-center">Status</th>
                <th className="px-lg py-2 text-center">Alternatives</th>
                <th className="px-lg py-2">Sourcing</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30 text-xs">
              {filteredResults.map((res) => (
                <tr
                  key={res.component_id}
                  onDoubleClick={isAdmin ? () => setEditorStockCode(res.component_id) : undefined}
                  className={`transition-all ${res.shortage_qty > 0 ? 'bg-red-500/5' : ''} ${isAdmin ? 'hover:bg-primary/10 cursor-pointer' : 'hover:bg-surface-variant/20'}`}
                  title={isAdmin ? 'Double-click to edit this BOM line' : undefined}
                >
                  <td className="px-lg py-3" data-label="Part">
                    <div className="font-mono font-bold text-primary">{res.component_id}</div>
                    {res.designator && (
                      <div className="text-[9px] text-outline font-mono truncate max-w-[150px]" title={res.designator}>
                        {res.designator}
                      </div>
                    )}
                  </td>
                  <td className="px-lg py-3" data-label="Description">
                    <div className="max-w-[300px] truncate font-medium text-on-surface">{res.description}</div>
                    <div className="text-[10px] text-outline italic">{res.comment}</div>
                  </td>
                  <td className="px-lg py-3 text-right font-mono font-bold" data-label="Required">
                    {res.qty_required}
                  </td>
                  <td className="px-lg py-3 text-right font-mono" data-label="On hand">
                    <span className={res.qty_on_hand < res.qty_required ? 'text-red-400 font-bold' : 'text-on-surface'}>
                      {res.qty_on_hand}
                    </span>
                    {(() => {
                      const reserved = reservations[res.resolved_part_number] || 0;
                      return reserved > 0 ? (
                        <div className="text-[9px] text-outline font-mono mt-0.5" title="Reserved by another locked kit — subtract from available">
                          −{reserved} reserved
                        </div>
                      ) : null;
                    })()}
                  </td>
                  <td className="px-lg py-3 text-center" data-label="Status">
                    {(() => {
                      const isDnf = dnfOverride.has(res.component_id);
                      if (isDnf) {
                        return (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); toggleDnfOverride(res.component_id); }}
                            title="Marked DNF for this kit — click to re-enable"
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-outline-variant/40 text-outline border border-outline-variant/60 font-mono uppercase hover:bg-outline-variant/60"
                          >
                            <Ban className="w-3 h-3" />
                            DNF
                          </button>
                        );
                      }
                      return res.shortage_qty > 0 ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-red-500/10 text-red-400 border border-red-500/15 font-mono uppercase">
                          <AlertTriangle className="w-3 h-3" />
                          Short: {res.shortage_qty}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-green-500/10 text-green-400 border border-green-500/15 font-mono uppercase">
                          <CheckCircle2 className="w-3 h-3" />
                          Ready
                        </span>
                      );
                    })()}
                    {!dnfOverride.has(res.component_id) && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); toggleDnfOverride(res.component_id); }}
                        title="Mark this line DNF for this kit (excluded from shortage calc)"
                        className="ml-1 p-0.5 rounded text-outline hover:text-on-surface hover:bg-surface-variant/40"
                      >
                        <Ban className="w-3 h-3" />
                      </button>
                    )}
                  </td>
                  <td className="px-lg py-3 text-center" data-label="Alternates">
                    {(() => {
                      const override = allocations[res.component_id];
                      const hasOverride = override && override.length > 0;
                      const totalOverride = hasOverride ? override.reduce((s, a) => s + a.qty, 0) : 0;
                      return (
                        <div className="flex flex-col items-center gap-1">
                          {hasOverride ? (
                            <>
                              <span className="inline-flex items-center gap-1 text-[9px] font-bold text-tertiary font-mono uppercase bg-tertiary/10 border border-tertiary/20 px-1 py-0.5 rounded">
                                <ArrowRightLeft className="w-2.5 h-2.5" />
                                {override.length === 1 ? override[0].allocatedCode : `${override.length} SKUs`}
                              </span>
                              <span className={`text-[8px] font-mono ${totalOverride >= res.qty_required ? 'text-green-400' : 'text-red-400'}`}>
                                {totalOverride}/{res.qty_required}
                              </span>
                            </>
                          ) : res.used_alternative ? (
                            <>
                              <span className="inline-flex items-center gap-1 text-[9px] font-bold text-primary font-mono uppercase bg-primary/10 border border-primary/20 px-1 py-0.5 rounded">
                                <ArrowRightLeft className="w-2.5 h-2.5" />
                                Subbed
                              </span>
                              <span className="text-[8px] text-outline font-mono">{res.resolved_part_number}</span>
                            </>
                          ) : (
                            <span className="text-[10px] text-outline italic">None used</span>
                          )}
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setAllocatingStockCode(res.component_id); }}
                            className="text-[9px] font-mono uppercase tracking-wider text-outline hover:text-primary underline"
                            title="Pick specific SKUs to fulfil this line"
                          >
                            Allocate
                          </button>
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-lg py-3" data-label="Sourcing">
                    {(() => {
                      // Parse into URL objects up front — anything that fails
                      // the WHATWG parser is out. This is stricter than the
                      // earlier regex and mirrors what the browser actually
                      // does before it decides whether to load a link.
                      const parsed = (res.supplier_links || [])
                        .map(v => typeof v === 'string' ? v.trim() : '')
                        .map(v => { try { return new URL(v); } catch { return null; } })
                        .filter((u): u is URL => !!u && (u.protocol === 'http:' || u.protocol === 'https:'))
                        .slice(0, 3);
                      if (parsed.length === 0) {
                        return <span className="text-[10px] text-outline italic">No links</span>;
                      }
                      const open = (u: URL) => {
                        // window.open with explicit args survives some
                        // popup blockers that reject bare <a target="_blank">.
                        // Fallback: current-tab navigation, so the user always
                        // ends up on the vendor page instead of about:blank#blocked.
                        const w = window.open(u.href, '_blank', 'noopener,noreferrer');
                        if (!w) {
                          triggerToast(`Popup blocked — opening ${u.hostname} in this tab`);
                          window.location.href = u.href;
                        }
                      };
                      return (
                        <div className="flex flex-wrap gap-1.5">
                          {parsed.map((u, idx) => {
                            const host = u.hostname.replace(/^www\./, '');
                            return (
                              <button
                                key={idx}
                                type="button"
                                onClick={() => open(u)}
                                title={u.href}
                                className="inline-flex items-center gap-1 p-1 rounded bg-surface-container-highest border border-outline-variant hover:border-primary transition-colors text-outline hover:text-primary"
                              >
                                <ExternalLink className="w-3 h-3" />
                                <span className="text-[10px] font-mono max-w-[80px] truncate">{host}</span>
                              </button>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </td>
                </tr>
              ))}
              {auditResults.length === 0 && !loading && (
                <tr>
                  <td colSpan={7} className="px-lg py-12 text-center text-outline italic font-mono">
                    No BOM data found for the selected project.
                  </td>
                </tr>
              )}
              {auditResults.length > 0 && filteredResults.length === 0 && !loading && (
                <tr>
                  <td colSpan={7} className="px-lg py-12 text-center text-outline italic font-mono">
                    No components match "{search}".
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showConfirmBooking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowConfirmBooking(false)}>
          {/* Explicit width: max-w-md would resolve to --spacing-md (16px) here. */}
          <div className="bg-surface-container border border-outline-variant rounded-xl shadow-2xl max-w-[448px] w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="px-lg py-md border-b border-outline-variant flex items-center gap-xs">
              <Play className="w-4 h-4 text-primary" />
              <h4 className="font-bold text-sm text-on-surface">Confirm Kit Booking</h4>
            </div>
            <div className="px-lg py-md text-xs text-on-surface-variant space-y-1">
              <p>
                Book out parts for <span className="font-bold text-on-surface">{buildQty} unit{buildQty === 1 ? '' : 's'}</span> of{' '}
                <span className="font-bold text-primary">{projects.find(p => p.id === selectedProjectId)?.projectName || 'selected project'}</span>?
              </p>
              <p>This will deduct stock for {auditResults.length} component line{auditResults.length === 1 ? '' : 's'} and log the transactions.</p>
            </div>
            <div className="px-lg py-md border-t border-outline-variant flex justify-end gap-sm">
              <button
                onClick={() => setShowConfirmBooking(false)}
                className="px-md py-1.5 rounded-lg text-xs font-bold border border-outline-variant text-on-surface hover:bg-surface-variant/40 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleExecute}
                className="px-md py-1.5 rounded-lg text-xs font-bold bg-primary text-on-primary hover:brightness-110 active:scale-95 transition-all flex items-center gap-xs"
              >
                <Play className="w-3 h-3" />
                Book Out Parts
              </button>
            </div>
          </div>
        </div>
      )}

      {showShortagePOModal && (
        <ShortageToPOModal
          shortages={auditResults}
          onClose={() => setShowShortagePOModal(false)}
          onSuccess={(po) => {
            setShowShortagePOModal(false);
            // Refresh audit after PO created
            handleValidate();
          }}
          triggerToast={triggerToast}
        />
      )}

      {isAdmin && editorStockCode !== null && (
        <BomLineEditorModal
          projectId={selectedProjectId}
          // empty string is our "add fresh line" sentinel; a stock code
          // string is edit-mode for that component's underlying rows.
          stockCode={editorStockCode === '' ? null : editorStockCode}
          onClose={() => setEditorStockCode(null)}
          onSaved={() => {
            setEditorStockCode(null);
            handleValidate();
            // Cascade the refresh to any other view that reads the same
            // BOM data (BOM Manager is the current consumer) so the edit
            // shows up everywhere without a page reload.
            onBomChanged?.();
          }}
          triggerToast={triggerToast}
        />
      )}

      {showSaveKit && (
        <SaveKitDialog
          initialName={currentKitName || `${projects.find(p => p.id === selectedProjectId)?.projectName || 'kit'}_${new Date().toISOString().slice(0, 10)}`}
          busy={kitBusy}
          onCancel={() => setShowSaveKit(false)}
          onSave={handleSaveKit}
        />
      )}

      {showKitBrowser && (
        <KitBrowserDialog
          kits={savedKits}
          busy={kitBusy}
          projects={projects}
          defaultProjectId={selectedProjectId}
          onLoad={handleLoadKit}
          onDelete={handleDeleteKit}
          onExport={handleExportKitToFile}
          onParseFile={handleImportKitFile}
          onCommitImport={handleCommitImportedKit}
          onClose={() => setShowKitBrowser(false)}
        />
      )}

      {showCsvExport && (
        <CsvExportDialog
          shortageCount={auditResults.filter(r => !dnfOverride.has(r.component_id) && r.shortage_qty > 0).length}
          dnfCount={auditResults.filter(r => dnfOverride.has(r.component_id)).length}
          onCancel={() => setShowCsvExport(false)}
          onExport={exportShortagesCsv}
        />
      )}

      {allocatingStockCode && (() => {
        const row = auditResults.find(r => r.component_id === allocatingStockCode);
        if (!row) return null;
        return (
          <KitAllocationDialog
            stockCode={allocatingStockCode}
            needed={row.qty_required}
            existing={allocations[allocatingStockCode] || []}
            autoResolved={row.resolved_part_number}
            reservations={reservations}
            onClose={() => setAllocatingStockCode(null)}
            onSave={(picks) => {
              setAllocations(prev => {
                const next = { ...prev };
                if (picks.length === 0) delete next[allocatingStockCode];
                else next[allocatingStockCode] = picks;
                return next;
              });
              setAllocatingStockCode(null);
            }}
            triggerToast={triggerToast}
          />
        );
      })()}
    </div>
  );
}

// -----------------------------------------------------------------------
// Save Kit dialog — small, one-purpose form. Kit name is required; lock
// mode is opt-in; notes are free-form for future-you. The parent already
// snapshots the audit into a kit_bom + kit_allocations + kit_dnf save
// payload — this dialog just collects the header fields.
// -----------------------------------------------------------------------
function SaveKitDialog({ initialName, busy, onCancel, onSave }: {
  initialName: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (name: string, lockMode: boolean, notes: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [lockMode, setLockMode] = useState(false);
  const [notes, setNotes] = useState('');
  return (
    <div className="fixed inset-0 z-[200] bg-background/85 backdrop-blur-sm flex items-center justify-center p-md" onClick={onCancel}>
      <div className="bg-surface-container border border-outline-variant rounded-xl shadow-2xl max-w-[520px] w-full" onClick={(e) => e.stopPropagation()}>
        <div className="px-lg py-md border-b border-outline-variant flex items-center gap-sm">
          <Save className="w-4 h-4 text-primary" />
          <div>
            <h4 className="font-bold text-sm text-on-surface">Save Kit</h4>
            <p className="text-[10px] text-outline mt-0.5">
              Saves the current audit as a named plan you can reload later. Reusing an existing name overwrites that kit.
            </p>
          </div>
        </div>
        <div className="px-lg py-md space-y-md">
          <div>
            <label className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-1">Kit Name *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className="w-full px-3 py-2 rounded border border-outline-variant bg-surface-container-low text-on-surface text-sm font-mono focus:outline-none focus:border-primary"
              placeholder="e.g. TCU06_batch_A"
            />
          </div>
          <label className="flex items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2.5 cursor-pointer hover:border-primary/60">
            <input
              type="checkbox"
              checked={lockMode}
              onChange={(e) => setLockMode(e.target.checked)}
              className="w-3.5 h-3.5 accent-primary"
            />
            <Lock className="w-3.5 h-3.5 text-outline" />
            <div className="flex-1">
              <div className="text-xs font-bold text-on-surface">Lock allocated stock for this kit</div>
              <div className="text-[10px] text-outline">Reserves each allocated qty. Other kits' audits will treat it as unavailable until this kit is deleted or unlocked.</div>
            </div>
          </label>
          <div>
            <label className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-1">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 rounded border border-outline-variant bg-surface-container-low text-on-surface text-xs focus:outline-none focus:border-primary resize-none"
              placeholder="Optional — anything future-you should know about this kit"
            />
          </div>
        </div>
        <div className="px-lg py-md border-t border-outline-variant flex justify-end gap-sm">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-md py-1.5 rounded-lg text-xs font-bold border border-outline-variant text-on-surface hover:bg-surface-variant/40 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(name, lockMode, notes)}
            disabled={busy || !name.trim()}
            className="px-md py-1.5 rounded-lg text-xs font-bold bg-primary text-on-primary hover:brightness-110 active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {busy ? 'Saving…' : 'Save Kit'}
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Kit Browser — server-saved kits plus a drag-and-drop / file-picker
// import zone. JSON round-trips a previous export; CSV brings in a raw
// BOM (needs project + name + buildQty confirmed on the review step).
// -----------------------------------------------------------------------
function KitBrowserDialog({ kits, busy, projects, defaultProjectId, onLoad, onDelete, onExport, onParseFile, onCommitImport, onClose }: {
  kits: Array<{ id: number; name: string; projectId: number | null; projectName: string | null; buildQty: number; lockMode: boolean; updatedAt: string; bomLines: number; allocationLines: number; dnfCount: number }>;
  busy: boolean;
  projects: Project[];
  defaultProjectId: number;
  onLoad: (kitId: number) => void;
  onDelete: (kitId: number, name: string) => void;
  onExport: (kitId: number, kitName: string) => void;
  onParseFile: (file: File) => Promise<ParsedKitImport | null>;
  onCommitImport: (payload: {
    name: string; projectId: number; buildQty: number; notes: string;
    bom: ParsedKitImport['bom']; allocations: ParsedKitImport['allocations']; dnf: string[];
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [dragOver, setDragOver] = useState(false);
  // Pending import moves the dialog into "review before saving" mode.
  // Null means we're back to the plain browser list.
  const [pending, setPending] = useState<ParsedKitImport | null>(null);
  const [pendingName, setPendingName] = useState('');
  const [pendingProjectId, setPendingProjectId] = useState<number>(defaultProjectId);
  const [pendingBuildQty, setPendingBuildQty] = useState<number>(1);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const filtered = kits.filter(k => !q.trim() || `${k.name} ${k.projectName || ''}`.toLowerCase().includes(q.toLowerCase()));

  const acceptFile = async (file: File | null | undefined) => {
    if (!file) return;
    const parsed = await onParseFile(file);
    if (!parsed) return;
    setPending(parsed);
    setPendingName(parsed.suggestedName);
    setPendingProjectId(parsed.projectId ?? defaultProjectId);
    setPendingBuildQty(parsed.buildQty || 1);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    void acceptFile(f);
  };
  const confirmImport = async () => {
    if (!pending || !pendingName.trim() || !pendingProjectId) return;
    await onCommitImport({
      name: pendingName.trim(),
      projectId: pendingProjectId,
      buildQty: pendingBuildQty,
      notes: pending.notes,
      bom: pending.bom,
      allocations: pending.allocations,
      dnf: pending.dnf,
    });
  };

  return (
    <div className="fixed inset-0 z-[200] bg-background/85 backdrop-blur-sm flex items-center justify-center p-md" onClick={onClose}>
      <div className="bg-surface-container border border-outline-variant rounded-xl shadow-2xl max-w-[720px] w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-lg py-md border-b border-outline-variant flex items-center gap-sm">
          <FolderOpen className="w-4 h-4 text-primary" />
          <div className="flex-1">
            <h4 className="font-bold text-sm text-on-surface">{pending ? 'Import kit — review' : 'Load Kit'}</h4>
            <p className="text-[10px] text-outline mt-0.5">
              {pending
                ? `Parsed ${pending.bom.length} BOM line${pending.bom.length === 1 ? '' : 's'} from disk. Confirm the details below — save posts to the same /api/kits endpoint as an in-app Save Kit, then loads it into the audit.`
                : 'Pick a saved kit to load, or drop a .json / .csv file to import a new one.'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-surface-variant/40 text-outline hover:text-on-surface">
            <X className="w-4 h-4" />
          </button>
        </div>

        {!pending && (
          <>
            {/* Drop zone / file picker. Renders above the filter so the
                cursor lands here first on a fresh open. */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={`mx-lg mt-md rounded-lg border-2 border-dashed p-md text-center transition-colors ${
                dragOver ? 'border-primary bg-primary/10' : 'border-outline-variant/60 bg-surface-container-high/30 hover:border-primary/60'
              }`}
            >
              <Upload className="w-5 h-5 mx-auto text-outline mb-1" />
              <div className="text-xs text-on-surface font-bold">Drop a .json or .csv kit file here</div>
              <div className="text-[10px] text-outline mt-0.5">
                — or —{' '}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="text-primary underline font-bold"
                >
                  choose a file
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.csv,.txt,application/json,text/csv,text/plain"
                className="hidden"
                onChange={(e) => { void acceptFile(e.target.files?.[0]); e.target.value = ''; }}
              />
              <div className="text-[10px] text-outline/70 mt-2 font-mono">
                JSON — round-trips the app's own kit export. CSV — needs at least a stock-code + qty column (aliases accepted).
              </div>
            </div>

            <div className="px-lg pt-sm pb-sm">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-outline pointer-events-none" />
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Filter saved kits by name or project…"
                  className="w-full bg-surface-container-high border border-outline-variant rounded pl-7 pr-2 py-1.5 text-xs text-on-surface outline-none focus:border-primary"
                />
              </div>
            </div>
          </>
        )}
        {pending ? (
          <>
            <div className="flex-1 overflow-y-auto px-lg py-md space-y-md">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-sm">
                <div className="md:col-span-2">
                  <label className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-1">Kit Name *</label>
                  <input
                    value={pendingName}
                    onChange={(e) => setPendingName(e.target.value)}
                    className="w-full px-3 py-2 rounded border border-outline-variant bg-surface-container-low text-on-surface text-sm font-mono focus:outline-none focus:border-primary"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-1">Build Qty</label>
                  <input
                    type="number"
                    min={1}
                    value={pendingBuildQty}
                    onChange={(e) => setPendingBuildQty(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-full px-3 py-2 rounded border border-outline-variant bg-surface-container-low text-on-surface text-sm font-mono focus:outline-none focus:border-primary text-right"
                  />
                </div>
                <div className="md:col-span-3">
                  <label className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-1">Project *</label>
                  <select
                    value={pendingProjectId}
                    onChange={(e) => setPendingProjectId(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded border border-outline-variant bg-surface-container-low text-on-surface text-sm focus:outline-none focus:border-primary"
                  >
                    {projects.map(p => (
                      <option key={p.id} value={p.id}>{p.projectName}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <div className="text-[10px] font-bold text-outline uppercase tracking-wider mb-1">
                  BOM preview — {pending.bom.length} line{pending.bom.length === 1 ? '' : 's'}
                  {pending.allocations.length > 0 && ` · ${pending.allocations.length} allocation${pending.allocations.length === 1 ? '' : 's'}`}
                  {pending.dnf.length > 0 && ` · ${pending.dnf.length} DNF`}
                </div>
                <div className="rounded-lg border border-outline-variant/40 bg-surface-container-low overflow-hidden">
                  <table className="w-full text-left text-[11px]">
                    <thead className="bg-surface-container-high/40 text-[9px] uppercase font-mono text-outline">
                      <tr>
                        <th className="px-2 py-1">Stock Code</th>
                        <th className="px-2 py-1 text-right">Qty/PCB</th>
                        <th className="px-2 py-1">Designator</th>
                        <th className="px-2 py-1">Description</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/20">
                      {pending.bom.slice(0, 8).map((l, i) => (
                        <tr key={i}>
                          <td className="px-2 py-1 font-mono font-bold text-primary">{l.stockCode}</td>
                          <td className="px-2 py-1 text-right font-mono">{l.qtyPerPcb}</td>
                          <td className="px-2 py-1 font-mono text-outline">{l.designator || '—'}</td>
                          <td className="px-2 py-1 text-outline truncate max-w-[240px]">{l.description || '—'}</td>
                        </tr>
                      ))}
                      {pending.bom.length > 8 && (
                        <tr>
                          <td colSpan={4} className="px-2 py-1 text-center text-outline italic text-[10px]">
                            …and {pending.bom.length - 8} more
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div className="px-lg py-md border-t border-outline-variant flex justify-end gap-sm">
              <button
                type="button"
                onClick={() => setPending(null)}
                disabled={busy}
                className="px-md py-1.5 rounded-lg text-xs font-bold border border-outline-variant text-on-surface hover:bg-surface-variant/40 disabled:opacity-40"
              >
                Back
              </button>
              <button
                type="button"
                onClick={confirmImport}
                disabled={busy || !pendingName.trim() || !pendingProjectId || pending.bom.length === 0}
                className="px-md py-1.5 rounded-lg text-xs font-bold bg-primary text-on-primary hover:brightness-110 active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {busy ? 'Importing…' : 'Save & Load'}
              </button>
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto border-t border-outline-variant/50">
            {filtered.length === 0 ? (
              <div className="p-lg text-center text-xs text-outline italic">
                {kits.length === 0 ? 'No kits saved yet. Save your first from the header, or drop a file above.' : `No kits match "${q}".`}
              </div>
            ) : (
              <div className="divide-y divide-outline-variant/30">
                {filtered.map(k => (
                  <div key={k.id} className="px-lg py-sm flex items-start gap-sm hover:bg-surface-variant/20">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-primary truncate">{k.name}</span>
                        {k.lockMode && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20 uppercase font-mono">
                            <Lock className="w-2.5 h-2.5" /> Locked
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-outline font-mono mt-0.5">
                        {k.projectName || '(project deleted)'} · build {k.buildQty} · {k.bomLines} lines · {k.dnfCount} DNF · updated {new Date(k.updatedAt).toLocaleString()}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onLoad(k.id)}
                      disabled={busy}
                      className="px-3 py-1 rounded text-[10px] font-bold uppercase tracking-wider bg-primary text-on-primary hover:brightness-110 active:scale-95 disabled:opacity-40"
                    >
                      Load
                    </button>
                    <button
                      type="button"
                      onClick={() => onExport(k.id, k.name)}
                      disabled={busy}
                      className="p-1.5 rounded text-outline hover:text-primary hover:bg-primary/10 disabled:opacity-40"
                      title="Export kit to .json file for backup / round-trip"
                    >
                      <FileText className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(k.id, k.name)}
                      disabled={busy}
                      className="p-1.5 rounded text-outline hover:text-error hover:bg-error/10 disabled:opacity-40"
                      title="Delete kit (admin only)"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Multi-tier allocation dialog. Fetches candidate SKUs from
// /api/kits/match/:stockCode (T1 exact → T4 substring) and lets the
// operator pick one or more, with a per-pick qty. Running total in the
// footer is compared against `needed` so the operator can see whether
// the plan covers the requirement. Reserved-elsewhere qty is shown
// per candidate so a "500 in stock, 400 reserved" row is honest about
// what's actually free.
// -----------------------------------------------------------------------
interface MatchCandidate {
  serialNumber: string;
  name: string;
  description: string;
  footprint: string;
  stock: number;
  status: string;
  matchTier: number;
  matchNote: string;
}
function KitAllocationDialog({ stockCode, needed, existing, autoResolved, reservations, onClose, onSave, triggerToast }: {
  stockCode: string;
  needed: number;
  existing: Array<{ allocatedCode: string; qty: number }>;
  autoResolved: string;
  reservations: Record<string, number>;
  onClose: () => void;
  onSave: (picks: Array<{ allocatedCode: string; qty: number }>) => void;
  triggerToast: (msg: string, type?: string) => void;
}) {
  const [candidates, setCandidates] = useState<MatchCandidate[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  // Picks are keyed by SKU serial. qty=0 means "not selected".
  const [picks, setPicks] = useState<Record<string, number>>(() => {
    const seed: Record<string, number> = {};
    for (const e of existing) seed[e.allocatedCode] = e.qty;
    return seed;
  });
  useEscapeKey(onClose, true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/kits/match/${encodeURIComponent(stockCode)}`)
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        if (cancelled) return;
        const list: MatchCandidate[] = Array.isArray(data) ? data : [];
        setCandidates(list);
        // Auto-preselect on first open with no existing overrides:
        // greedy-fill T1 → T4 so a short T1 automatically spills to
        // T2, T3, then T4. Saves the operator opening the dialog just
        // to click Auto-fill for the common case, and demonstrates that
        // multiple SKUs can be combined out of the box.
        if (existing.length === 0 && list.length > 0) {
          const seed: Record<string, number> = {};
          let remaining = needed;
          for (const c of list) {
            if (remaining <= 0) break;
            const avail = Math.max(0, c.stock - (reservations[c.serialNumber] || 0));
            const take = Math.min(avail, remaining);
            if (take > 0) { seed[c.serialNumber] = take; remaining -= take; }
          }
          setPicks(seed);
        }
      })
      .catch(() => triggerToast('Match lookup failed.', 'ERROR'))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [stockCode]);

  const totalPicked = Object.values(picks).reduce((s, q) => s + (q || 0), 0);
  const shortfall = needed - totalPicked;

  const setQty = (serial: string, qty: number) => {
    setPicks(prev => {
      const next = { ...prev };
      if (qty <= 0) delete next[serial]; else next[serial] = qty;
      return next;
    });
  };

  // Per-row: top up this SKU by whatever's still short, capped by its
  // available stock. Leaves other picks alone — the operator can combine
  // multiple candidates by clicking Fill on each until the footer reads
  // Picked >= Needed.
  const availableFor = (c: MatchCandidate) => Math.max(0, c.stock - (reservations[c.serialNumber] || 0));
  const fillRowToShortfall = (c: MatchCandidate) => {
    const current = picks[c.serialNumber] || 0;
    const otherPicks = totalPicked - current;
    const stillNeeded = Math.max(0, needed - otherPicks);
    const target = Math.min(stillNeeded, availableFor(c));
    setQty(c.serialNumber, target);
  };

  // Footer: greedy fill by tier order. Clears whatever's there and walks
  // T1 → T4, taking min(available, remaining shortfall) from each. Stops
  // when the requirement is covered. The starting-fresh choice matches
  // "distribute this line across alternates for me" — if the operator
  // wanted to preserve a manual pick, they can Fill per-row instead.
  const autoFillByTier = () => {
    const next: Record<string, number> = {};
    let remaining = needed;
    for (const c of candidates) {
      if (remaining <= 0) break;
      const take = Math.min(availableFor(c), remaining);
      if (take > 0) {
        next[c.serialNumber] = take;
        remaining -= take;
      }
    }
    setPicks(next);
  };

  const save = () => {
    const out = Object.entries(picks)
      .filter(([, q]) => q > 0)
      .map(([allocatedCode, qty]) => ({ allocatedCode, qty }));
    onSave(out);
  };

  const clearAll = () => setPicks({});

  return (
    <div className="fixed inset-0 z-[210] bg-background/85 backdrop-blur-sm flex items-center justify-center p-md" onClick={onClose}>
      <div className="bg-surface-container border border-outline-variant rounded-xl shadow-2xl max-w-[960px] w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-lg py-md border-b border-outline-variant flex items-center gap-sm">
          <ArrowRightLeft className="w-4 h-4 text-primary" />
          <div className="flex-1">
            <h4 className="font-bold text-sm text-on-surface">Allocate for {stockCode}</h4>
            <p className="text-[10px] text-outline mt-0.5">
              Pick one or more SKUs to fulfil this line — the picked qtys add up against Needed. Use Fill per row to top up from that candidate, or Auto-fill by tier to greedy-fill T1 → T4. T1 is the exact primary; T2/T3 are like-for-like; T4 is a fuzzy match — verify before use. Reserved qty from other locked kits is shown so what you allocate is honest.
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-surface-variant/40 text-outline hover:text-on-surface">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-xs text-outline">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Finding candidates…
            </div>
          ) : candidates.length === 0 ? (
            <div className="py-12 text-center text-xs text-outline italic">
              No candidates found for {stockCode}. Only the auto-resolved SKU ({autoResolved}) will be used on save.
            </div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-surface-container-high/95">
                <tr className="text-[10px] uppercase font-mono text-outline border-b border-outline-variant">
                  <th className="px-md py-2 w-[60px]">Tier</th>
                  <th className="px-md py-2">SKU</th>
                  <th className="px-md py-2">Name / Footprint</th>
                  <th className="px-md py-2 text-right">Stock</th>
                  <th className="px-md py-2 text-right">Reserved</th>
                  <th className="px-md py-2 text-right">Available</th>
                  <th className="px-md py-2 text-right w-[170px]">Allocate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30">
                {candidates.map(c => {
                  const reserved = reservations[c.serialNumber] || 0;
                  const available = Math.max(0, c.stock - reserved);
                  const picked = picks[c.serialNumber] || 0;
                  const tierClass =
                    c.matchTier === 1 ? 'bg-primary/10 text-primary border-primary/20'
                    : c.matchTier === 2 ? 'bg-green-500/10 text-green-400 border-green-500/20'
                    : c.matchTier === 3 ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
                    : 'bg-outline-variant/20 text-outline border-outline-variant/40';
                  const isSelected = picked > 0;
                  return (
                    <tr
                      key={c.serialNumber}
                      className={`transition-all ${
                        isSelected
                          ? 'bg-primary/15 border-l-4 border-l-primary shadow-[inset_2px_0_0_var(--md-sys-color-primary)]'
                          : 'border-l-4 border-l-transparent hover:bg-surface-variant/20'
                      }`}
                    >
                      <td className="px-md py-2">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold font-mono uppercase border ${tierClass}`}>
                          T{c.matchTier}
                        </span>
                      </td>
                      <td className="px-md py-2 font-mono font-bold">
                        <div className="flex items-center gap-1.5">
                          {isSelected ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" />
                          ) : (
                            <span className="w-3.5 h-3.5 rounded-full border border-outline-variant/60 shrink-0" />
                          )}
                          <span className={isSelected ? 'text-primary' : 'text-on-surface'}>{c.serialNumber}</span>
                        </div>
                      </td>
                      <td className="px-md py-2 max-w-[280px]">
                        <div className="truncate text-on-surface">{c.name || c.description}</div>
                        <div className="text-[10px] text-outline font-mono">{c.footprint || '—'} · {c.matchNote}</div>
                      </td>
                      <td className="px-md py-2 text-right font-mono text-on-surface">{c.stock}</td>
                      <td className="px-md py-2 text-right font-mono text-outline">{reserved > 0 ? `−${reserved}` : '—'}</td>
                      <td className={`px-md py-2 text-right font-mono font-bold ${available === 0 ? 'text-red-400' : 'text-on-surface'}`}>{available}</td>
                      <td className="px-md py-2">
                        <div className="flex items-center justify-end gap-1">
                          <input
                            type="number"
                            min={0}
                            max={Math.max(available, picked)}
                            value={picked}
                            onChange={(e) => setQty(c.serialNumber, Math.max(0, parseInt(e.target.value) || 0))}
                            className={`w-[90px] px-2 py-1 rounded border text-xs font-mono text-right focus:outline-none focus:border-primary transition-colors ${
                              isSelected
                                ? 'border-primary bg-primary/10 text-primary font-bold'
                                : 'border-outline-variant bg-surface-container-low text-on-surface'
                            }`}
                          />
                          <button
                            type="button"
                            onClick={() => fillRowToShortfall(c)}
                            disabled={available === 0}
                            title={available === 0 ? 'No stock available' : 'Top up this row to cover as much of the remaining shortfall as its available stock allows'}
                            className="px-1.5 py-1 rounded text-[10px] font-bold uppercase border border-outline-variant text-outline hover:text-primary hover:border-primary/60 disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            Fill
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-lg py-md border-t border-outline-variant flex items-center justify-between gap-sm bg-surface-container-high/30">
          {(() => {
            const selectedCount = Object.values(picks).filter(q => q > 0).length;
            return (
              <div className="text-xs flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-primary/10 border border-primary/20 text-primary font-mono font-bold">
                  <CheckCircle2 className="w-3 h-3" />
                  {selectedCount} selected
                </span>
                <span className="text-outline">Needed: </span>
                <span className="font-mono font-bold text-on-surface">{needed}</span>
                <span className="text-outline">·</span>
                <span className="text-outline">Picked: </span>
                <span className={`font-mono font-bold ${totalPicked >= needed ? 'text-green-400' : 'text-red-400'}`}>{totalPicked}</span>
                {shortfall > 0 && (
                  <>
                    <span className="text-outline">·</span>
                    <span className="text-red-400 font-mono font-bold">Short {shortfall}</span>
                  </>
                )}
                {shortfall <= 0 && selectedCount > 0 && (
                  <>
                    <span className="text-outline">·</span>
                    <span className="text-green-400 font-mono font-bold inline-flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Covered
                    </span>
                  </>
                )}
              </div>
            );
          })()}
          <div className="flex gap-sm">
            <button
              type="button"
              onClick={autoFillByTier}
              disabled={candidates.length === 0}
              title="Clear picks and greedy-fill from T1 → T4 (uses each candidate's available stock in tier order until the requirement is covered)"
              className="px-md py-1.5 rounded-lg text-xs font-bold border border-primary/40 text-primary hover:bg-primary/10 active:scale-95 disabled:opacity-40"
            >
              Auto-fill by tier
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="px-md py-1.5 rounded-lg text-xs font-bold border border-outline-variant text-on-surface hover:bg-surface-variant/40"
            >
              Clear all
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-md py-1.5 rounded-lg text-xs font-bold border border-outline-variant text-on-surface hover:bg-surface-variant/40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              className="px-md py-1.5 rounded-lg text-xs font-bold bg-primary text-on-primary hover:brightness-110 active:scale-95 flex items-center gap-1.5"
            >
              <Save className="w-3.5 h-3.5" />
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// CSV export dialog — one gate before the download so the operator can
// choose whether DNF-marked rows should be included. Defaults to hiding
// them: purchase orders never buy DNF parts, so the common export is
// procurement-shaped. Turning the checkbox on gives a full audit-trail
// dump with "DNF" written into the Shortage column so the reader can
// tell those rows apart. Checkbox disables (and count of DNF row info
// hides) when the current audit has none.
// -----------------------------------------------------------------------
function CsvExportDialog({ shortageCount, dnfCount, onCancel, onExport }: {
  shortageCount: number;
  dnfCount: number;
  onCancel: () => void;
  onExport: (includeDnf: boolean) => void;
}) {
  const [includeDnf, setIncludeDnf] = useState<boolean>(false);
  const total = shortageCount + (includeDnf ? dnfCount : 0);
  return (
    <div className="fixed inset-0 z-[200] bg-background/85 backdrop-blur-sm flex items-center justify-center p-md" onClick={onCancel}>
      <div className="bg-surface-container border border-outline-variant rounded-xl shadow-2xl max-w-[460px] w-full" onClick={(e) => e.stopPropagation()}>
        <div className="px-lg py-md border-b border-outline-variant flex items-center gap-sm">
          <Download className="w-4 h-4 text-primary" />
          <div>
            <h4 className="font-bold text-sm text-on-surface">Export shortages CSV</h4>
            <p className="text-[10px] text-outline mt-0.5">
              {shortageCount} shortage row{shortageCount === 1 ? '' : 's'}{dnfCount > 0 ? ` · ${dnfCount} DNF row${dnfCount === 1 ? '' : 's'} available` : ''}.
            </p>
          </div>
        </div>
        <div className="px-lg py-md space-y-md">
          <label className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 ${dnfCount === 0 ? 'border-outline-variant/50 opacity-50 cursor-not-allowed' : 'border-outline-variant bg-surface-container-low hover:border-primary/60 cursor-pointer'}`}>
            <input
              type="checkbox"
              checked={includeDnf}
              onChange={(e) => setIncludeDnf(e.target.checked)}
              disabled={dnfCount === 0}
              className="mt-0.5 w-3.5 h-3.5 accent-primary"
            />
            <div className="flex-1">
              <div className="text-xs font-bold text-on-surface">Include DNF parts</div>
              <div className="text-[10px] text-outline">
                DNF-marked rows appear with &quot;DNF&quot; in the Shortage column so procurement can filter them out. Off by default because purchase orders skip them anyway.
              </div>
            </div>
          </label>
          <div className="text-[10px] text-outline font-mono">
            Will download {total} row{total === 1 ? '' : 's'}.
          </div>
        </div>
        <div className="px-lg py-md border-t border-outline-variant flex justify-end gap-sm">
          <button
            type="button"
            onClick={onCancel}
            className="px-md py-1.5 rounded-lg text-xs font-bold border border-outline-variant text-on-surface hover:bg-surface-variant/40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onExport(includeDnf)}
            disabled={total === 0}
            className="px-md py-1.5 rounded-lg text-xs font-bold bg-primary text-on-primary hover:brightness-110 active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            Download CSV
          </button>
        </div>
      </div>
    </div>
  );
}
