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
} from 'lucide-react';

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
  const [showSaveKit, setShowSaveKit] = useState<boolean>(false);
  const [showKitBrowser, setShowKitBrowser] = useState<boolean>(false);
  const [kitBusy, setKitBusy] = useState<boolean>(false);
  // Reservations from other kits — subtracted from qty_on_hand in the
  // display so the operator sees "available to this kit" rather than
  // "on the shelf". The book-out flow still runs against the raw stock,
  // so a race can never overspend.
  const [reservations, setReservations] = useState<Record<string, number>>({});

  useEscapeKey(() => setShowSaveKit(false), showSaveKit);
  useEscapeKey(() => setShowKitBrowser(false), showKitBrowser);

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
  }, [selectedProjectId, buildQty]);

  const handleValidate = async () => {
    if (!selectedProjectId || buildQty <= 0) return;
    setLoading(true);
    try {
      const [auditRes, resRes] = await Promise.all([
        fetch('/api/kit-booking/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: selectedProjectId, buildQty })
        }),
        fetch('/api/kits/reservations'),
      ]);
      const data = await auditRes.json();
      if (data.error) throw new Error(data.error);
      setAuditResults(data);
      if (resRes.ok) {
        const map = await resRes.json();
        setReservations(map && typeof map === 'object' ? map : {});
      }
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
      const allocations = auditResults
        .filter(r => !dnfOverride.has(r.component_id) && r.resolved_part_number)
        .map(r => ({
          stockCode: r.component_id,
          allocatedCode: r.resolved_part_number,
          qty: r.qty_required,
        }));
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
          allocations,
          dnf,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || 'Save failed');
      triggerToast(`Kit "${name.trim()}" saved.`, 'SUCCESS');
      setCurrentKitName(name.trim());
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
      setCurrentKitName(kit.name || '');
      setShowKitBrowser(false);
      triggerToast(`Loaded kit "${kit.name}".`, 'SUCCESS');
      // handleValidate runs via the useEffect on buildQty/projectId change.
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

  const toggleDnfOverride = (stockCode: string) => {
    setDnfOverride(prev => {
      const next = new Set(prev);
      if (next.has(stockCode)) next.delete(stockCode); else next.add(stockCode);
      return next;
    });
  };

  const exportShortagesCsv = () => {
    const shortRows = auditResults.filter(r => !dnfOverride.has(r.component_id) && r.shortage_qty > 0);
    if (shortRows.length === 0) {
      triggerToast('No shortages to export.', 'INFO');
      return;
    }
    const esc = (v: any) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Part', 'Description', 'Designator', 'Qty per PCB', 'Needed', 'On Hand', 'Reserved elsewhere', 'Shortage', 'Alternates used'];
    const rows = shortRows.map(r => {
      const reserved = reservations[r.resolved_part_number] || 0;
      const qtyPerPcb = buildQty > 0 ? Math.round(r.qty_required / buildQty) : r.qty_required;
      return [r.component_id, r.description, r.designator || '', qtyPerPcb, r.qty_required, r.qty_on_hand, reserved, r.shortage_qty, r.used_alternative ? r.resolved_part_number : ''];
    });
    const csv = [header, ...rows].map(row => row.map(esc).join(',')).join('\n');
    const projectName = projects.find(p => p.id === selectedProjectId)?.projectName?.replace(/[^a-zA-Z0-9_-]/g, '_') || 'project';
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `${projectName}_${stamp}_shortages.csv`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    triggerToast(`Exported ${shortRows.length} shortage row(s) to ${filename}.`, 'SUCCESS');
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
                onClick={() => { setCurrentKitName(''); setDnfOverride(new Set()); }}
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
              onClick={exportShortagesCsv}
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
            {search.trim() && (
              <span className="ml-2 text-[10px] font-mono text-outline normal-case tracking-normal">
                showing {filteredResults.length} of {auditResults.length}
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
                    {res.used_alternative ? (
                      <div className="flex flex-col items-center">
                        <span className="inline-flex items-center gap-1 text-[9px] font-bold text-primary font-mono uppercase bg-primary/10 border border-primary/20 px-1 py-0.5 rounded">
                          <ArrowRightLeft className="w-2.5 h-2.5" />
                          Subbed
                        </span>
                        <span className="text-[8px] text-outline font-mono mt-1">{res.resolved_part_number}</span>
                      </div>
                    ) : (
                      <span className="text-[10px] text-outline italic">None used</span>
                    )}
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
          onLoad={handleLoadKit}
          onDelete={handleDeleteKit}
          onClose={() => setShowKitBrowser(false)}
        />
      )}
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
// Kit Browser — plain list, sorted by most recent. Load hydrates the
// kit into the audit; Delete asks for confirm via native window.confirm.
// -----------------------------------------------------------------------
function KitBrowserDialog({ kits, busy, onLoad, onDelete, onClose }: {
  kits: Array<{ id: number; name: string; projectId: number | null; projectName: string | null; buildQty: number; lockMode: boolean; updatedAt: string; bomLines: number; allocationLines: number; dnfCount: number }>;
  busy: boolean;
  onLoad: (kitId: number) => void;
  onDelete: (kitId: number, name: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const filtered = kits.filter(k => !q.trim() || `${k.name} ${k.projectName || ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="fixed inset-0 z-[200] bg-background/85 backdrop-blur-sm flex items-center justify-center p-md" onClick={onClose}>
      <div className="bg-surface-container border border-outline-variant rounded-xl shadow-2xl max-w-[720px] w-full max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-lg py-md border-b border-outline-variant flex items-center gap-sm">
          <FolderOpen className="w-4 h-4 text-primary" />
          <div className="flex-1">
            <h4 className="font-bold text-sm text-on-surface">Load Kit</h4>
            <p className="text-[10px] text-outline mt-0.5">Saved kits — pick one to load its BOM snapshot, DNF marks and buildQty into the audit.</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-surface-variant/40 text-outline hover:text-on-surface">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-lg py-sm border-b border-outline-variant">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-outline pointer-events-none" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by kit name or project…"
              className="w-full bg-surface-container-high border border-outline-variant rounded pl-7 pr-2 py-1.5 text-xs text-on-surface outline-none focus:border-primary"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="p-lg text-center text-xs text-outline italic">
              {kits.length === 0 ? 'No kits saved yet. Save your first from the header.' : `No kits match "${q}".`}
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
      </div>
    </div>
  );
}
