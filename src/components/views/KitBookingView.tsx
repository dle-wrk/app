import React, { useState, useEffect, useMemo } from 'react';

// Preset build quantities used by the "shortages at preset qtys"
// grid on the audit table. Same list the BuildQtyPicker offers, so
// what the operator sees in the preview matches what they'd get if
// they picked one of these presets as the active build quantity.
const PRESET_QTYS = [50, 100, 250, 500, 1000] as const;
import { Project } from '../../types';
import ShortageToPOModal from '../ShortageToPOModal';
import BomLineEditorModal from '../BomLineEditorModal';
import BuildQtyPicker from '../BuildQtyPicker';
import { formatRelativeTime } from './ProjectsView';
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
  History,
} from 'lucide-react';

// Maps a free-text colour string ("Red", "Yellow-Green", "RGB",
// "Warm White", …) to a CSS background that's roughly the right hue.
// Unrecognised strings get a plain grey so the swatch is at least
// visible. Kept out of a Tailwind class map so operators can invent
// their own colours without a code change.
export function colorToCssBackground(raw?: string): string {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '#666';
  if (s === 'rgb' || s === 'rgb led') return 'linear-gradient(90deg,#e11d48 0%, #16a34a 50%, #2563eb 100%)';
  if (/(bi[-\s]?colour|bi[-\s]?color|dual)/.test(s)) return 'linear-gradient(90deg,#e11d48,#16a34a)';
  if (/warm.*white/.test(s)) return '#fef3c7';
  if (/cool.*white|white/.test(s)) return '#f5f5f5';
  // Compound colours like "yellow-green" or "amber orange" — pick the
  // first named token that CSS knows about.
  const tokens = s.split(/[\s\-\/]+/).filter(Boolean);
  const named: Record<string, string> = {
    red: '#dc2626', orange: '#ea580c', amber: '#f59e0b', yellow: '#eab308',
    'yellow-green': '#a3e635', green: '#16a34a', teal: '#0d9488', cyan: '#06b6d4',
    blue: '#2563eb', royal: '#1d4ed8', navy: '#1e3a8a', purple: '#9333ea',
    violet: '#7c3aed', magenta: '#c026d3', pink: '#ec4899', ir: '#7f1d1d',
    uv: '#5b21b6', white: '#f5f5f5', black: '#111', grey: '#6b7280', gray: '#6b7280',
  };
  for (const t of tokens) if (named[t]) return named[t];
  return '#6b7280';
}

// Container styling for the colour chip — light border + faint fill
// tinted to the chosen colour so the pill reads as belonging to it
// without overpowering the row.
export function colorChipStyle(raw?: string): React.CSSProperties {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return { background: '#374151', color: '#e5e7eb', borderColor: '#4b5563' };
  const dot = colorToCssBackground(s);
  // Solid colour dot uses colour directly; gradient (RGB / dual) falls
  // back to a neutral chip.
  if (dot.startsWith('linear')) return { background: 'rgba(255,255,255,0.05)', color: '#e5e7eb', borderColor: 'rgba(255,255,255,0.2)' };
  return { background: `${dot}22`, color: '#e5e7eb', borderColor: `${dot}88` };
}

interface ParsedKitImport {
  suggestedName: string;
  projectId: number | null;
  buildQty: number;
  notes: string;
  bom: Array<{ stockCode: string; qtyPerPcb: number; designator: string; description: string; footprint: string }>;
  allocations: Array<{ stockCode: string; allocatedCode: string; qty: number }>;
  dnf: string[];
}

// A raw CSV import that still needs the operator to confirm which
// column carries which field. The dialog surfaces this shape so the
// mapping UI can render the actual headers verbatim.
interface ParsedCsvFile {
  suggestedName: string;
  headers: string[];
  rows: string[][];
  // Auto-guessed mapping — index into headers, or null if no alias hit.
  // The operator can override every field in the dialog.
  autoMap: CsvColumnMapping;
}

interface CsvColumnMapping {
  part: number | null;
  qty: number | null;
  designator: number | null;
  description: number | null;
  footprint: number | null;
}

type ParsedImport =
  | { kind: 'json'; kit: ParsedKitImport }
  | { kind: 'csv'; csv: ParsedCsvFile };

// Two-step CSV import.
//
//   parseCsvStructural(text)     — pure delimiter/quotes parser, no
//                                  semantics. Returns headers + rows.
//   guessColumnMapping(headers)  — tries to auto-pair the header row
//                                  against alias sets so the mapping
//                                  UI opens pre-populated for typical
//                                  BOM exports.
//   applyCsvMapping(rows, map)   — turns raw rows + a confirmed mapping
//                                  into ParsedKitImport['bom'] once the
//                                  operator hits Continue.

function parseCsvStructural(text: string): { headers: string[]; rows: string[][] } {
  // Excel likes to inject a UTF-8 BOM. Strip it so the first header
  // doesn't silently start with an invisible ﻿ character.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  // Sniff delimiter from the first non-blank line: comma / semicolon /
  // tab. EU Excel writes ';'; CAD tools often emit tab.
  const firstLine = text.split(/\r?\n/).find(l => l.trim()) || '';
  const counts: Record<string, number> = {
    ',': (firstLine.match(/,/g) || []).length,
    ';': (firstLine.match(/;/g) || []).length,
    '\t': (firstLine.match(/\t/g) || []).length,
  };
  let delimiter: string = ',';
  let best = -1;
  for (const [d, c] of Object.entries(counts)) if (c > best) { best = c; delimiter = d; }

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
      else if (ch === delimiter) { cur.push(cell); cell = ''; }
      else if (ch === '\n') { cur.push(cell); rows.push(cur); cur = []; cell = ''; }
      else if (ch === '\r') { /* handled with the following \n */ }
      else cell += ch;
    }
  }
  if (cell.length || cur.length) { cur.push(cell); rows.push(cur); }
  if (rows.length === 0) throw new Error('The file is empty.');
  const headers = rows[0].map(c => c.trim());
  const dataRows = rows.slice(1).filter(r => r && !r.every(c => !c.trim()));
  return { headers, rows: dataRows };
}

const CSV_PART_ALIASES = [
  'stock_code', 'stockcode', 'internal_stock_number', 'internalstocknumber',
  'part_number', 'partnumber', 'partno', 'part', 'component',
  'mpn', 'manufacturer_part_number', 'sku', 'reference',
];
const CSV_QTY_ALIASES = ['qty', 'quantity', 'qty_per_pcb', 'qtyperpcb', 'count', 'placements', 'boardqty'];
const CSV_DES_ALIASES = ['designator', 'ref_des', 'refdes', 'designators', 'reference_designator'];
const CSV_DESC_ALIASES = ['description', 'desc', 'comment'];
const CSV_FP_ALIASES = ['footprint', 'package', 'case'];

function guessColumnMapping(headers: string[]): CsvColumnMapping {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_/\-()]+/g, '').replace(/[^\w]/g, '');
  const H = headers.map(norm);
  const find = (aliases: string[]) => {
    for (const a of aliases) {
      const idx = H.indexOf(norm(a));
      if (idx >= 0) return idx;
    }
    return null;
  };
  return {
    part: find(CSV_PART_ALIASES),
    qty: find(CSV_QTY_ALIASES),
    designator: find(CSV_DES_ALIASES),
    description: find(CSV_DESC_ALIASES),
    footprint: find(CSV_FP_ALIASES),
  };
}

function applyCsvMapping(rows: string[][], map: CsvColumnMapping): ParsedKitImport['bom'] {
  const out: ParsedKitImport['bom'] = [];
  if (map.part == null || map.qty == null) return out;
  for (const row of rows) {
    const stockCode = String(row[map.part] || '').trim();
    // "1.0" or "1,0" (EU decimal comma) both coerce.
    const rawQty = String(row[map.qty] || '').trim().replace(',', '.');
    const qty = parseInt(rawQty || '0', 10);
    if (!stockCode || !qty || qty <= 0) continue;
    out.push({
      stockCode,
      qtyPerPcb: qty,
      designator: map.designator != null ? String(row[map.designator] || '').trim() : '',
      description: map.description != null ? String(row[map.description] || '').trim() : '',
      footprint: map.footprint != null ? String(row[map.footprint] || '').trim() : '',
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
  reserved_qty?: number;
  shortage_qty: number;
  description: string;
  comment: string;
  designator?: string;
  supplier_links: string[];
  // Manufacturer part number, populated from the first non-empty
  // man_pn_* on the inventory row. Used by the Sourcing column as a
  // fallback link (Google search) when no supplier weblinks exist.
  manufacturer_part_number?: string;
  // Free-text colour marker from inventory.color. Rendered as a chip
  // in the Component ID column when populated — mainly LEDs but any
  // SKU with a colour value shows the badge.
  color?: string;
}

interface KitBookingViewProps {
  projects: Project[];
  triggerToast: (msg: string, type?: string) => void;
  currentUser?: { role?: string; email?: string; firstName?: string } | null;
  // Called after the admin BOM editor saves. The parent uses this to
  // refetch the app-wide bomItems cache so BOM Manager (and any other
  // view reading from that state) shows the edit without waiting for
  // the next full-page reload.
  onBomChanged?: () => void;
  // Fired after any write that touches the projects table's
  // updated_at column (BOM sync, admin BOM save, anything server-side
  // that bumps the timestamp). Parent uses it to re-hydrate the
  // projects state so the "Last edited" chip in ProjectsView + the
  // header chip here reflect the new activity without a page reload.
  onProjectsChanged?: () => void;
}

export default function KitBookingView({ projects, triggerToast, currentUser, onBomChanged, onProjectsChanged }: KitBookingViewProps) {
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
  // Presence: other editors seen on the currently-loaded kit within
  // the last minute. Populated by the 10-second poll below and used
  // to render the blinking "X is editing" banner.
  const [otherEditors, setOtherEditors] = useState<Array<{ email: string; name: string }>>([]);
  // Kit updated_at tracked across polls. When the server's copy moves
  // AND we didn't just save, another user landed a save on the same
  // kit — show the "Kit updated by X — refresh" banner.
  const [remoteUpdatedAt, setRemoteUpdatedAt] = useState<string | null>(null);
  const [kitDirtyRemote, setKitDirtyRemote] = useState<boolean>(false);
  const currentUserEmail = String(currentUser?.email || '').toLowerCase();
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
  const [showPresetCsvs, setShowPresetCsvs] = useState<boolean>(false);
  const [kitBusy, setKitBusy] = useState<boolean>(false);
  // Reservations from other kits — subtracted from qty_on_hand in the
  // display so the operator sees "available to this kit" rather than
  // "on the shelf". The book-out flow still runs against the raw stock,
  // so a race can never overspend.
  const [reservations, setReservations] = useState<Record<string, number>>({});

  useEscapeKey(() => setShowSaveKit(false), showSaveKit);
  useEscapeKey(() => setShowKitBrowser(false), showKitBrowser);
  useEscapeKey(() => setShowCsvExport(false), showCsvExport);
  useEscapeKey(() => setShowPresetCsvs(false), showPresetCsvs);

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
      // Auto-DNF any stock code matching the DNF convention
      // (bare "DNF" or "DNF-*" prefix). Operator can toggle any of
      // these back on with the row's DNF pill. Keeps existing manual
      // overrides untouched — merges rather than replacing.
      setDnfOverride(prev => {
        const next = new Set(prev);
        for (const r of data as AuditResult[]) {
          if (/^DNF(-|$)/i.test(String(r.component_id || ''))) next.add(r.component_id);
        }
        return next;
      });
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

  // Presence heartbeat + poll for the currently-loaded kit.
  // - Every 10s we heartbeat (POST) to say we're editing.
  // - Every 10s we read the roster (GET) and stash the kit's
  //   updated_at. If it moves and we didn't just save, another editor
  //   landed a save on the same kit and we surface a refresh banner.
  // - On kit change / unmount we delete our own presence row so the
  //   banner disappears from other viewers immediately.
  useEffect(() => {
    if (!currentKitId || !currentUserEmail) {
      setOtherEditors([]);
      setRemoteUpdatedAt(null);
      setKitDirtyRemote(false);
      return;
    }
    let cancelled = false;
    const kitId = currentKitId;

    const beat = async () => {
      try { await fetch(`/api/kits/${kitId}/presence`, { method: 'POST' }); } catch { /* noop */ }
    };
    const roster = async () => {
      try {
        const r = await fetch(`/api/kits/${kitId}/presence`);
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        const others = (data.editors || []).filter((e: any) => String(e.email || '').toLowerCase() !== currentUserEmail);
        setOtherEditors(others);
        if (data.updatedAt) {
          setRemoteUpdatedAt(prev => {
            if (prev && data.updatedAt !== prev) setKitDirtyRemote(true);
            return data.updatedAt;
          });
        }
      } catch { /* keep last-known state */ }
    };

    // Fire immediately, then every 10s.
    void beat(); void roster();
    const beatT = window.setInterval(beat, 10_000);
    const rosterT = window.setInterval(roster, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(beatT);
      window.clearInterval(rosterT);
      // Best-effort leave — the row also expires on its own after 60s.
      void fetch(`/api/kits/${kitId}/presence`, { method: 'DELETE' }).catch(() => {});
    };
  }, [currentKitId, currentUserEmail]);

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
          // Every in-app Save Kit auto-creates a project + syncs the
          // BOM to it. Kit name → project name; BOM Manager and P&P
          // Kit Booking pick up the rows on their next audit; other
          // users see the new project + kit as soon as they refresh.
          createProjectIfMissing: true,
          syncToProjectBom: true,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || 'Save failed');
      const projMsg = body?.createdProject ? ` · created project "${body.createdProject.name}"` : '';
      triggerToast(`Kit "${name.trim()}" saved${projMsg}.`, 'SUCCESS');
      setCurrentKitName(name.trim());
      if (body?.id) setCurrentKitId(body.id);
      if (body?.createdProject?.id) setSelectedProjectId(body.createdProject.id);
      // Our own save moves updated_at — remember it so the next
      // presence poll doesn't flag us as "someone else saved".
      if (body?.updatedAt) setRemoteUpdatedAt(body.updatedAt);
      setKitDirtyRemote(false);
      setShowSaveKit(false);
      loadSavedKits();
      handleValidate();
      onBomChanged?.();
      // A kit save bumps the project's last_activity_at (server folds
      // MAX(kit.updated_at) into it), so the Project Manager cards
      // deserve a refresh too.
      onProjectsChanged?.();
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
      setRemoteUpdatedAt(kit.updatedAt || null);
      setKitDirtyRemote(false);
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
  const handleImportKitFile = async (file: File): Promise<ParsedImport | null> => {
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
        const kit: ParsedKitImport = {
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
        return { kind: 'json', kit };
      }
      if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
        // CSV imports go through a mapping step so the operator sees
        // the actual headers and picks which one is stock-code /
        // qty / etc. Auto-guessed mapping pre-populates the dropdowns
        // for typical BOM exports; anything unusual gets fixed by
        // hand rather than failing outright.
        const { headers, rows } = parseCsvStructural(text);
        if (headers.length === 0) throw new Error('No header row found.');
        if (rows.length === 0) throw new Error('The file has no data rows.');
        return { kind: 'csv', csv: { suggestedName: name, headers, rows, autoMap: guessColumnMapping(headers) } };
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
    syncToProjectBom: boolean;
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
      const bomMsg = body?.bomSynced ? ` · project BOM updated (${payload.bom.length} lines)` : '';
      triggerToast(`Imported "${payload.name}"${bomMsg}.`, 'SUCCESS');
      loadSavedKits();

      // Auto-download the pre-sync backup so the operator always has a
      // recoverable copy of the project's previous BOM on disk. Named
      // OLD_<slugified project name>_<yyyy-mm-dd>.json per the spec.
      if (body?.bomSynced && body?.backup) {
        try {
          const b = body.backup;
          const slug = String(b.projectName || `project_${b.projectId}`).replace(/[^a-zA-Z0-9_-]/g, '_');
          const stamp = new Date(b.backupCreatedAt || Date.now()).toISOString().slice(0, 10);
          const filename = `OLD_${slug}_${stamp}.json`;
          const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          triggerToast(`Backup saved: ${filename} (${b.rowCount} rows)`, 'INFO');
        } catch (dlErr: any) {
          triggerToast(`BOM synced but backup download failed: ${dlErr.message}`, 'ERROR');
        }
      }

      // Cascade both refreshes when the BOM was synced: BOM Manager
      // (bomItems state in App.tsx) picks up the new rows, and the
      // Project Manager cards + the header chip here pick up the new
      // projects.updated_at.
      if (body?.bomSynced) {
        onBomChanged?.();
        onProjectsChanged?.();
      } else {
        // Even a kit-only save bumps kits.updated_at, which our
        // last_activity_at fold on the server picks up — the projects
        // feed reads GREATEST(project.updated_at, MAX(kit.updated_at))
        // so a fresh kit save changes the "Last edited" answer too.
        onProjectsChanged?.();
      }
      // Fall through to load — sets project, buildQty, dnf, allocations,
      // and re-runs the audit against the freshly-synced BOM.
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

  // Shortage for one audit row at an arbitrary build size. The audit
  // ran once against the current buildQty; we back-out qtyPerPcb from
  // it so the preset columns can preview shortages at 50/100/250/…
  // without re-hitting the backend for each preset.
  const shortageAt = React.useCallback((row: AuditResult, atQty: number): number => {
    if (buildQty <= 0 || atQty <= 0) return 0;
    const qtyPerPcb = row.qty_required / buildQty;
    const needed = Math.round(qtyPerPcb * atQty);
    const short = needed - row.qty_on_hand;
    return short > 0 ? short : 0;
  }, [buildQty]);

  // Batch export: one CSV per selected preset. Files download in
  // sequence with a small delay so the browser doesn't throttle or
  // squash them into a single prompt. Each CSV is shaped like the
  // single-qty export, just recomputed for its own build size.
  const exportPresetCsvs = async (quantities: number[], includeDnf: boolean) => {
    if (quantities.length === 0) return;
    const projectName = projects.find(p => p.id === selectedProjectId)?.projectName?.replace(/[^a-zA-Z0-9_-]/g, '_') || 'project';
    const stamp = new Date().toISOString().slice(0, 10);
    const esc = (v: any) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    let totalRows = 0;
    for (let i = 0; i < quantities.length; i++) {
      const atQty = quantities[i];
      const inScope = auditResults.filter(r => {
        if (dnfOverride.has(r.component_id)) return includeDnf;
        return shortageAt(r, atQty) > 0;
      });
      if (inScope.length === 0) continue;
      const header = ['Part', 'Description', 'Designator', 'Qty per PCB', 'Needed', 'On Hand', 'Shortage', 'Alternates used', 'Reserved elsewhere'];
      const rows = inScope.map(r => {
        const isDnf = dnfOverride.has(r.component_id);
        const reserved = reservations[r.resolved_part_number] || 0;
        const qtyPerPcb = buildQty > 0 ? Math.max(1, Math.round(r.qty_required / buildQty)) : r.qty_required;
        const needed = qtyPerPcb * atQty;
        const shortage = isDnf ? 0 : Math.max(0, needed - r.qty_on_hand);
        return [
          r.component_id,
          r.description,
          r.designator || '',
          qtyPerPcb,
          needed,
          r.qty_on_hand,
          isDnf ? 'DNF' : shortage,
          r.used_alternative ? r.resolved_part_number : '',
          reserved,
        ];
      });
      const csv = [header, ...rows].map(row => row.map(esc).join(',')).join('\n');
      const filename = `${projectName}_${stamp}_QTY-${atQty}_shortages${includeDnf ? '_with_dnf' : ''}.csv`;
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      totalRows += rows.length;
      // Small stagger between downloads — Chrome will silently drop
      // rapid-fire download calls otherwise; 250ms is enough for
      // every browser I tested and short enough that the operator
      // barely notices the sequence.
      if (i < quantities.length - 1) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    if (totalRows === 0) {
      triggerToast('No shortages at any selected preset — nothing exported.', 'INFO');
    } else {
      triggerToast(`Exported ${quantities.length} CSV file(s), ${totalRows} row(s) total.`, 'SUCCESS');
    }
    setShowPresetCsvs(false);
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
  // "do not fit for this kit". Allocation overrides also change the
  // effective shortage: a multi-SKU pick that covers the requirement
  // reads as satisfied even when the primary SKU alone was short.
  const totalShortages = auditResults.filter(r => {
    if (dnfOverride.has(r.component_id)) return false;
    const override = allocations[r.component_id] || [];
    if (override.length > 0) {
      const picked = override.reduce((s, a) => s + (a.qty || 0), 0);
      return picked < r.qty_required;
    }
    return r.shortage_qty > 0;
  }).length;

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
          {(() => {
            // Last-edited chip for the active project. Source is
            // GREATEST(projects.updated_at, MAX(kits.updated_at for
            // this project)), so a fresh kit save shows as recent
            // even if the projects row itself was not touched. Admin
            // BOM edits also bump the project row on save.
            const proj = projects.find(p => p.id === selectedProjectId);
            const last = proj?.lastActivityAt || proj?.updatedAt;
            if (!last) return null;
            return (
              <div
                className="inline-flex items-center gap-1.5 mt-1.5 px-2 py-0.5 rounded bg-surface-container-high border border-outline-variant text-[10px] font-mono uppercase tracking-wider text-outline"
                title={new Date(last).toLocaleString()}
              >
                <History className="w-3 h-3" />
                Last edited: {formatRelativeTime(last)}
              </div>
            );
          })()}
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
          {/* Presence banner — one blinking chip per other editor on
              this kit. Roster refreshes on a 10-second poll; each
              entry disappears when the server's TTL (60s) drops it. */}
          {currentKitId && otherEditors.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {otherEditors.map(e => (
                <div
                  key={e.email}
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-[10px] font-mono uppercase tracking-wider text-amber-400 animate-pulse"
                  title={`${e.name} (${e.email}) is editing this kit`}
                >
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                  {e.name} is editing
                </div>
              ))}
            </div>
          )}
          {/* Remote-save notification — the server's updated_at moved
              since we loaded / last saved. Someone else landed a
              save; refresh to pick it up. */}
          {currentKitId && kitDirtyRemote && (
            <div className="inline-flex items-center gap-2 mt-1.5 px-3 py-1.5 rounded bg-blue-500/15 border border-blue-500/40 text-[10px] font-mono uppercase tracking-wider text-blue-300">
              <History className="w-3 h-3" />
              Kit saved by another user — refresh to load the latest
              <button
                type="button"
                onClick={() => currentKitId && handleLoadKit(currentKitId)}
                className="ml-1 px-2 py-0.5 rounded bg-blue-500/20 hover:bg-blue-500/30 text-blue-100 font-bold"
              >
                Refresh
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
          <table className="stacked-mobile w-full text-left border-collapse min-w-[1400px]">
            <thead>
              {/* Grouped header: five preset-qty columns sit under a
                  common "Shortages at" header with a button that opens
                  the batch CSV export for those quantities. Row-level
                  cells below carry the actual shortage values. */}
              <tr className="bg-surface-container-high text-[10px] uppercase font-mono text-outline border-b border-outline-variant">
                <th className="px-lg py-2" rowSpan={2}>Component ID</th>
                <th className="px-lg py-2" rowSpan={2}>Description / Comment</th>
                <th className="px-lg py-2 text-right" rowSpan={2}>Required</th>
                <th className="px-lg py-2 text-right" rowSpan={2}>On Hand</th>
                <th className="px-lg py-2 text-center" rowSpan={2}>Status</th>
                <th className="px-lg py-2 text-center" rowSpan={2}>Alternatives</th>
                <th
                  colSpan={PRESET_QTYS.length}
                  className="px-lg py-2 text-center border-l border-r border-outline-variant/40 bg-primary/5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] text-primary font-black tracking-wider">Shortages at build qty</span>
                    <button
                      type="button"
                      onClick={() => setShowPresetCsvs(true)}
                      disabled={auditResults.length === 0}
                      className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded bg-primary/15 border border-primary/40 text-primary hover:bg-primary/25 disabled:opacity-40 disabled:cursor-not-allowed normal-case"
                      title="Download a shortages CSV for each preset build quantity"
                    >
                      <Download className="w-3 h-3" />
                      Save preset CSVs
                    </button>
                  </div>
                </th>
                <th className="px-lg py-2" rowSpan={2}>Sourcing</th>
              </tr>
              <tr className="bg-surface-container-high text-[10px] uppercase font-mono text-outline border-b border-outline-variant">
                {PRESET_QTYS.map((q, i) => (
                  <th
                    key={q}
                    className={`px-2 py-1 text-right font-mono ${i === 0 ? 'border-l border-outline-variant/40' : ''} ${i === PRESET_QTYS.length - 1 ? 'border-r border-outline-variant/40' : ''}`}
                  >
                    {q}
                  </th>
                ))}
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
                    <div className="font-mono font-bold text-primary flex items-center gap-2">
                      {res.component_id}
                      {res.color && (
                        // Plain colour dot — the swatch itself is the
                        // label. Hover reveals the free-text colour
                        // string for anyone who needs the exact hue.
                        <span
                          className="inline-block w-3.5 h-3.5 rounded-full border border-white/25 shadow-sm shrink-0"
                          style={{ background: colorToCssBackground(res.color) }}
                          title={`Colour: ${res.color}`}
                          aria-label={`Colour: ${res.color}`}
                        />
                      )}
                    </div>
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
                    {(() => {
                      // When the operator has explicitly allocated one
                      // or more SKUs to this line, the "on hand" number
                      // that matters is the sum of what's been picked
                      // across those SKUs — the audit's single-SKU
                      // qty_on_hand no longer represents the plan. Show
                      // the pick total, and expose the raw audit number
                      // as a hint below.
                      const override = allocations[res.component_id] || [];
                      const pickedTotal = override.reduce((s, a) => s + (a.qty || 0), 0);
                      const showAggregate = override.length > 0 && pickedTotal > 0;
                      const displayHand = showAggregate ? pickedTotal : res.qty_on_hand;
                      const isShort = displayHand < res.qty_required;
                      return (
                        <>
                          <span className={isShort ? 'text-red-400 font-bold' : 'text-on-surface'}>
                            {displayHand}
                          </span>
                          {showAggregate && (
                            <div className="text-[9px] text-primary font-mono mt-0.5" title="Sum of qty allocated across the picked SKUs">
                              from {override.length} SKU{override.length === 1 ? '' : 's'}
                            </div>
                          )}
                          {(() => {
                            const reserved = reservations[res.resolved_part_number] || 0;
                            return reserved > 0 ? (
                              <div className="text-[9px] text-outline font-mono mt-0.5" title="Reserved by another locked kit — subtract from available">
                                −{reserved} reserved
                              </div>
                            ) : null;
                          })()}
                        </>
                      );
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
                      // Multi-SKU allocation overrides the server's
                      // single-SKU shortage: if the operator's picks
                      // cover the requirement, the line is Ready even
                      // if the primary SKU alone was short.
                      const override = allocations[res.component_id] || [];
                      const pickedTotal = override.reduce((s, a) => s + (a.qty || 0), 0);
                      const effectiveShortage = override.length > 0
                        ? Math.max(0, res.qty_required - pickedTotal)
                        : res.shortage_qty;
                      return effectiveShortage > 0 ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-red-500/10 text-red-400 border border-red-500/15 font-mono uppercase">
                          <AlertTriangle className="w-3 h-3" />
                          Short: {effectiveShortage}
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
                  {/* Preset-qty shortage grid — one small cell per
                      preset, showing how many more units would be
                      short at that build size. DNF rows and rows with
                      no shortage show a subtle placeholder so the eye
                      lands on the red numbers. */}
                  {PRESET_QTYS.map((atQty, i) => {
                    const isDnf = dnfOverride.has(res.component_id);
                    const short = isDnf ? 0 : shortageAt(res, atQty);
                    return (
                      <td
                        key={atQty}
                        data-label={`@${atQty}`}
                        className={`px-2 py-3 text-right font-mono text-[11px] ${i === 0 ? 'border-l border-outline-variant/40' : ''} ${i === PRESET_QTYS.length - 1 ? 'border-r border-outline-variant/40' : ''}`}
                        title={isDnf ? 'DNF for this kit' : short > 0 ? `Short ${short.toLocaleString()} at build qty ${atQty}` : `Fully covered at build qty ${atQty}`}
                      >
                        {isDnf ? (
                          <span className="text-outline/50">DNF</span>
                        ) : short > 0 ? (
                          <span className="text-red-400 font-bold">{short.toLocaleString()}</span>
                        ) : (
                          <span className="text-outline/40">·</span>
                        )}
                      </td>
                    );
                  })}
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
                        // Fallback to the manufacturer part number: an
                        // MPN → a clickable Google search of that MPN
                        // is more useful than a dead "No links" cell.
                        // If neither is available, fall through to the
                        // italic placeholder.
                        const mfn = (res.manufacturer_part_number || '').trim();
                        if (mfn) {
                          const searchHref = `https://www.google.com/search?q=${encodeURIComponent(mfn + ' datasheet')}`;
                          return (
                            <a
                              href={searchHref}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`No supplier links stored — search "${mfn}"`}
                              className="inline-flex items-center gap-1 p-1 rounded bg-surface-container-highest border border-outline-variant hover:border-primary transition-colors text-outline hover:text-primary"
                            >
                              <ExternalLink className="w-3 h-3" />
                              <span className="text-[10px] font-mono max-w-[100px] truncate">{mfn}</span>
                            </a>
                          );
                        }
                        return <span className="text-[10px] text-outline italic">No links</span>;
                      }
                      // Anchor with target=_blank + rel="noopener
                      // noreferrer" is what the browser interprets
                      // natively. window.open with noopener returns
                      // null even on success, so the earlier
                      // "if (!w) same-tab fallback" landed on top of a
                      // successfully-opened new tab and the row
                      // ended up in both places at once.
                      return (
                        <div className="flex flex-wrap gap-1.5">
                          {parsed.map((u, idx) => {
                            const host = u.hostname.replace(/^www\./, '');
                            return (
                              <a
                                key={idx}
                                href={u.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={u.href}
                                className="inline-flex items-center gap-1 p-1 rounded bg-surface-container-highest border border-outline-variant hover:border-primary transition-colors text-outline hover:text-primary"
                              >
                                <ExternalLink className="w-3 h-3" />
                                <span className="text-[10px] font-mono max-w-[80px] truncate">{host}</span>
                              </a>
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
                  <td colSpan={7 + PRESET_QTYS.length} className="px-lg py-12 text-center text-outline italic font-mono">
                    No BOM data found for the selected project.
                  </td>
                </tr>
              )}
              {auditResults.length > 0 && filteredResults.length === 0 && !loading && (
                <tr>
                  <td colSpan={7 + PRESET_QTYS.length} className="px-lg py-12 text-center text-outline italic font-mono">
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
            // shows up everywhere without a page reload. Admin BOM save
            // also bumps projects.updated_at server-side, so the
            // "Last edited" chip in Project Manager needs a refresh too.
            onBomChanged?.();
            onProjectsChanged?.();
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

      {showPresetCsvs && (
        <PresetCsvDialog
          presets={PRESET_QTYS as unknown as number[]}
          shortagesAtPreset={Object.fromEntries(
            (PRESET_QTYS as unknown as number[]).map(q => [
              q,
              auditResults.filter(r => !dnfOverride.has(r.component_id) && shortageAt(r, q) > 0).length,
            ])
          )}
          dnfCount={auditResults.filter(r => dnfOverride.has(r.component_id)).length}
          onCancel={() => setShowPresetCsvs(false)}
          onExport={exportPresetCsvs}
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
  onParseFile: (file: File) => Promise<ParsedImport | null>;
  onCommitImport: (payload: {
    name: string; projectId: number; buildQty: number; notes: string;
    bom: ParsedKitImport['bom']; allocations: ParsedKitImport['allocations']; dnf: string[];
    syncToProjectBom: boolean;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [dragOver, setDragOver] = useState(false);
  // Three panels share the dialog body:
  //   null         → plain saved-kit browser
  //   csvMap step  → column-mapping UI for a CSV that just landed
  //   kit review   → final confirm step (project / name / buildQty)
  const [csvStep, setCsvStep] = useState<ParsedCsvFile | null>(null);
  const [mapping, setMapping] = useState<CsvColumnMapping>({ part: null, qty: null, designator: null, description: null, footprint: null });
  const [pending, setPending] = useState<ParsedKitImport | null>(null);
  const [pendingName, setPendingName] = useState('');
  const [pendingProjectId, setPendingProjectId] = useState<number>(defaultProjectId);
  const [pendingBuildQty, setPendingBuildQty] = useState<number>(1);
  // Default the "sync to project BOM" flag ON for imports — that's the
  // whole point of dropping a file. Operators who explicitly want to
  // save the kit without touching the project BOM can uncheck it.
  const [pendingSyncBom, setPendingSyncBom] = useState<boolean>(true);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const filtered = kits.filter(k => !q.trim() || `${k.name} ${k.projectName || ''}`.toLowerCase().includes(q.toLowerCase()));

  const mappedPreview = React.useMemo(() => csvStep ? applyCsvMapping(csvStep.rows, mapping) : [], [csvStep, mapping]);
  const mappingIsValid = mapping.part != null && mapping.qty != null && mappedPreview.length > 0;

  const acceptFile = async (file: File | null | undefined) => {
    if (!file) return;
    const parsed = await onParseFile(file);
    if (!parsed) return;
    if (parsed.kind === 'json') {
      setPending(parsed.kit);
      setPendingName(parsed.kit.suggestedName);
      setPendingProjectId(parsed.kit.projectId ?? defaultProjectId);
      setPendingBuildQty(parsed.kit.buildQty || 1);
    } else {
      setCsvStep(parsed.csv);
      setMapping(parsed.csv.autoMap);
    }
  };

  // Called from the mapping step's Continue button — turns the mapping
  // into a full ParsedKitImport and moves the dialog to the standard
  // review panel.
  const continueFromCsv = () => {
    if (!csvStep) return;
    const bom = applyCsvMapping(csvStep.rows, mapping);
    if (bom.length === 0) return;
    setPending({
      suggestedName: csvStep.suggestedName,
      projectId: null,
      buildQty: 1,
      notes: '',
      bom,
      allocations: [],
      dnf: [],
    });
    setPendingName(csvStep.suggestedName);
    setPendingProjectId(defaultProjectId);
    setPendingBuildQty(1);
    setCsvStep(null);
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
      syncToProjectBom: pendingSyncBom,
    });
  };

  return (
    <div className="fixed inset-0 z-[200] bg-background/85 backdrop-blur-sm flex items-center justify-center p-md" onClick={onClose}>
      <div className="bg-surface-container border border-outline-variant rounded-xl shadow-2xl max-w-[720px] w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-lg py-md border-b border-outline-variant flex items-center gap-sm">
          <FolderOpen className="w-4 h-4 text-primary" />
          <div className="flex-1">
            <h4 className="font-bold text-sm text-on-surface">
              {csvStep ? 'CSV — map columns' : pending ? 'Import kit — review' : 'Load Kit'}
            </h4>
            <p className="text-[10px] text-outline mt-0.5">
              {csvStep
                ? `The CSV has ${csvStep.headers.length} column${csvStep.headers.length === 1 ? '' : 's'} and ${csvStep.rows.length} data row${csvStep.rows.length === 1 ? '' : 's'}. Match each field below to one of the columns; auto-guessed pairings are pre-filled.`
                : pending
                  ? `Parsed ${pending.bom.length} BOM line${pending.bom.length === 1 ? '' : 's'} from disk. Confirm the details below — save posts to the same /api/kits endpoint as an in-app Save Kit, then loads it into the audit.`
                  : 'Pick a saved kit to load, or drop a .json / .csv file to import a new one.'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-surface-variant/40 text-outline hover:text-on-surface">
            <X className="w-4 h-4" />
          </button>
        </div>

        {csvStep && (
          <>
            <div className="flex-1 overflow-y-auto px-lg py-md space-y-md">
              {/* Column mapping — each required/optional field gets a
                  select of the CSV's real headers. "Not mapped" clears
                  the pairing; part + qty must both be set to Continue. */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-sm">
                {(['part', 'qty', 'designator', 'description', 'footprint'] as const).map(field => {
                  const required = field === 'part' || field === 'qty';
                  const label = ({ part: 'Stock code', qty: 'Qty per PCB', designator: 'Designator', description: 'Description', footprint: 'Footprint' } as Record<typeof field, string>)[field];
                  return (
                    <div key={field}>
                      <label className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-1">
                        {label}{required && <span className="text-error"> *</span>}
                      </label>
                      <select
                        value={mapping[field] ?? ''}
                        onChange={(e) => setMapping(prev => ({ ...prev, [field]: e.target.value === '' ? null : Number(e.target.value) }))}
                        className={`w-full px-3 py-2 rounded border text-xs font-mono focus:outline-none focus:border-primary ${
                          mapping[field] != null
                            ? 'border-primary bg-primary/5 text-on-surface'
                            : required
                              ? 'border-error/40 bg-error/5 text-on-surface'
                              : 'border-outline-variant bg-surface-container-low text-on-surface'
                        }`}
                      >
                        <option value="">— Not mapped —</option>
                        {csvStep.headers.map((h, i) => (
                          <option key={i} value={i}>{h || `(column ${i + 1})`}</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>

              <div>
                <div className="flex items-center justify-between text-[10px] font-bold text-outline uppercase tracking-wider mb-1">
                  <span>
                    Live preview — {mappedPreview.length} valid row{mappedPreview.length === 1 ? '' : 's'} out of {csvStep.rows.length}
                  </span>
                  {!mappingIsValid && (
                    <span className="text-error normal-case font-normal tracking-normal italic">
                      Pick a Stock Code and Qty column to continue
                    </span>
                  )}
                </div>
                <div className="rounded-lg border border-outline-variant/40 bg-surface-container-low overflow-auto max-h-[280px]">
                  <table className="w-full text-left text-[11px]">
                    <thead className="bg-surface-container-high/60 text-[9px] uppercase font-mono text-outline sticky top-0">
                      <tr>
                        {csvStep.headers.map((h, i) => {
                          const mappedTo = (Object.entries(mapping) as [keyof CsvColumnMapping, number | null][]).find(([, idx]) => idx === i)?.[0];
                          return (
                            <th key={i} className={`px-2 py-1 whitespace-nowrap ${mappedTo ? 'bg-primary/10 text-primary' : ''}`}>
                              <div>{h || `(col ${i + 1})`}</div>
                              {mappedTo && <div className="text-[8px] normal-case font-bold">→ {mappedTo}</div>}
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/20">
                      {csvStep.rows.slice(0, 6).map((r, ri) => (
                        <tr key={ri}>
                          {csvStep.headers.map((_, ci) => (
                            <td key={ci} className={`px-2 py-1 font-mono truncate max-w-[180px] ${
                              (Object.values(mapping) as (number | null)[]).includes(ci) ? 'text-on-surface' : 'text-outline'
                            }`}>
                              {r[ci] || <span className="italic text-outline/50">—</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {csvStep.rows.length > 6 && (
                        <tr>
                          <td colSpan={csvStep.headers.length} className="px-2 py-1 text-center text-outline italic text-[10px]">
                            …and {csvStep.rows.length - 6} more
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
                onClick={() => setCsvStep(null)}
                className="px-md py-1.5 rounded-lg text-xs font-bold border border-outline-variant text-on-surface hover:bg-surface-variant/40"
              >
                Back
              </button>
              <button
                type="button"
                onClick={continueFromCsv}
                disabled={!mappingIsValid}
                className="px-md py-1.5 rounded-lg text-xs font-bold bg-primary text-on-primary hover:brightness-110 active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
              >
                Continue → Review
              </button>
            </div>
          </>
        )}

        {!pending && !csvStep && (
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

              {/* Sync-to-project-BOM: the whole point of dropping a
                  file for most operators, so on by default. The label
                  spells out exactly what it does — the project's
                  current BOM rows get REPLACED across every eligible
                  table with the kit's rows, and the "Last edited" chip
                  in Project Manager updates on the next fetch. */}
              <label className={`flex items-start gap-2 rounded-lg border p-md cursor-pointer transition-colors ${
                pendingSyncBom ? 'border-primary/50 bg-primary/5' : 'border-outline-variant bg-surface-container-low'
              }`}>
                <input
                  type="checkbox"
                  checked={pendingSyncBom}
                  onChange={(e) => setPendingSyncBom(e.target.checked)}
                  className="mt-0.5 w-3.5 h-3.5 accent-primary"
                />
                <div className="flex-1">
                  <div className="text-xs font-bold text-on-surface">Also update the project's BOM to match</div>
                  <div className="text-[10px] text-outline mt-0.5">
                    Replaces every row for this project across the audit tables with the kit's BOM lines. Before the replace, the project's current BOM is downloaded to your PC as <span className="font-mono">OLD_{'{'}project_name{'}'}_{'{'}date{'}'}.json</span> — keep it in case you need to restore. BOM Manager and P&P Kit Booking pick up the new lines on their next load; the project's "Last edited" timestamp updates.
                  </div>
                </div>
              </label>
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
                {busy ? 'Importing…' : (pendingSyncBom ? 'Save · Sync · Load' : 'Save & Load')}
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

  // Per-row Fill / Unfill toggle.
  // - When the row has zero picked, top it up to
  //   min(available, remaining shortfall). Leaves other picks alone.
  // - When the row already carries a pick, click again to deselect it
  //   (setQty(0)) — replaces the earlier "must Clear all" flow.
  const availableFor = (c: MatchCandidate) => Math.max(0, c.stock - (reservations[c.serialNumber] || 0));
  const fillRowToShortfall = (c: MatchCandidate) => {
    const current = picks[c.serialNumber] || 0;
    if (current > 0) {
      setQty(c.serialNumber, 0);
      return;
    }
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

// -----------------------------------------------------------------------
// Batch preset-quantity CSV export dialog. Lets the operator tick which
// preset build sizes to export, plus the include-DNF flag, and then
// downloads one CSV per selected preset (sequentially, with a small
// stagger, so browsers don't collapse the downloads). Shortage counts
// per preset are shown next to each checkbox so it's clear before
// downloading whether that build size even has anything to procure.
// -----------------------------------------------------------------------
function PresetCsvDialog({ presets, shortagesAtPreset, dnfCount, onCancel, onExport }: {
  presets: number[];
  shortagesAtPreset: Record<number, number>;
  dnfCount: number;
  onCancel: () => void;
  onExport: (quantities: number[], includeDnf: boolean) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set(presets));
  const [includeDnf, setIncludeDnf] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const toggle = (q: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(q)) next.delete(q); else next.add(q);
      return next;
    });
  };
  const orderedSelected = presets.filter(p => selected.has(p));
  return (
    <div className="fixed inset-0 z-[200] bg-background/85 backdrop-blur-sm flex items-center justify-center p-md" onClick={busy ? undefined : onCancel}>
      <div className="bg-surface-container border border-outline-variant rounded-xl shadow-2xl max-w-[520px] w-full" onClick={(e) => e.stopPropagation()}>
        <div className="px-lg py-md border-b border-outline-variant flex items-center gap-sm">
          <Download className="w-4 h-4 text-primary" />
          <div>
            <h4 className="font-bold text-sm text-on-surface">Save preset CSVs</h4>
            <p className="text-[10px] text-outline mt-0.5">
              Downloads one shortages CSV per selected build quantity. Files land one after another (short stagger) so your browser keeps all of them.
            </p>
          </div>
        </div>
        <div className="px-lg py-md space-y-md">
          <div className="space-y-1.5">
            {presets.map(q => {
              const short = shortagesAtPreset[q] || 0;
              return (
                <label key={q} className="flex items-center justify-between gap-2 rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 cursor-pointer hover:border-primary/60">
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected.has(q)}
                      onChange={() => toggle(q)}
                      className="w-3.5 h-3.5 accent-primary"
                    />
                    <span className="text-xs font-mono font-bold text-on-surface">Build qty {q}</span>
                  </span>
                  <span className={`text-[10px] font-mono ${short > 0 ? 'text-red-400' : 'text-outline'}`}>
                    {short > 0 ? `${short} shortage row${short === 1 ? '' : 's'}` : 'no shortages'}
                  </span>
                </label>
              );
            })}
          </div>
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
                DNF-marked rows appear in every generated file with "DNF" in the Shortage column. Off by default because procurement skips them.
              </div>
            </div>
          </label>
          <div className="text-[10px] text-outline font-mono">
            Will download {orderedSelected.length} file{orderedSelected.length === 1 ? '' : 's'}.
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
            onClick={async () => { setBusy(true); await onExport(orderedSelected, includeDnf); setBusy(false); }}
            disabled={busy || orderedSelected.length === 0}
            className="px-md py-1.5 rounded-lg text-xs font-bold bg-primary text-on-primary hover:brightness-110 active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            {busy ? 'Downloading…' : `Download ${orderedSelected.length} file${orderedSelected.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
