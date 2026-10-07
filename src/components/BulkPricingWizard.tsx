// Bulk pricing: start a run, follow it, and see when each item was last bulk
// priced.
//
// Everything happens on the server (src/lib/bulkPricing.ts, routes in
// src/lib/bulkPricingRoutes.ts): a run carries on if this page is closed, and
// the daily automatic run needs no page at all. This page starts runs, polls
// the one in progress, and shows the log. It writes nothing itself.
//
// A run writes only an item's bulk price (bulk_price_zar / bulk_price_usd).
// The old version of this page sent whole items back from a copy taken when
// the page loaded, which could undo stock movements and overwrite the cost.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Clock, Eye, History, Loader2, Play, RefreshCw, Search, Settings2, Square, X } from 'lucide-react';
import { confirmDialog } from '../lib/confirmDialog';
import { fmtCurrency, fmtNumber } from '../lib/formatMoney';
import { DangerButton, FieldLabel, PrimaryButton, SecondaryButton, inputClass, isAdminUser, selectClass } from './bookkeeping/shared';
import { currentUserCan, notAllowedMessage } from '../lib/permissions';
import { useDataChanged } from '../lib/liveUpdates';
import BulkPricingReview from './BulkPricingReview';

type Scope = 'due' | 'missing' | 'all' | 'selected';
type ItemStatus = 'updated' | 'unchanged' | 'flagged' | 'no_price' | 'skipped' | 'failed'
  // decisions taken in the problem review
  | 'approved' | 'manual' | 'rejected' | 'excluded' | 'included';
type ToastType = 'SUCCESS' | 'ERROR' | 'INFO';

export interface BulkPricingSettings {
  autoEnabled: boolean;
  autoThresholdDays: number;
  historyRetentionDays: number;
  autoBatchSize: number;
  retryFailedAfterDays: number;
  qty: number;
  suspiciousAboveUsd: number;
}

interface Run {
  id: number;
  trigger: 'manual' | 'auto';
  scope: Scope;
  dryRun: boolean;
  qty: number;
  status: string;
  stopRequested: boolean;
  stale: boolean;
  requestedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  checked: number;
  updated: number;
  unchanged: number;
  flagged: number;
  noPrice: number;
  skipped: number;
  failed: number;
  error: string | null;
  note: string | null;
}

interface RunItem {
  id: number;
  runId: number | null;
  serialNumber: string;
  name?: string | null;
  partNumber: string | null;
  source: string;
  dryRun: boolean;
  status: ItemStatus;
  oldPriceZar: number | null;
  newPriceZar: number | null;
  oldPriceUsd: number | null;
  newPriceUsd: number | null;
  provider: string | null;
  matchedPart: string | null;
  nativePrice: number | null;
  nativeCurrency: string | null;
  reason: string | null;
  /** Who decided it, for review decisions. */
  decidedBy?: string | null;
  at: string | null;
}

interface Reason { status: ItemStatus; reason: string; count: number }
interface RunDetail { run: Run; reasons: Reason[]; items: RunItem[] }

interface StatusItem {
  serialNumber: string;
  name: string | null;
  partNumber: string | null;
  /** The item's LCSC number, which LCSC is asked by. */
  lcscCode?: string | null;
  bulkPriceZar: number | null;
  bulkPriceUsd: number | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastRunId: number | null;
  lastSource: string | null;
  lastStatus: ItemStatus | null;
  lastOldPriceZar: number | null;
  lastNewPriceZar: number | null;
  lastError: string | null;
  /** Left out of bulk pricing on purpose. */
  excluded?: boolean;
  excludedBy?: string | null;
  due: boolean;
  nextDueAt: string | null;
}

interface StatusCounts { all: number; due: number; problems: number; never: number; missing: number; noPartNumber: number; excluded?: number }

interface StatusResponse {
  items: StatusItem[];
  total: number;
  limit: number;
  offset: number;
  counts: StatusCounts;
  settings: BulkPricingSettings;
  warnings: string[];
  nextAutoRunAt: string | null;
  running: Run | null;
  lastAutoRun: Run | null;
}

interface BulkPricingWizardProps {
  onShowNotification: (msg: string, type?: ToastType) => void;
  /** Called when a run has changed prices, so the app reloads its inventory. */
  onPricesUpdated?: () => void;
  /** How often the run in progress is checked, in ms. */
  pollIntervalMs?: number;
  /** Opens the part-number review. */
  onReviewPartNumbers?: () => void;
  /** Opens an item's detail (from the problem review). */
  onOpenItem?: (serialNumber: string) => void;
}

const PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const SCOPES: Array<{ value: Scope; label: string; empty: string }> = [
  { value: 'due', label: 'Items due for re-pricing', empty: 'Nothing is due for re-pricing.' },
  { value: 'missing', label: 'Items with no bulk price', empty: 'Every item with a part number has a bulk price.' },
  { value: 'all', label: 'Every item with a part number', empty: 'No item has a part number to look up.' },
  { value: 'selected', label: 'Ticked items', empty: 'Tick the items to price in the list below first.' },
];
const SCOPE_SHORT: Record<Scope, string> = { due: 'Due items', missing: 'Items with no bulk price', all: 'All items', selected: 'Ticked items' };

const FILTERS: Array<{ value: string; label: string; count: (c: StatusCounts) => number }> = [
  { value: 'all', label: 'All', count: (c) => c.all },
  { value: 'due', label: 'Due', count: (c) => c.due },
  { value: 'problems', label: 'Problems', count: (c) => c.problems },
  { value: 'never', label: 'Never priced', count: (c) => c.never },
  { value: 'missing', label: 'No bulk price', count: (c) => c.missing },
  { value: 'no_part_number', label: 'No part number', count: (c) => c.noPartNumber },
  { value: 'excluded', label: 'Left out', count: (c) => c.excluded ?? 0 },
];

const SORTS = [
  { value: 'oldest', label: 'Oldest update first' },
  { value: 'failed', label: 'Problems first' },
  { value: 'recent', label: 'Most recently updated' },
  { value: 'code', label: 'Stock code' },
];

const GREEN = 'bg-green-500/10 text-green-400 border-green-500/20';
const AMBER = 'bg-amber-500/10 text-amber-500 border-amber-500/25';
const RED = 'bg-error/10 text-error border-error/20';
const NEUTRAL = 'bg-surface-container-highest text-on-surface-variant border-outline-variant';

const ITEM_STATUS: Record<ItemStatus, { label: string; className: string }> = {
  updated: { label: 'Updated', className: GREEN },
  unchanged: { label: 'Unchanged', className: NEUTRAL },
  flagged: { label: 'Held back', className: AMBER },
  no_price: { label: 'No price', className: AMBER },
  skipped: { label: 'Skipped', className: NEUTRAL },
  failed: { label: 'Failed', className: RED },
  approved: { label: 'Approved', className: GREEN },
  manual: { label: 'Set by hand', className: GREEN },
  rejected: { label: 'Kept current price', className: NEUTRAL },
  excluded: { label: 'Left out', className: NEUTRAL },
  included: { label: 'Put back', className: NEUTRAL },
};

const RUN_STATUS: Record<string, { label: string; className: string }> = {
  running: { label: 'Running', className: 'bg-primary/10 text-primary border-primary/25' },
  completed: { label: 'Completed', className: GREEN },
  completed_with_errors: { label: 'Completed with errors', className: AMBER },
  failed: { label: 'Failed', className: RED },
  stopped: { label: 'Stopped', className: NEUTRAL },
  interrupted: { label: 'Interrupted', className: AMBER },
};

type NumericSetting = Exclude<keyof BulkPricingSettings, 'autoEnabled'>;
const SETTING_FIELDS: Array<{ key: NumericSetting; label: string; hint: string; step?: string }> = [
  { key: 'autoThresholdDays', label: 'Re-price after (days)', hint: 'An item is due once its last successful bulk price is this old.' },
  { key: 'autoBatchSize', label: 'Items per automatic run', hint: 'Keeps the daily run inside the supplier API limits.' },
  { key: 'retryFailedAfterDays', label: 'Retry unpriced items after (days)', hint: 'An item that got no price waits this long before it is tried again.' },
  { key: 'historyRetentionDays', label: 'Keep history for (days)', hint: 'At least 30. Keep it longer than the re-price interval, so the previous change is still on record when an item is re-priced.' },
  { key: 'qty', label: 'Quote quantity', hint: 'The bulk quantity prices are quoted at.' },
  { key: 'suspiciousAboveUsd', label: 'Hold back above (USD)', hint: 'A unit price above this is held for review instead of saved: it is almost always a wrong match.', step: '0.01' },
];

// --- formatting -------------------------------------------------------------

const priceDp = (n: number) => (Math.abs(n) < 10 ? 4 : 2);
const fmtZar = (n: number | null) => (n === null ? '—' : fmtCurrency(n, 'ZAR', priceDp(n)));
const fmtUsdPrice = (n: number | null) => (n === null ? '—' : fmtCurrency(n, 'USD', priceDp(n)));
// fmtCurrency shows an unknown currency as rand, so those get their code instead.
const fmtNative = (n: number, currency: string) => (['ZAR', 'USD', 'EUR', 'GBP'].includes(currency)
  ? fmtCurrency(n, currency, priceDp(n))
  : `${fmtNumber(n, priceDp(n))} ${currency}`);
const fmtWhen = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—');
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtNextRun = (iso: string) => new Date(iso).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const plural = (n: number, word: string, many = `${word}s`) => `${fmtNumber(n)} ${n === 1 ? word : many}`;

function ago(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / DAY_MS);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

function dueText(item: StatusItem): string {
  if (item.excluded) return 'Left out of bulk pricing';
  if (!item.partNumber) return 'No part number';
  if (item.due || !item.nextDueAt) return 'Due now';
  const days = Math.ceil((Date.parse(item.nextDueAt) - Date.now()) / DAY_MS);
  return days <= 0 ? 'Due now' : days === 1 ? 'Due tomorrow' : `Due in ${days} days`;
}

function duration(run: Run): string | null {
  if (!run.startedAt || !run.finishedAt) return null;
  const s = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const Pill: React.FC<{ className: string; children: React.ReactNode; title?: string }> = ({ className, children, title }) => (
  <span title={title} className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap ${className}`}>{children}</span>
);

const RunPill: React.FC<{ status: string }> = ({ status }) => {
  const s = RUN_STATUS[status] ?? { label: status, className: NEUTRAL };
  return <Pill className={s.className}>{status === 'running' && <Loader2 className="w-2.5 h-2.5 animate-spin inline-block mr-1 -mt-px" />}{s.label}</Pill>;
};

const ItemPill: React.FC<{ status: ItemStatus | null; title?: string | null }> = ({ status, title }) => {
  if (!status) return <span className="text-outline text-[11px]">—</span>;
  const s = ITEM_STATUS[status] ?? { label: status, className: NEUTRAL };
  return <Pill className={s.className} title={title ?? undefined}>{s.label}</Pill>;
};

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
const sendJson = <T,>(method: 'POST' | 'PUT', url: string, body: unknown) =>
  api<T>(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function toDraft(s: BulkPricingSettings) {
  return { autoEnabled: s.autoEnabled, values: Object.fromEntries(SETTING_FIELDS.map((f) => [f.key, String(s[f.key])])) as Record<NumericSetting, string> };
}

// ---------------------------------------------------------------------------

export default function BulkPricingWizard({ onShowNotification, onPricesUpdated, pollIntervalMs = 2000, onReviewPartNumbers, onOpenItem }: BulkPricingWizardProps) {
  const isAdmin = isAdminUser();
  // Starting and stopping runs changes prices; the server checks this too.
  const canRun = currentUserCan('inventory.update');

  // The log
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('oldest');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<{ serial: string; retentionDays: number; rows: RunItem[] } | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // Runs
  const [scope, setScope] = useState<Scope>('due');
  const [starting, setStarting] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState<number | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [showItems, setShowItems] = useState(false);
  const [itemFilter, setItemFilter] = useState<'all' | 'changed' | 'problems'>('all');
  const [pollNonce, setPollNonce] = useState(0);
  // The run whose end this page reports (one it started, or found running).
  const watched = useRef<number | null>(null);
  // Bumped to make the problem review reload.
  const [reviewKey, setReviewKey] = useState(0);

  // Settings
  const [showSettings, setShowSettings] = useState(false);
  const [draft, setDraft] = useState<ReturnType<typeof toDraft> | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  const statusSeq = useRef(0);
  const loadStatus = useCallback(async () => {
    const seq = ++statusSeq.current;
    setLoading(true);
    const params = new URLSearchParams({ filter, sort, limit: String(PAGE_SIZE), offset: String(offset) });
    if (search) params.set('search', search);
    try {
      const { ok, data } = await api<StatusResponse>(`/api/pricing/bulk-status?${params}`);
      if (seq !== statusSeq.current) return; // a newer request is on its way
      if (!ok) { setStatusError(data.error || 'Could not load the bulk pricing log.'); return; }
      setStatus(data);
      setStatusError(null);
    } catch (err: any) {
      if (seq === statusSeq.current) setStatusError(`Could not load the bulk pricing log: ${err?.message || err}`);
    } finally {
      if (seq === statusSeq.current) setLoading(false);
    }
  }, [filter, sort, search, offset]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  // Search as the user types, once they pause.
  useEffect(() => {
    const next = searchInput.trim();
    if (next === search) return;
    const t = window.setTimeout(() => { setSearch(next); setOffset(0); }, 300);
    return () => window.clearTimeout(t);
  }, [searchInput, search]);

  const loadRuns = useCallback(async () => {
    try {
      const { ok, data } = await api<{ runs: Run[] }>('/api/pricing/bulk-runs?limit=10');
      if (ok) setRuns(data.runs ?? []);
    } catch { /* the list is a convenience; the log still works */ }
  }, []);
  useEffect(() => { void loadRuns(); }, [loadRuns]);

  const followRun = useCallback((id: number) => {
    watched.current = id;
    setRunId(id);
    setShowItems(false);
    setRunError(null);
  }, []);

  // Someone else (or the automatic run) changed bulk pricing or prices: reload.
  useDataChanged(['bulk_pricing', 'inventory'], () => {
    void loadStatus();
    void loadRuns();
    setReviewKey((k) => k + 1);
  });

  // A run already in progress (started elsewhere, or before a reload).
  const runningId = status?.running?.id ?? null;
  useEffect(() => {
    if (runningId !== null && runId === null) followRun(runningId);
  }, [runningId, runId, followRun]);

  // Settings form starts from what's saved.
  useEffect(() => {
    if (status && draft === null) setDraft(toDraft(status.settings));
  }, [status, draft]);

  // Ticking items switches the run to them; clearing switches back.
  const hasSelection = selected.size > 0;
  useEffect(() => {
    setScope((s) => (hasSelection ? 'selected' : s === 'selected' ? 'due' : s));
  }, [hasSelection]);

  const onFinished = useRef<(d: RunDetail) => void>(() => {});
  onFinished.current = (d: RunDetail) => {
    const r = d.run;
    void loadStatus();
    void loadRuns();
    setReviewKey((k) => k + 1);
    if (!r.dryRun && r.updated > 0) onPricesUpdated?.();
    const what = r.dryRun ? `Preview #${r.id}` : `Run #${r.id}`;
    if (r.status === 'failed') {
      onShowNotification(`${what} failed: ${r.error || 'unknown error'}`, 'ERROR');
      return;
    }
    const changed = r.dryRun ? `${plural(r.updated, 'price')} would change` : `${plural(r.updated, 'price')} updated`;
    const notPriced = r.failed + r.noPrice + r.flagged;
    const tail = notPriced ? `, ${fmtNumber(notPriced)} not priced (see why below)` : '';
    onShowNotification(`${what} ${(RUN_STATUS[r.status]?.label ?? r.status).toLowerCase()}: ${changed}, ${fmtNumber(r.unchanged)} unchanged${tail}.`,
      r.status === 'completed' ? 'SUCCESS' : 'INFO');
  };

  // Follow the run on show; poll while it is running.
  useEffect(() => {
    if (runId === null) return;
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const { ok, data } = await api<RunDetail>(`/api/pricing/bulk-runs/${runId}`);
        if (cancelled) return;
        if (!ok) { setRunError(data.error || `Could not load run #${runId}.`); return; }
        setDetail(data);
        setRunError(null);
        if (data.run.status === 'running') {
          timer = window.setTimeout(load, data.run.stale ? pollIntervalMs * 5 : pollIntervalMs);
        } else if (watched.current === runId) {
          watched.current = null;
          onFinished.current(data);
        }
      } catch {
        if (!cancelled) timer = window.setTimeout(load, pollIntervalMs * 2);
      }
    };
    void load();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [runId, pollIntervalMs, pollNonce]);

  // The run detail is polled, so it is fresher than the log's "running" for the same run.
  const running = detail?.run.status === 'running'
    ? detail.run
    : status?.running && status.running.id !== detail?.run.id ? status.running : null;

  const scopeCount = (s: Scope): number => {
    if (s === 'selected') return selected.size;
    if (!status) return 0;
    const c = status.counts;
    return s === 'due' ? c.due : s === 'missing' ? c.missing : c.all - c.noPartNumber;
  };

  const startRun = async (dryRun: boolean) => {
    if (!status) return;
    const n = scopeCount(scope);
    if (n === 0) {
      onShowNotification(SCOPES.find((s) => s.value === scope)!.empty, 'INFO');
      return;
    }
    const many = n > 50;
    if (!dryRun || many) {
      const s = status.settings;
      const ok = await confirmDialog({
        title: dryRun ? 'Preview bulk prices' : 'Update bulk prices',
        message: dryRun
          ? `Check ${plural(n, 'item')} with the suppliers? Nothing is saved, but each lookup counts towards the daily supplier API limits.`
          : `Re-price ${plural(n, 'item')} at ${fmtNumber(s.qty)} units from the suppliers?\n\n`
            + `Only each item's bulk price (R and $) is written. Stock, part numbers, links and the item's cost are not changed. `
            + `A unit price above ${fmtCurrency(s.suspiciousAboveUsd, 'USD')} is held back for review.`
            + (many ? '\n\nItems are priced one at a time, so this can take a while. You can stop the run at any time.' : ''),
        confirmLabel: dryRun ? `Preview ${plural(n, 'item')}` : `Update ${plural(n, 'item')}`,
      });
      if (!ok) return;
    }
    setStarting(true);
    try {
      const body: Record<string, unknown> = { scope, dryRun };
      if (scope === 'selected') body.serialNumbers = [...selected];
      const { ok, status: code, data } = await sendJson<{ runId: number }>('POST', '/api/pricing/bulk-runs', body);
      if (code === 409) {
        onShowNotification(data.error || 'A bulk pricing run is already in progress.', 'ERROR');
        const other = (data as { runId?: number }).runId;
        if (other) followRun(other);
        return;
      }
      if (!ok) {
        onShowNotification(`Could not start the run: ${data.error || `HTTP ${code}`}`, 'ERROR');
        return;
      }
      followRun(data.runId);
      void loadRuns();
    } catch (err: any) {
      onShowNotification(`Could not start the run: ${err?.message || err}`, 'ERROR');
    } finally {
      setStarting(false);
    }
  };

  const stopRun = async (id: number) => {
    try {
      const { ok, data } = await sendJson<{ message: string }>('POST', `/api/pricing/bulk-runs/${id}/stop`, {});
      onShowNotification(ok ? data.message : data.error || 'Could not stop the run.', ok ? 'INFO' : 'ERROR');
    } catch (err: any) {
      onShowNotification(`Could not stop the run: ${err?.message || err}`, 'ERROR');
    }
    setPollNonce((n) => n + 1);
  };

  // An item left out of bulk pricing goes back in (the problem review leaves items out).
  const putBack = async (serial: string) => {
    try {
      const { ok, data } = await sendJson<{ excluded: boolean }>('POST', `/api/pricing/bulk-review/${encodeURIComponent(serial)}/exclude`, { excluded: false });
      onShowNotification(ok ? `${serial} is back in bulk pricing.` : data.error || 'Could not put it back.', ok ? 'SUCCESS' : 'ERROR');
      if (ok) { void loadStatus(); setReviewKey((k) => k + 1); }
    } catch (err: any) {
      onShowNotification(`Could not put it back: ${err?.message || err}`, 'ERROR');
    }
  };

  const openRun = (run: Run) => {
    watched.current = run.status === 'running' ? run.id : null;
    setRunId(run.id);
    setShowItems(true);
    setRunError(null);
  };

  const closeRun = () => {
    watched.current = null;
    setRunId(null);
    setDetail(null);
  };

  const toggleHistory = async (serial: string) => {
    if (historyFor === serial) { setHistoryFor(null); return; }
    setHistoryFor(serial);
    setHistory(null);
    setHistoryError(null);
    try {
      const { ok, data } = await api<{ retentionDays: number; history: RunItem[] }>(`/api/pricing/bulk-status/${encodeURIComponent(serial)}/history`);
      if (!ok) { setHistoryError(data.error || 'Could not load the history.'); return; }
      setHistory({ serial, retentionDays: data.retentionDays, rows: data.history ?? [] });
    } catch (err: any) {
      setHistoryError(`Could not load the history: ${err?.message || err}`);
    }
  };

  const toggleSelected = (serial: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(serial)) next.delete(serial); else next.add(serial);
    return next;
  });
  const pageItems = status?.items ?? [];
  const allOnPageSelected = pageItems.length > 0 && pageItems.every((i) => selected.has(i.serialNumber));
  const toggleAllOnPage = () => setSelected((prev) => {
    const next = new Set(prev);
    for (const i of pageItems) {
      if (allOnPageSelected) next.delete(i.serialNumber); else next.add(i.serialNumber);
    }
    return next;
  });

  const settingsDirty = !!(draft && status && (draft.autoEnabled !== status.settings.autoEnabled
    || SETTING_FIELDS.some((f) => draft.values[f.key] !== String(status.settings[f.key]))));

  const saveSettings = async () => {
    if (!draft) return;
    const body: Record<string, unknown> = { autoEnabled: draft.autoEnabled };
    for (const f of SETTING_FIELDS) body[f.key] = draft.values[f.key].trim() === '' ? null : Number(draft.values[f.key]);
    setSavingSettings(true);
    try {
      const { ok, data } = await sendJson<{ settings: BulkPricingSettings; warnings: string[] }>('PUT', '/api/pricing/bulk-settings', body);
      if (!ok) { onShowNotification(data.error || 'Could not save the settings.', 'ERROR'); return; }
      setDraft(toDraft(data.settings));
      onShowNotification('Bulk pricing settings saved.');
      void loadStatus();
    } catch (err: any) {
      onShowNotification(`Could not save the settings: ${err?.message || err}`, 'ERROR');
    } finally {
      setSavingSettings(false);
    }
  };

  const shownRunItems = useMemo(() => {
    const items = detail?.items ?? [];
    if (itemFilter === 'changed') return items.filter((i) => i.status === 'updated');
    if (itemFilter === 'problems') return items.filter((i) => i.status !== 'updated' && i.status !== 'unchanged');
    return items;
  }, [detail, itemFilter]);

  const settings = status?.settings;
  const counts = status?.counts;

  return (
    <div className="space-y-lg" id="bulk-pricing">
      {/* Header: what this does, and the automatic schedule */}
      <div className="bg-surface-container rounded-xl border border-outline-variant p-lg">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-md">
          <div className="max-w-[720px]">
            <h4 className="text-base font-bold text-on-surface">Bulk pricing</h4>
            <p className="text-xs text-on-surface-variant mt-1 leading-relaxed">
              Refreshes each item's bulk price, the supplier's unit price at {fmtNumber(settings?.qty ?? 1000)} units, from Mouser, DigiKey, LCSC,
              Nexar, element14 and TME, cheapest first. <span className="font-semibold text-on-surface">Only the bulk price (R and $) is written:</span> stock,
              part numbers, links and the item's cost are never changed.
            </p>
            {settings && (
              <p className="text-xs text-on-surface-variant mt-2 flex items-start gap-1.5" data-testid="auto-summary">
                <Clock className="w-3.5 h-3.5 mt-px shrink-0 text-primary" />
                {settings.autoEnabled ? (
                  <span>
                    Automatic: items last priced more than {plural(settings.autoThresholdDays, 'day')} ago are re-priced daily, up to {fmtNumber(settings.autoBatchSize)} per run.
                    {status?.nextAutoRunAt && <> Next run <b className="text-on-surface">{fmtNextRun(status.nextAutoRunAt)}</b>.</>}
                    {status?.lastAutoRun
                      ? <> Last automatic run #{status.lastAutoRun.id}, {fmtWhen(status.lastAutoRun.startedAt)}: {fmtNumber(status.lastAutoRun.checked)} checked, {fmtNumber(status.lastAutoRun.updated)} updated{status.lastAutoRun.failed ? `, ${fmtNumber(status.lastAutoRun.failed)} failed` : ''}.</>
                      : <> No automatic run yet.</>}
                  </span>
                ) : (
                  <span>Automatic re-pricing is off{isAdmin ? ': turn it on under Settings.' : '.'}</span>
                )}
              </p>
            )}
          </div>
          <div className="flex gap-sm shrink-0">
            {onReviewPartNumbers && (
              <SecondaryButton type="button" onClick={onReviewPartNumbers}>Review part numbers</SecondaryButton>
            )}
            <SecondaryButton type="button" onClick={() => setShowSettings((v) => !v)} icon={<Settings2 className="w-3.5 h-3.5" />} aria-expanded={showSettings}>
              Settings
            </SecondaryButton>
          </div>
        </div>

        {status?.warnings?.map((w) => (
          <div key={w} className="mt-md flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
            <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" /><span>{w}</span>
          </div>
        ))}

        {showSettings && draft && (
          <div className="mt-md pt-md border-t border-outline-variant" data-testid="bulk-settings">
            <label className="flex items-center gap-2 text-xs font-bold text-on-surface mb-md">
              <input
                type="checkbox"
                checked={draft.autoEnabled}
                disabled={!isAdmin}
                onChange={(e) => setDraft({ ...draft, autoEnabled: e.target.checked })}
                className="accent-primary"
              />
              Re-price due items automatically every day
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-md">
              {SETTING_FIELDS.map((f) => (
                <div key={f.key}>
                  <FieldLabel hint={f.hint}>{f.label}</FieldLabel>
                  <input
                    type="number"
                    step={f.step ?? '1'}
                    aria-label={f.label}
                    value={draft.values[f.key]}
                    disabled={!isAdmin}
                    onChange={(e) => setDraft({ ...draft, values: { ...draft.values, [f.key]: e.target.value } })}
                    className={`${inputClass} disabled:opacity-60`}
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-md mt-md flex-wrap">
              <p className="text-[11px] text-outline max-w-[560px]">
                History is kept for 40 days by default, longer than the 35-day re-price interval, so an item's previous change is still on record when it is re-priced.
                Each item's latest result is kept regardless.
              </p>
              {isAdmin ? (
                <div className="flex gap-sm">
                  <SecondaryButton type="button" disabled={!settingsDirty || savingSettings} onClick={() => status && setDraft(toDraft(status.settings))}>Reset</SecondaryButton>
                  <PrimaryButton type="button" disabled={!settingsDirty || savingSettings} onClick={saveSettings}
                    icon={savingSettings ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}>
                    {savingSettings ? 'Saving…' : 'Save settings'}
                  </PrimaryButton>
                </div>
              ) : (
                <span className="text-[11px] text-outline">Only an admin can change these.</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Start a run */}
      <div className="bg-surface-container rounded-xl border border-outline-variant p-lg">
        <div className="flex flex-col md:flex-row md:items-end gap-md">
          <div className="flex-1 max-w-[420px]">
            <FieldLabel>Price</FieldLabel>
            <select aria-label="Items to price" value={scope} onChange={(e) => setScope(e.target.value as Scope)} className={selectClass} disabled={starting}>
              {SCOPES.map((s) => (
                <option key={s.value} value={s.value} disabled={s.value === 'selected' && !hasSelection}>
                  {s.label} ({fmtNumber(scopeCount(s.value))})
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-sm flex-wrap">
            <SecondaryButton type="button" disabled={!canRun || !status || starting || !!running} onClick={() => startRun(true)} icon={<Eye className="w-3.5 h-3.5" />}>
              Preview
            </SecondaryButton>
            <PrimaryButton type="button" disabled={!canRun || !status || starting || !!running} onClick={() => startRun(false)}
              icon={starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}>
              Update prices
            </PrimaryButton>
          </div>
        </div>
        <p className="text-[11px] text-outline mt-sm">
          {!canRun
            ? `${notAllowedMessage('inventory.update')} You can see the list, the runs and the history.`
            : running
              ? `Run #${running.id} is in progress; a new run can start when it finishes.`
              : 'Preview asks the suppliers and shows what would change, without saving anything. Supplier answers are cached for 30 days, so repeating a run costs no extra API calls.'}
        </p>
      </div>

      {/* The run in progress, or the one opened from Recent runs */}
      {runError && (
        <div className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-xs text-error flex items-center justify-between gap-2">
          <span>{runError}</span>
          <button type="button" onClick={closeRun} aria-label="Dismiss"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      {detail && runId === detail.run.id && (
        <RunCard
          detail={detail}
          showItems={showItems}
          setShowItems={setShowItems}
          itemFilter={itemFilter}
          setItemFilter={setItemFilter}
          shownItems={shownRunItems}
          onStop={canRun ? () => stopRun(detail.run.id) : undefined}
          onClose={closeRun}
        />
      )}

      {/* Recent runs */}
      {runs.length > 0 && (
        <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden">
          <div className="px-lg py-sm border-b border-outline-variant bg-surface-container-high/30 flex items-center gap-sm">
            <History className="w-4 h-4 text-primary" />
            <span className="font-bold text-sm">Recent runs</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="recent-runs">
              <thead>
                <tr className="bg-surface-container-high text-[10px] text-outline uppercase tracking-wider">
                  <th className="px-lg py-sm">Run</th>
                  <th className="px-lg py-sm">Started</th>
                  <th className="px-lg py-sm">By</th>
                  <th className="px-lg py-sm">Items</th>
                  <th className="px-lg py-sm">Result</th>
                  <th className="px-lg py-sm text-right">Checked</th>
                  <th className="px-lg py-sm text-right">Updated</th>
                  <th className="px-lg py-sm text-right">Not priced</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30">
                {runs.map((r) => (
                  <tr key={r.id} className={`cursor-pointer hover:bg-surface-variant/10 ${runId === r.id ? 'bg-primary/5' : ''}`} onClick={() => openRun(r)}>
                    <td className="px-lg py-sm font-mono font-bold">#{r.id}{r.dryRun && <span className="ml-1 text-[10px] font-sans font-semibold text-outline">preview</span>}</td>
                    <td className="px-lg py-sm text-on-surface-variant">{fmtWhen(r.startedAt)}</td>
                    <td className="px-lg py-sm text-on-surface-variant">{r.trigger === 'auto' ? 'Automatic' : r.requestedBy || 'Manual'}</td>
                    <td className="px-lg py-sm text-on-surface-variant">{SCOPE_SHORT[r.scope] ?? r.scope}</td>
                    <td className="px-lg py-sm"><RunPill status={r.status} /></td>
                    <td className="px-lg py-sm text-right font-mono">{fmtNumber(r.checked)}/{fmtNumber(r.total)}</td>
                    <td className="px-lg py-sm text-right font-mono">{fmtNumber(r.updated)}</td>
                    <td className="px-lg py-sm text-right font-mono">{fmtNumber(r.failed + r.noPrice + r.flagged)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Items whose last result needs a person: compare, approve, keep, set, exclude */}
      <BulkPricingReview
        onShowNotification={onShowNotification}
        onOpenItem={onOpenItem}
        refreshKey={reviewKey}
        onDecided={(priceChanged) => {
          void loadStatus();
          if (priceChanged) onPricesUpdated?.();
        }}
      />

      {/* The log: when each item was last bulk priced */}
      <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden">
        <div className="px-lg py-sm border-b border-outline-variant bg-surface-container-high/30 flex flex-wrap items-center justify-between gap-sm">
          <div className="flex items-center gap-sm">
            <span className="font-bold text-sm">Last bulk priced</span>
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" aria-label="Loading" />}
          </div>
          <button type="button" onClick={() => { void loadStatus(); void loadRuns(); }} className="text-xs text-on-surface-variant hover:text-primary flex items-center gap-1">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        <div className="p-md border-b border-outline-variant/50 flex flex-col gap-sm">
          <div className="flex flex-wrap gap-xs" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={filter === f.value}
                onClick={() => { setFilter(f.value); setOffset(0); }}
                className={`px-2.5 py-1 rounded-full text-[11px] font-bold border transition-colors ${
                  filter === f.value ? 'bg-primary/15 text-primary border-primary/40' : 'border-outline-variant text-on-surface-variant hover:border-primary/40'
                }`}
              >
                {f.label}{counts ? ` (${fmtNumber(f.count(counts))})` : ''}
              </button>
            ))}
          </div>
          <div className="flex flex-col sm:flex-row gap-sm">
            <div className="relative flex-1 max-w-[360px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-outline" />
              <input
                type="search"
                aria-label="Search items"
                placeholder="Search stock code, name, part number or LCSC number"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className={`${inputClass} pl-8 py-1.5 text-xs`}
              />
            </div>
            <select aria-label="Sort" value={sort} onChange={(e) => { setSort(e.target.value); setOffset(0); }} className={`${selectClass} sm:w-[220px] py-1.5 text-xs`}>
              {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          {hasSelection && (
            <div className="text-[11px] text-on-surface-variant flex items-center gap-2">
              <span><b className="text-on-surface">{plural(selected.size, 'item')}</b> ticked, to price with "Ticked items" above.</span>
              <button type="button" className="underline hover:text-primary" onClick={() => setSelected(new Set())}>Clear</button>
            </div>
          )}
        </div>

        {statusError && (
          <div className="px-lg py-sm text-xs text-error flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5" /> {statusError}
            <button type="button" className="underline" onClick={() => void loadStatus()}>Try again</button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs" data-testid="bulk-log">
            <thead>
              <tr className="bg-surface-container-high text-[10px] text-outline uppercase tracking-wider border-b border-outline-variant">
                <th className="px-md py-sm w-10 text-center">
                  <input type="checkbox" aria-label="Tick every item on this page" checked={allOnPageSelected} onChange={toggleAllOnPage} className="accent-primary" />
                </th>
                <th className="px-md py-sm">Item</th>
                <th className="px-md py-sm">Part number</th>
                <th className="px-md py-sm text-right">Bulk price</th>
                <th className="px-md py-sm">Last bulk priced</th>
                <th className="px-md py-sm">Last result</th>
                <th className="px-md py-sm text-right">Last change</th>
                <th className="px-md py-sm">Next due</th>
                <th className="px-md py-sm"><span className="sr-only">History</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30 text-on-surface">
              {status && pageItems.length === 0 && (
                <tr><td colSpan={9} className="py-8 text-center text-outline italic">No items match.</td></tr>
              )}
              {!status && !statusError && (
                <tr><td colSpan={9} className="py-8 text-center text-outline"><Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />Loading…</td></tr>
              )}
              {pageItems.map((item) => (
                <React.Fragment key={item.serialNumber}>
                  <tr className="hover:bg-surface-variant/10" data-serial={item.serialNumber}>
                    <td className="px-md py-sm text-center">
                      <input type="checkbox" aria-label={`Tick ${item.serialNumber}`} checked={selected.has(item.serialNumber)}
                        onChange={() => toggleSelected(item.serialNumber)} className="accent-primary" />
                    </td>
                    <td className="px-md py-sm">
                      <span className="font-mono font-bold block">{item.serialNumber}</span>
                      {item.name && <span className="text-[11px] text-on-surface-variant">{item.name}</span>}
                    </td>
                    <td className="px-md py-sm font-mono text-[11px] text-on-surface-variant">
                      {item.partNumber ?? <span className="italic text-outline font-sans">none</span>}
                      {item.lcscCode && item.lcscCode !== item.partNumber && (
                        <span className="block text-[10px] text-outline" title="LCSC is asked by the item's LCSC part number">LCSC {item.lcscCode}</span>
                      )}
                    </td>
                    <td className="px-md py-sm text-right font-mono whitespace-nowrap">
                      <span className="block">{fmtZar(item.bulkPriceZar)}</span>
                      {item.bulkPriceUsd !== null && <span className="text-[10px] text-outline">{fmtUsdPrice(item.bulkPriceUsd)}</span>}
                    </td>
                    <td className="px-md py-sm whitespace-nowrap" title={item.lastSuccessAt ? fmtWhen(item.lastSuccessAt) : undefined}>
                      {item.lastSuccessAt
                        ? <><span className="block">{fmtDay(item.lastSuccessAt)}</span><span className="text-[10px] text-outline">{ago(item.lastSuccessAt)}{item.lastSource === 'auto' ? ' · automatic' : ''}</span></>
                        : <span className="text-outline italic">Never</span>}
                    </td>
                    <td className="px-md py-sm max-w-[260px]">
                      <ItemPill status={item.lastStatus} title={item.lastError} />
                      {item.lastError && item.lastStatus !== 'updated' && item.lastStatus !== 'unchanged' && (
                        <span className="block text-[10px] text-outline mt-0.5 truncate" title={item.lastError}>{item.lastError}</span>
                      )}
                      {item.lastAttemptAt && item.lastStatus && item.lastAttemptAt !== item.lastSuccessAt && (
                        <span className="block text-[10px] text-outline">{ago(item.lastAttemptAt)}{item.lastRunId ? ` · run #${item.lastRunId}` : ''}</span>
                      )}
                    </td>
                    <td className="px-md py-sm text-right font-mono whitespace-nowrap text-[11px]">
                      {item.lastNewPriceZar !== null
                        ? <>{fmtZar(item.lastOldPriceZar)} <span className="text-outline">→</span> <b>{fmtZar(item.lastNewPriceZar)}</b></>
                        : <span className="text-outline">—</span>}
                    </td>
                    <td className="px-md py-sm whitespace-nowrap">
                      <span className={item.partNumber && !item.excluded && (item.due || !item.nextDueAt) ? 'text-primary font-bold' : 'text-on-surface-variant'}
                        title={item.excluded ? (item.excludedBy ? `Left out by ${item.excludedBy}` : undefined) : item.nextDueAt ? fmtWhen(item.nextDueAt) : undefined}>
                        {dueText(item)}
                      </span>
                      {item.excluded && canRun && (
                        <button type="button" onClick={() => void putBack(item.serialNumber)} className="block text-[10px] text-primary hover:underline">Put back</button>
                      )}
                    </td>
                    <td className="px-md py-sm text-right">
                      <button type="button" onClick={() => toggleHistory(item.serialNumber)} aria-expanded={historyFor === item.serialNumber}
                        className="text-[11px] text-on-surface-variant hover:text-primary whitespace-nowrap">
                        {historyFor === item.serialNumber ? 'Hide' : 'History'}
                      </button>
                    </td>
                  </tr>
                  {historyFor === item.serialNumber && (
                    <tr className="bg-surface-container-low/60">
                      <td colSpan={9} className="px-lg py-md">
                        <ItemHistory serial={item.serialNumber} history={history?.serial === item.serialNumber ? history : null} error={historyError} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {status && status.total > 0 && (
          <div className="px-lg py-sm border-t border-outline-variant flex items-center justify-between text-[11px] text-on-surface-variant">
            <span>{fmtNumber(status.offset + 1)}–{fmtNumber(status.offset + pageItems.length)} of {fmtNumber(status.total)}</span>
            <div className="flex gap-xs">
              <button type="button" aria-label="Previous page" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                className="p-1 rounded border border-outline-variant disabled:opacity-40"><ChevronLeft className="w-3.5 h-3.5" /></button>
              <button type="button" aria-label="Next page" disabled={offset + PAGE_SIZE >= status.total} onClick={() => setOffset(offset + PAGE_SIZE)}
                className="p-1 rounded border border-outline-variant disabled:opacity-40"><ChevronRight className="w-3.5 h-3.5" /></button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- the run card -----------------------------------------------------------

const RunCard: React.FC<{
  detail: RunDetail;
  showItems: boolean;
  setShowItems: (v: boolean) => void;
  itemFilter: 'all' | 'changed' | 'problems';
  setItemFilter: (v: 'all' | 'changed' | 'problems') => void;
  shownItems: RunItem[];
  /** Absent when the user's role may not stop runs. */
  onStop?: () => void;
  onClose: () => void;
}> = ({ detail, showItems, setShowItems, itemFilter, setItemFilter, shownItems, onStop, onClose }) => {
  const { run, reasons, items } = detail;
  const isRunning = run.status === 'running';
  const percent = run.total ? Math.round((run.checked / run.total) * 100) : 0;
  const tiles: Array<[string, number, string]> = [
    [run.dryRun ? 'Would change' : 'Updated', run.updated, 'text-green-400'],
    ['Unchanged', run.unchanged, 'text-on-surface'],
    ['Held back', run.flagged, 'text-amber-500'],
    ['No price', run.noPrice, 'text-amber-500'],
    ['Skipped', run.skipped, 'text-on-surface-variant'],
    ['Failed', run.failed, 'text-error'],
  ];
  const took = duration(run);
  return (
    <div className="bg-surface-container rounded-xl border border-primary/30 overflow-hidden" data-testid="run-card">
      <div className="px-lg py-sm border-b border-outline-variant bg-primary/5 flex flex-wrap items-center justify-between gap-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <span className="font-bold text-sm">{run.dryRun ? 'Preview' : 'Run'} #{run.id}</span>
          <RunPill status={run.status} />
          <span className="text-[11px] text-on-surface-variant">
            {SCOPE_SHORT[run.scope] ?? run.scope} · {run.trigger === 'auto' ? 'automatic' : run.requestedBy || 'manual'} · started {fmtWhen(run.startedAt)}{took ? ` · took ${took}` : ''}
          </span>
        </div>
        <div className="flex items-center gap-sm">
          {isRunning && !run.stopRequested && onStop && (
            <DangerButton type="button" onClick={onStop} icon={<Square className="w-3 h-3" />}>Stop</DangerButton>
          )}
          {isRunning && run.stopRequested && <span className="text-[11px] text-on-surface-variant">Stopping after the current item…</span>}
          {!isRunning && (
            <button type="button" onClick={onClose} aria-label="Close run" className="text-on-surface-variant hover:text-on-surface"><X className="w-4 h-4" /></button>
          )}
        </div>
      </div>

      <div className="p-lg space-y-md">
        <div>
          <div className="flex justify-between text-[11px] text-on-surface-variant mb-1">
            <span>{fmtNumber(run.checked)} of {plural(run.total, 'item')} checked</span>
            <span>{percent}%</span>
          </div>
          <div className="w-full bg-outline-variant/30 h-1.5 rounded-full overflow-hidden">
            <div className="bg-primary h-full transition-all" style={{ width: `${percent}%` }} role="progressbar" aria-label="Run progress"
              aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} />
          </div>
        </div>

        {run.stale && isRunning && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
            <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
            <span>No sign of life from this run for over 10 minutes: its server most likely restarted. It is marked interrupted when the next run starts.</span>
          </div>
        )}

        <div className="grid grid-cols-3 md:grid-cols-6 gap-sm" data-testid="run-counts">
          {tiles.map(([label, value, color]) => (
            <div key={label} className="rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2">
              <span className="block text-[10px] font-bold text-on-surface-variant">{label}</span>
              <span className={`text-lg font-black font-mono ${value ? color : 'text-outline'}`}>{fmtNumber(value)}</span>
            </div>
          ))}
        </div>

        {run.note && <p className="text-xs text-on-surface-variant">{run.note}</p>}
        {run.error && <p className="text-xs text-error">{run.error}</p>}

        {reasons.length > 0 && (
          <div data-testid="run-reasons">
            <span className="block text-[11px] font-bold text-on-surface-variant mb-1">Why items were not updated</span>
            <ul className="space-y-1">
              {reasons.map((r) => (
                <li key={`${r.status}|${r.reason}`} className="flex items-start gap-2 text-xs">
                  <ItemPill status={r.status} />
                  <span className="font-mono font-bold text-on-surface shrink-0">{fmtNumber(r.count)} ×</span>
                  <span className="text-on-surface-variant">{r.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {items.length > 0 && (
          <div>
            <button type="button" onClick={() => setShowItems(!showItems)} className="text-xs font-bold text-primary hover:underline" aria-expanded={showItems}>
              {showItems ? 'Hide items' : `Show items (${fmtNumber(items.length)})`}
            </button>
            {showItems && (
              <div className="mt-sm">
                <div className="flex gap-xs mb-sm" role="group" aria-label="Show items">
                  {(['all', 'changed', 'problems'] as const).map((f) => (
                    <button key={f} type="button" aria-pressed={itemFilter === f} onClick={() => setItemFilter(f)}
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${itemFilter === f ? 'bg-primary/15 text-primary border-primary/40' : 'border-outline-variant text-on-surface-variant'}`}>
                      {f === 'all' ? 'All' : f === 'changed' ? (run.dryRun ? 'Would change' : 'Changed') : 'Not priced'}
                    </button>
                  ))}
                </div>
                <div className="overflow-x-auto max-h-[420px] overflow-y-auto border border-outline-variant/50 rounded-lg">
                  <table className="w-full text-left text-xs" data-testid="run-items">
                    <thead className="sticky top-0 bg-surface-container-high">
                      <tr className="text-[10px] text-outline uppercase tracking-wider">
                        <th className="px-md py-1.5">Item</th>
                        <th className="px-md py-1.5">Result</th>
                        <th className="px-md py-1.5 text-right">Was</th>
                        <th className="px-md py-1.5 text-right">{run.dryRun ? 'Would be' : 'Now'}</th>
                        <th className="px-md py-1.5">Supplier</th>
                        <th className="px-md py-1.5">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/30">
                      {shownItems.map((i) => (
                        <tr key={i.id}>
                          <td className="px-md py-1.5">
                            <span className="font-mono font-bold">{i.serialNumber}</span>
                            {i.name && <span className="block text-[10px] text-on-surface-variant">{i.name}</span>}
                          </td>
                          <td className="px-md py-1.5"><ItemPill status={i.status} /></td>
                          <td className="px-md py-1.5 text-right font-mono whitespace-nowrap">{fmtZar(i.oldPriceZar)}</td>
                          <td className="px-md py-1.5 text-right font-mono whitespace-nowrap">{i.newPriceZar !== null ? fmtZar(i.newPriceZar) : '—'}</td>
                          <td className="px-md py-1.5 text-on-surface-variant">
                            {i.provider ?? '—'}
                            {i.nativePrice !== null && i.nativeCurrency && i.nativeCurrency !== 'ZAR' && (
                              <span className="block text-[10px] text-outline">{fmtNative(i.nativePrice, i.nativeCurrency)}{i.matchedPart ? ` · ${i.matchedPart}` : ''}</span>
                            )}
                          </td>
                          <td className="px-md py-1.5 text-on-surface-variant max-w-[320px]">{i.reason ?? ''}</td>
                        </tr>
                      ))}
                      {shownItems.length === 0 && (
                        <tr><td colSpan={6} className="px-md py-4 text-center text-outline italic">None.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// --- one item's history -----------------------------------------------------

const ItemHistory: React.FC<{
  serial: string;
  history: { retentionDays: number; rows: RunItem[] } | null;
  error: string | null;
}> = ({ serial, history, error }) => {
  if (error) return <p className="text-xs text-error">{error}</p>;
  if (!history) return <p className="text-xs text-outline"><Loader2 className="w-3.5 h-3.5 animate-spin inline-block mr-1" />Loading the history of {serial}…</p>;
  return (
    <div data-testid="item-history">
      <p className="text-[11px] text-on-surface-variant mb-sm">
        Bulk pricing history of <b className="font-mono">{serial}</b>, kept for {plural(history.retentionDays, 'day')}.
      </p>
      {history.rows.length === 0 ? (
        <p className="text-xs text-outline italic">No bulk pricing in that time.</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[10px] text-outline uppercase tracking-wider">
              <th className="py-1 pr-md">When</th>
              <th className="py-1 pr-md">Run</th>
              <th className="py-1 pr-md">Result</th>
              <th className="py-1 pr-md text-right">Was</th>
              <th className="py-1 pr-md text-right">New</th>
              <th className="py-1 pr-md">Supplier</th>
              <th className="py-1">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant/30">
            {history.rows.map((h) => (
              <tr key={h.id}>
                <td className="py-1 pr-md whitespace-nowrap">{fmtWhen(h.at)}</td>
                <td className="py-1 pr-md whitespace-nowrap text-on-surface-variant">
                  {h.runId ? `#${h.runId} · ${h.source === 'auto' ? 'automatic' : 'manual'}` : h.decidedBy ? `review · ${h.decidedBy}` : h.source === 'auto' ? 'automatic' : 'manual'}
                </td>
                <td className="py-1 pr-md"><ItemPill status={h.status} /></td>
                <td className="py-1 pr-md text-right font-mono whitespace-nowrap">{fmtZar(h.oldPriceZar)}</td>
                <td className="py-1 pr-md text-right font-mono whitespace-nowrap">{h.newPriceZar !== null ? fmtZar(h.newPriceZar) : '—'}</td>
                <td className="py-1 pr-md text-on-surface-variant">{h.provider ?? '—'}</td>
                <td className="py-1 text-on-surface-variant">{h.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
