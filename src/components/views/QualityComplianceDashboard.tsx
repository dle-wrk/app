// Quality & Compliance: inspections and their results, defects through to
// closure, non-conformance reports, and compliance checkpoints with the checks
// made against them. Every number on the overview is computed from those.
// Server: src/lib/qualityRoutes.ts.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, AlertTriangle, TrendingUp, FileText, ShieldCheck, Plus, Loader2, Play, Trash2, XCircle } from 'lucide-react';
import { canChange } from '../../lib/changeAccess';
import { confirmDialog } from '../../lib/confirmDialog';
import { PrimaryButton, SecondaryButton } from '../bookkeeping/shared';
import type { Item, Supplier } from '../../types';

type Toast = (msg: string, type?: string) => void;
type Tab = 'overview' | 'inspections' | 'defects' | 'ncr' | 'compliance';
interface Props { triggerToast: Toast; items?: Item[]; suppliers?: Supplier[]; onOpenItem?: (serial: string) => void }
/** What a failed inspection hands to the Defects or NCR form. */
interface Prefill { tab: 'defects' | 'ncr'; component_id: string; qa_inspection_id: number; description: string }

const input = 'w-full bg-surface-container-high border border-outline-variant rounded px-2 py-1.5 text-xs text-on-surface';
const label = 'text-[11px] font-bold text-on-surface-variant';
const day = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const today = () => new Date().toISOString().slice(0, 10);
const words = (s: string | null | undefined) => String(s ?? '').toLowerCase().replace(/_/g, ' ');

async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init && init.body ? { ...init, headers: { 'Content-Type': 'application/json' } } : init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

const PILL: Record<string, string> = {
  PASSED: 'bg-green-500/10 text-green-400', COMPLIANT: 'bg-green-500/10 text-green-400', RESOLVED: 'bg-green-500/10 text-green-400', CLOSED: 'bg-gray-500/10 text-outline',
  FAILED: 'bg-red-500/10 text-red-400', NON_COMPLIANT: 'bg-red-500/10 text-red-400', CRITICAL: 'bg-red-500/10 text-red-400',
  HOLD: 'bg-orange-500/10 text-orange-400', MAJOR: 'bg-orange-500/10 text-orange-400', OPEN: 'bg-orange-500/10 text-orange-400',
  MINOR: 'bg-yellow-500/10 text-yellow-400', WAIVED: 'bg-yellow-500/10 text-yellow-400',
};
const Pill = ({ s }: { s: string | null | undefined }) => <span className={`px-2 py-0.5 rounded text-[9px] font-bold whitespace-nowrap uppercase ${PILL[s ?? ''] ?? 'bg-blue-500/10 text-blue-400'}`}>{words(s) || 'never'}</span>;

function ItemField({ value, onChange, items, aria }: { value: string; onChange: (v: string) => void; items: Item[]; aria: string }) {
  return (
    <>
      <input className={`${input} font-mono`} list="quality-item-codes" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Stock code" aria-label={aria} />
      <datalist id="quality-item-codes">{items.map((i) => <option key={i.partNumber} value={i.partNumber}>{i.name}</option>)}</datalist>
    </>
  );
}

export default function QualityComplianceDashboard({ triggerToast, items = [], suppliers = [], onOpenItem }: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  const [summary, setSummary] = useState<any>(null);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const loadSummary = useCallback(async () => { try { setSummary(await api('/api/quality/summary')); } catch (e: any) { triggerToast(`Could not load quality: ${e.message}`, 'ERROR'); } }, [triggerToast]);
  useEffect(() => { void loadSummary(); }, [loadSummary]);
  const go = (t: Tab) => { setPrefill(null); setTab(t); };
  const tabs: Array<[Tab, string]> = [['overview', 'Overview'], ['inspections', 'Inspections'], ['defects', 'Defects'], ['ncr', 'NCRs'], ['compliance', 'Compliance']];

  return (
    <div className="p-container-margin space-y-lg max-w-[1400px] mx-auto w-full">
      <div>
        <h2 className="text-2xl font-bold text-on-surface mb-sm">Quality &amp; Compliance</h2>
        <p className="text-sm text-on-surface-variant">Inspections and their results, defects, non-conformance reports and compliance checks.</p>
      </div>
      <div className="flex gap-xs border-b border-outline-variant overflow-x-auto" role="tablist">
        {tabs.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => go(k)}
            className={`px-md py-2 text-sm font-bold whitespace-nowrap transition ${tab === k ? 'text-primary border-b-2 border-primary' : 'text-on-surface-variant hover:text-on-surface'}`}>{l}</button>
        ))}
      </div>
      {tab === 'overview' && <Overview s={summary} go={go} />}
      {tab === 'inspections' && <Inspections triggerToast={triggerToast} items={items} onOpenItem={onOpenItem} onChanged={loadSummary}
        onFollowUp={(p) => { setPrefill(p); setTab(p.tab); }} />}
      {tab === 'defects' && <Defects triggerToast={triggerToast} items={items} onChanged={loadSummary} prefill={prefill?.tab === 'defects' ? prefill : null} />}
      {tab === 'ncr' && <Ncrs triggerToast={triggerToast} items={items} suppliers={suppliers} onChanged={loadSummary} prefill={prefill?.tab === 'ncr' ? prefill : null} />}
      {tab === 'compliance' && <Compliance triggerToast={triggerToast} onChanged={loadSummary} />}
    </div>
  );
}

function Stat({ icon: Icon, title, value, sub, color, onClick }: { icon: any; title: string; value: React.ReactNode; sub: string; color: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-left bg-surface-container border border-outline-variant rounded-lg p-md hover:border-primary transition-colors">
      <div className="flex items-start justify-between">
        <div><p className="text-sm text-on-surface-variant mb-xs">{title}</p><p className="text-2xl font-bold text-on-surface">{value}</p><p className="text-[11px] text-outline mt-1">{sub}</p></div>
        <Icon className={`w-8 h-8 ${color}`} />
      </div>
    </button>
  );
}

function Overview({ s, go }: { s: any; go: (t: Tab) => void }) {
  if (!s) return <p className="text-xs text-outline flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>;
  const i = s.inspections; const d = s.defects; const n = s.ncrs; const c = s.compliance;
  const attention = [
    i.overdue ? [`${i.overdue} inspection${i.overdue === 1 ? ' is' : 's are'} past ${i.overdue === 1 ? 'its' : 'their'} date and not done`, 'inspections'] : null,
    d.critical ? [`${d.critical} critical defect${d.critical === 1 ? ' is' : 's are'} open`, 'defects'] : null,
    n.overdue ? [`${n.overdue} NCR${n.overdue === 1 ? ' is' : 's are'} past ${n.overdue === 1 ? 'its' : 'their'} due date`, 'ncr'] : null,
    c.failing ? [`${c.failing} compliance checkpoint${c.failing === 1 ? "'s" : "s'"} last check was not compliant`, 'compliance'] : null,
    c.never ? [`${c.never} compliance checkpoint${c.never === 1 ? ' has' : 's have'} never been checked`, 'compliance'] : null,
  ].filter(Boolean) as Array<[string, Tab]>;
  return (
    <div className="space-y-lg">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-md">
        <Stat icon={CheckCircle2} title="Inspections passed" value={i.passRate === null ? '—' : `${i.passRate}%`} sub={i.done ? `${i.passed} passed, ${i.failed} failed, ${i.hold} on hold; ${i.open} to do` : `None done yet; ${i.open} to do`} color="text-green-500" onClick={() => go('inspections')} />
        <Stat icon={TrendingUp} title="Defect rate" value={s.defectRate === null ? '—' : `${s.defectRate}%`} sub={s.defectRate === null ? 'Of units sampled; none sampled yet' : 'Defects found per unit sampled'} color="text-cyan-500" onClick={() => go('inspections')} />
        <Stat icon={AlertTriangle} title="Open defects" value={d.open} sub={`${d.critical} critical, ${d.major} major, ${d.minor} minor`} color="text-red-500" onClick={() => go('defects')} />
        <Stat icon={FileText} title="Open NCRs" value={n.open} sub={n.resolved ? `${n.overdue} overdue; resolved in ${n.avg_days} days on average` : `${n.overdue} overdue; none resolved yet`} color="text-orange-500" onClick={() => go('ncr')} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
        <div className="bg-surface-container border border-outline-variant rounded-lg p-md space-y-1" data-testid="quality-attention">
          <h3 className="font-bold text-on-surface mb-1">Needs attention</h3>
          {attention.length === 0 ? <p className="text-xs text-on-surface-variant">Nothing overdue, failing or critical.</p>
            : attention.map(([t, k]) => <button key={t} type="button" onClick={() => go(k)} className="block text-left text-xs text-error hover:underline">{t}</button>)}
        </div>
        <Stat icon={ShieldCheck} title="Compliance" value={c.checkpoints ? `${c.checkpoints - c.failing - c.never} of ${c.checkpoints}` : '—'} sub={c.checkpoints ? 'checkpoints compliant at their last check' : 'No checkpoints yet: add the ones your standard needs'} color="text-primary" onClick={() => go('compliance')} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspections

function Inspections({ triggerToast, items, onOpenItem, onChanged, onFollowUp }: { triggerToast: Toast; items: Item[]; onOpenItem?: (s: string) => void; onChanged: () => void; onFollowUp: (p: Prefill) => void }) {
  const may = canChange('/api/qa-inspections');
  const [show, setShow] = useState<'open' | 'done' | 'all'>('open');
  const [list, setList] = useState<any[] | null>(null);
  const [form, setForm] = useState<any | null>(null);
  const [result, setResult] = useState<{ id: number; result: string; defects_found: string; notes: string } | null>(null);
  const [failed, setFailed] = useState<any | null>(null);
  const load = useCallback(async () => { try { setList(await api('/api/qa-inspections')); } catch (e: any) { triggerToast(e.message, 'ERROR'); } }, [triggerToast]);
  useEffect(() => { void load(); }, [load]);
  const shown = (list ?? []).filter((r) => show === 'all' || (show === 'open') === ['SCHEDULED', 'IN_PROGRESS'].includes(r.status));
  const add = async () => {
    try { await api('/api/qa-inspections', { method: 'POST', body: JSON.stringify(form) }); setForm(null); triggerToast('Inspection scheduled.', 'SUCCESS'); await load(); onChanged(); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const start = async (r: any) => { try { await api(`/api/qa-inspections/${r.id}/start`, { method: 'PUT', body: '{}' }); await load(); } catch (e: any) { triggerToast(e.message, 'ERROR'); } };
  const save = async () => {
    if (!result) return;
    try {
      const r = await api(`/api/qa-inspections/${result.id}/result`, { method: 'PUT', body: JSON.stringify({ result: result.result, defects_found: Number(result.defects_found || 0), notes: result.notes }) });
      setResult(null); await load(); onChanged();
      if (r.status === 'FAILED') setFailed(r); else triggerToast(`Recorded: ${words(r.status)}.`, 'SUCCESS');
    } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const remove = async (r: any) => {
    if (!(await confirmDialog({ title: 'Delete inspection', message: `Delete the ${words(r.inspection_type)} inspection of ${r.component_id}?`, confirmLabel: 'Delete', destructive: true }))) return;
    try { await api(`/api/qa-inspections/${r.id}`, { method: 'DELETE' }); await load(); onChanged(); } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  return (
    <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-md">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <Choice value={show} set={setShow} options={[['open', 'To do'], ['done', 'Done'], ['all', 'All']]} aria="Show inspections" />
        {may && !form && <PrimaryButton type="button" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setForm({ component_id: '', inspection_type: 'INCOMING', sample_size: '10', scheduled_date: today(), batch_id: '', inspector_id: '', notes: '' })}>New inspection</PrimaryButton>}
      </div>
      {form && (
        <div className="bg-surface-container-high rounded-lg p-md grid grid-cols-1 md:grid-cols-3 gap-sm" data-testid="inspection-form">
          <label className={label}>Item<ItemField value={form.component_id} onChange={(v) => setForm({ ...form, component_id: v })} items={items} aria="Item to inspect" /></label>
          <label className={label}>Kind<select className={input} value={form.inspection_type} onChange={(e) => setForm({ ...form, inspection_type: e.target.value })} aria-label="Kind of inspection">
            <option value="INCOMING">Incoming (goods received)</option><option value="IN_PROCESS">In-process (during a build)</option><option value="FINAL">Final (before dispatch)</option></select></label>
          <label className={label}>Sample size<input className={`${input} font-mono`} inputMode="numeric" value={form.sample_size} onChange={(e) => setForm({ ...form, sample_size: e.target.value.replace(/[^0-9]/g, '') })} aria-label="Sample size" /></label>
          <label className={label}>Date<input type="date" className={input} value={form.scheduled_date} onChange={(e) => setForm({ ...form, scheduled_date: e.target.value })} aria-label="Inspection date" /></label>
          <label className={label}>Batch, lot or PO (optional)<input className={input} value={form.batch_id} onChange={(e) => setForm({ ...form, batch_id: e.target.value })} aria-label="Batch" /></label>
          <label className={label}>Inspector (blank: you)<input className={input} value={form.inspector_id} onChange={(e) => setForm({ ...form, inspector_id: e.target.value })} aria-label="Inspector" /></label>
          <label className={`${label} md:col-span-2`}>What to check (optional)<input className={input} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} aria-label="Criteria" placeholder="e.g. pin pitch, marking, solderability" /></label>
          <div className="flex gap-sm justify-end items-end"><SecondaryButton type="button" onClick={() => setForm(null)}>Cancel</SecondaryButton><PrimaryButton type="button" disabled={!form.component_id.trim() || !Number(form.sample_size)} onClick={() => void add()}>Schedule</PrimaryButton></div>
        </div>
      )}
      {failed && (
        <div className="rounded-lg border border-error/40 bg-error/5 p-md flex flex-wrap items-center gap-sm text-xs" data-testid="inspection-failed">
          <XCircle className="w-4 h-4 text-error" /><span className="text-on-surface">{failed.component_id} failed with {failed.defects_found} defect{failed.defects_found === 1 ? '' : 's'}. Follow it up:</span>
          <SecondaryButton type="button" onClick={() => onFollowUp({ tab: 'defects', component_id: failed.component_id, qa_inspection_id: failed.id, description: failed.notes ?? '' })}>Log the defect</SecondaryButton>
          <SecondaryButton type="button" onClick={() => onFollowUp({ tab: 'ncr', component_id: failed.component_id, qa_inspection_id: failed.id, description: failed.notes ?? '' })}>Raise an NCR</SecondaryButton>
          <button type="button" className="text-outline ml-auto" onClick={() => setFailed(null)}>Not now</button>
        </div>
      )}
      {!list ? <Loader2 className="w-4 h-4 animate-spin text-outline" /> : shown.length === 0 ? <p className="text-center py-8 text-outline text-xs">{show === 'open' ? 'No inspections to do.' : 'None yet.'}</p> : (
        <div className="space-y-2">
          {shown.map((r) => (
            <div key={r.id} className="bg-surface-container-high border border-outline-variant rounded p-3 space-y-2" data-inspection={r.id}>
              <div className="flex flex-wrap items-start justify-between gap-sm">
                <div>
                  <p className="text-sm text-on-surface">{onOpenItem ? <button type="button" className="font-mono font-bold text-primary hover:underline" onClick={() => onOpenItem(r.component_id)}>{r.component_id}</button> : <strong className="font-mono">{r.component_id}</strong>} <span className="text-xs text-on-surface-variant">{r.item_name}</span></p>
                  <p className="text-[11px] text-on-surface-variant">{words(r.inspection_type)} · {r.sample_size} sampled · {day(r.scheduled_day)}{r.batch_id ? ` · ${r.batch_id}` : ''} · {r.inspector_id}</p>
                  {r.notes && <p className="text-[11px] text-outline">{r.notes}</p>}
                  {['PASSED', 'FAILED', 'HOLD'].includes(r.status) && <p className="text-[11px] text-outline">{r.defects_found} defect{r.defects_found === 1 ? '' : 's'} found · {day(r.completed_date)}{r.defects_logged ? ` · ${r.defects_logged} logged` : ''}{r.ncr_number ? ` · ${r.ncr_number}` : ''}</p>}
                </div>
                <div className="flex items-center gap-1">
                  <Pill s={r.status} />
                  {may && r.status === 'SCHEDULED' && <button type="button" className="px-2 py-1 text-[11px] rounded hover:bg-surface-container inline-flex items-center gap-1" onClick={() => void start(r)}><Play className="w-3 h-3" /> Start</button>}
                  {may && ['SCHEDULED', 'IN_PROGRESS'].includes(r.status) && <button type="button" className="px-2 py-1 text-[11px] font-bold text-primary rounded hover:bg-surface-container" onClick={() => setResult({ id: r.id, result: 'PASSED', defects_found: '0', notes: '' })}>Record result</button>}
                  {may && r.status === 'SCHEDULED' && <button type="button" aria-label={`Delete inspection ${r.id}`} className="p-1 rounded hover:bg-error/10 text-error" onClick={() => void remove(r)}><Trash2 className="w-3.5 h-3.5" /></button>}
                </div>
              </div>
              {result && result.id === r.id && (
                <div className="flex flex-wrap items-end gap-sm border-t border-outline-variant/40 pt-2">
                  <Choice value={result.result} set={(v) => setResult((x) => x && { ...x, result: v })} options={[['PASSED', 'Passed'], ['FAILED', 'Failed'], ['HOLD', 'On hold']]} aria="Result" />
                  <label className={label}>Defects found<input className={`${input} w-24 font-mono`} inputMode="numeric" value={result.defects_found} onChange={(e) => setResult((x) => x && { ...x, defects_found: e.target.value.replace(/[^0-9]/g, '') })} aria-label="Defects found" /></label>
                  <label className={`${label} flex-1 min-w-[200px]`}>Notes<input className={input} value={result.notes} onChange={(e) => setResult((x) => x && { ...x, notes: e.target.value })} aria-label="Inspection notes" /></label>
                  <SecondaryButton type="button" onClick={() => setResult(null)}>Cancel</SecondaryButton><PrimaryButton type="button" onClick={() => void save()}>Save result</PrimaryButton>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Choice<T extends string>({ value, set, options, aria }: { value: T; set: (v: T) => void; options: Array<[T, string]>; aria: string }) {
  return (
    <div className="flex gap-1" role="radiogroup" aria-label={aria}>
      {options.map(([k, l]) => (
        <button key={k} type="button" role="radio" aria-checked={value === k} onClick={() => set(k)}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold border ${value === k ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant text-on-surface-variant hover:text-on-surface'}`}>{l}</button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Defects

const NEXT_DEFECT: Record<string, Array<[string, string]>> = { OPEN: [['INVESTIGATING', 'Investigate'], ['RESOLVED', 'Resolve']], INVESTIGATING: [['RESOLVED', 'Resolve']], RESOLVED: [['CLOSED', 'Close'], ['OPEN', 'Reopen']], CLOSED: [['OPEN', 'Reopen']] };

function Defects({ triggerToast, items, onChanged, prefill }: { triggerToast: Toast; items: Item[]; onChanged: () => void; prefill: Prefill | null }) {
  const may = canChange('/api/defects');
  const [show, setShow] = useState<'open' | 'all'>('open');
  const [list, setList] = useState<any[] | null>(null);
  const [form, setForm] = useState<any | null>(prefill ? { component_id: prefill.component_id, qa_inspection_id: prefill.qa_inspection_id, severity: 'MAJOR', defect_code: '', description: prefill.description, assigned_to: '' } : null);
  const [edit, setEdit] = useState<any | null>(null);
  const load = useCallback(async () => { try { setList(await api(`/api/defects${show === 'open' ? '?status=open' : ''}`)); } catch (e: any) { triggerToast(e.message, 'ERROR'); } }, [show, triggerToast]);
  useEffect(() => { void load(); }, [load]);
  const add = async () => {
    try { await api('/api/defects', { method: 'POST', body: JSON.stringify(form) }); setForm(null); triggerToast('Defect logged.', 'SUCCESS'); await load(); onChanged(); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const update = async (id: number, body: any) => {
    try { await api(`/api/defects/${id}`, { method: 'PUT', body: JSON.stringify(body) }); setEdit(null); await load(); onChanged(); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  return (
    <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-md">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <Choice value={show} set={setShow} options={[['open', 'Open'], ['all', 'All']]} aria="Show defects" />
        {may && !form && <PrimaryButton type="button" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setForm({ component_id: '', severity: 'MAJOR', defect_code: '', description: '', assigned_to: '' })}>Report defect</PrimaryButton>}
      </div>
      {form && (
        <div className="bg-surface-container-high rounded-lg p-md grid grid-cols-1 md:grid-cols-3 gap-sm" data-testid="defect-form">
          <label className={label}>Item<ItemField value={form.component_id} onChange={(v) => setForm({ ...form, component_id: v })} items={items} aria="Item with the defect" /></label>
          <label className={label}>How serious<select className={input} value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })} aria-label="Severity">
            <option value="CRITICAL">Critical (unsafe or unusable)</option><option value="MAJOR">Major (fails a requirement)</option><option value="MINOR">Minor (cosmetic)</option></select></label>
          <label className={label}>Code (optional)<input className={input} value={form.defect_code} onChange={(e) => setForm({ ...form, defect_code: e.target.value })} placeholder="e.g. BENT-PIN" aria-label="Defect code" /></label>
          <label className={`${label} md:col-span-2`}>What's wrong<input className={input} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} aria-label="Defect description" /></label>
          <label className={label}>Assigned to (optional)<input className={input} value={form.assigned_to} onChange={(e) => setForm({ ...form, assigned_to: e.target.value })} aria-label="Defect assigned to" /></label>
          {form.qa_inspection_id && <p className="text-[11px] text-outline md:col-span-2">From inspection {form.qa_inspection_id}.</p>}
          <div className="flex gap-sm justify-end md:col-start-3"><SecondaryButton type="button" onClick={() => setForm(null)}>Cancel</SecondaryButton><PrimaryButton type="button" disabled={!form.component_id.trim() || !form.description.trim()} onClick={() => void add()}>Log it</PrimaryButton></div>
        </div>
      )}
      {!list ? <Loader2 className="w-4 h-4 animate-spin text-outline" /> : list.length === 0 ? <p className="text-center py-8 text-outline text-xs">{show === 'open' ? 'No open defects.' : 'No defects recorded.'}</p> : (
        <div className="space-y-2">
          {list.map((d) => (
            <div key={d.id} className="bg-surface-container-high border border-outline-variant rounded p-3 space-y-2" data-defect={d.id}>
              <div className="flex flex-wrap items-start justify-between gap-sm">
                <div className="flex-1 min-w-[220px]">
                  <p className="text-sm text-on-surface"><strong className="font-mono">{d.component_id ?? '—'}</strong> <span className="text-xs text-on-surface-variant">{d.item_name}</span> <span className="text-[11px] text-outline">· {d.defect_code}</span></p>
                  <p className="text-xs text-on-surface-variant">{d.description}</p>
                  <p className="text-[11px] text-outline">{day(d.created_at)}{d.inspection_type ? ` · ${words(d.inspection_type)} inspection` : ''}{d.assigned_to ? ` · ${d.assigned_to}` : ''}{d.root_cause ? ` · cause: ${d.root_cause}` : ''}{d.resolution_notes ? ` · fix: ${d.resolution_notes}` : ''}</p>
                </div>
                <div className="flex items-center gap-1"><Pill s={d.severity} /><Pill s={d.status} />
                  {may && (NEXT_DEFECT[d.status] ?? []).map(([to, l]) => (
                    <button key={to} type="button" className="px-2 py-1 text-[11px] font-bold text-primary rounded hover:bg-surface-container"
                      onClick={() => (to === 'RESOLVED' || to === 'CLOSED') && !d.resolution_notes ? setEdit({ id: d.id, to, root_cause: d.root_cause ?? '', resolution_notes: '', assigned_to: d.assigned_to ?? '' }) : void update(d.id, { status: to })}>{l}</button>
                  ))}
                  {may && <button type="button" className="px-2 py-1 text-[11px] rounded hover:bg-surface-container" onClick={() => setEdit({ id: d.id, to: d.status, root_cause: d.root_cause ?? '', resolution_notes: d.resolution_notes ?? '', assigned_to: d.assigned_to ?? '' })}>Edit</button>}
                </div>
              </div>
              {edit?.id === d.id && (
                <div className="flex flex-wrap items-end gap-sm border-t border-outline-variant/40 pt-2">
                  <label className={`${label} flex-1 min-w-[160px]`}>Root cause<input className={input} value={edit.root_cause} onChange={(e) => setEdit({ ...edit, root_cause: e.target.value })} aria-label="Root cause" /></label>
                  <label className={`${label} flex-1 min-w-[200px]`}>How it was fixed{edit.to === 'RESOLVED' || edit.to === 'CLOSED' ? ' (needed)' : ''}<input className={input} value={edit.resolution_notes} onChange={(e) => setEdit({ ...edit, resolution_notes: e.target.value })} aria-label="Resolution" /></label>
                  <label className={label}>Assigned to<input className={input} value={edit.assigned_to} onChange={(e) => setEdit({ ...edit, assigned_to: e.target.value })} aria-label="Assigned to" /></label>
                  <SecondaryButton type="button" onClick={() => setEdit(null)}>Cancel</SecondaryButton>
                  <PrimaryButton type="button" onClick={() => void update(d.id, { status: edit.to, root_cause: edit.root_cause, resolution_notes: edit.resolution_notes, assigned_to: edit.assigned_to })}>{edit.to !== d.status ? `Save and ${words(edit.to) === 'closed' ? 'close' : 'resolve'}` : 'Save'}</PrimaryButton>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NCRs

const NEXT_NCR: Record<string, Array<[string, string]>> = {
  OPEN: [['ASSIGNED', 'Assign'], ['RESOLVED', 'Resolve']], ASSIGNED: [['IN_PROGRESS', 'Start work'], ['RESOLVED', 'Resolve']], IN_PROGRESS: [['RESOLVED', 'Resolve']],
  RESOLVED: [['CLOSED', 'Close (verified)'], ['IN_PROGRESS', 'Reopen']], CLOSED: [],
};

function Ncrs({ triggerToast, items, suppliers, onChanged, prefill }: { triggerToast: Toast; items: Item[]; suppliers: Supplier[]; onChanged: () => void; prefill: Prefill | null }) {
  const may = canChange('/api/ncr');
  const [show, setShow] = useState<'open' | 'all'>('open');
  const [list, setList] = useState<any[] | null>(null);
  const blank = { component_id: '', supplier_id: '', severity: 'MAJOR', issue_description: '', immediate_action: '', discovered_date: today(), assigned_to: '', due_date: '' };
  const [form, setForm] = useState<any | null>(prefill ? { ...blank, component_id: prefill.component_id, issue_description: prefill.description, qa_inspection_id: prefill.qa_inspection_id } : null);
  const [edit, setEdit] = useState<any | null>(null);
  const load = useCallback(async () => { try { setList(await api('/api/ncr')); } catch (e: any) { triggerToast(e.message, 'ERROR'); } }, [triggerToast]);
  useEffect(() => { void load(); }, [load]);
  const shown = (list ?? []).filter((n) => show === 'all' || !['RESOLVED', 'CLOSED'].includes(n.status));
  const add = async () => {
    try { const r = await api('/api/ncr', { method: 'POST', body: JSON.stringify(form) }); setForm(null); triggerToast(`${r.ncr_number} raised.`, 'SUCCESS'); await load(); onChanged(); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const update = async (id: number, body: any) => {
    try { await api(`/api/ncr/${id}`, { method: 'PUT', body: JSON.stringify(body) }); setEdit(null); await load(); onChanged(); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const step = (n: any, to: string) => {
    const needs = (to === 'ASSIGNED' && !n.assigned_to) || ((to === 'RESOLVED' || to === 'CLOSED') && !n.resolution_notes);
    if (needs) setEdit({ id: n.id, to, assigned_to: n.assigned_to ?? '', due_date: n.due_day ?? '', resolution_notes: n.resolution_notes ?? '', immediate_action: n.immediate_action ?? '' });
    else void update(n.id, { status: to });
  };
  return (
    <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-md">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <Choice value={show} set={setShow} options={[['open', 'Open'], ['all', 'All']]} aria="Show NCRs" />
        {may && !form && <PrimaryButton type="button" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setForm(blank)}>Raise NCR</PrimaryButton>}
      </div>
      {form && (
        <div className="bg-surface-container-high rounded-lg p-md grid grid-cols-1 md:grid-cols-3 gap-sm" data-testid="ncr-form">
          <label className={label}>Item<ItemField value={form.component_id} onChange={(v) => setForm({ ...form, component_id: v })} items={items} aria="Item not conforming" /></label>
          <label className={label}>Supplier (optional)<select className={input} value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })} aria-label="NCR supplier">
            <option value="">None / our own</option>{suppliers.map((s: any) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}</select></label>
          <label className={label}>How serious<select className={input} value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })} aria-label="NCR severity">
            <option value="CRITICAL">Critical</option><option value="MAJOR">Major</option><option value="MINOR">Minor</option></select></label>
          <label className={`${label} md:col-span-2`}>What doesn't conform<input className={input} value={form.issue_description} onChange={(e) => setForm({ ...form, issue_description: e.target.value })} aria-label="Issue" /></label>
          <label className={label}>Found on<input type="date" className={input} value={form.discovered_date} onChange={(e) => setForm({ ...form, discovered_date: e.target.value })} aria-label="Found on" /></label>
          <label className={`${label} md:col-span-3`}>Immediate action taken (optional)<input className={input} value={form.immediate_action} onChange={(e) => setForm({ ...form, immediate_action: e.target.value })} placeholder="e.g. stock quarantined, supplier told" aria-label="Immediate action" /></label>
          <label className={label}>Assigned to (optional)<input className={input} value={form.assigned_to} onChange={(e) => setForm({ ...form, assigned_to: e.target.value })} aria-label="NCR assigned to" /></label>
          <label className={label}>Review by (optional)<input type="date" className={input} value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} aria-label="Review by" /></label>
          <div className="flex gap-sm justify-end items-end"><SecondaryButton type="button" onClick={() => setForm(null)}>Cancel</SecondaryButton><PrimaryButton type="button" disabled={!form.component_id.trim() || !form.issue_description.trim()} onClick={() => void add()}>Raise it</PrimaryButton></div>
        </div>
      )}
      {!list ? <Loader2 className="w-4 h-4 animate-spin text-outline" /> : shown.length === 0 ? <p className="text-center py-8 text-outline text-xs">{show === 'open' ? 'No open NCRs.' : 'No NCRs yet.'}</p> : (
        <div className="space-y-2">
          {shown.map((n) => (
            <div key={n.id} className={`bg-surface-container-high border rounded p-3 space-y-2 ${n.overdue ? 'border-error/60' : 'border-outline-variant'}`} data-ncr={n.ncr_number}>
              <div className="flex flex-wrap items-start justify-between gap-sm">
                <div className="flex-1 min-w-[240px]">
                  <p className="text-sm text-on-surface"><strong className="font-mono">{n.ncr_number}</strong> · <span className="font-mono">{n.component_id}</span> <span className="text-xs text-on-surface-variant">{n.item_name}</span>{n.supplier_name ? <span className="text-xs text-on-surface-variant"> · {n.supplier_name}</span> : null}</p>
                  <p className="text-xs text-on-surface-variant">{n.issue_description}</p>
                  <p className="text-[11px] text-outline">Found {day(n.discovered_day ?? n.reported_date)} by {n.reported_by}{n.assigned_to ? ` · ${n.assigned_to}` : ''}{n.due_day ? ` · review by ${day(n.due_day)}` : ''}{n.overdue ? ' (overdue)' : ''}</p>
                  {n.immediate_action && <p className="text-[11px] text-outline">Done straight away: {n.immediate_action}</p>}
                  {n.resolution_notes && <p className="text-[11px] text-outline">Resolution: {n.resolution_notes}{n.resolved_date ? ` (${day(n.resolved_date)})` : ''}</p>}
                </div>
                <div className="flex items-center gap-1 flex-wrap"><Pill s={n.severity} /><Pill s={n.status} />
                  {may && (NEXT_NCR[n.status] ?? []).map(([to, l]) => <button key={to} type="button" className="px-2 py-1 text-[11px] font-bold text-primary rounded hover:bg-surface-container" onClick={() => step(n, to)}>{l}</button>)}
                  {may && n.status !== 'CLOSED' && <button type="button" className="px-2 py-1 text-[11px] rounded hover:bg-surface-container" onClick={() => setEdit({ id: n.id, to: n.status, assigned_to: n.assigned_to ?? '', due_date: n.due_day ?? '', resolution_notes: n.resolution_notes ?? '', immediate_action: n.immediate_action ?? '' })}>Edit</button>}
                </div>
              </div>
              {edit?.id === n.id && (
                <div className="grid grid-cols-1 md:grid-cols-4 gap-sm items-end border-t border-outline-variant/40 pt-2">
                  <label className={label}>Assigned to{edit.to === 'ASSIGNED' ? ' (needed)' : ''}<input className={input} value={edit.assigned_to} onChange={(e) => setEdit({ ...edit, assigned_to: e.target.value })} aria-label="NCR assignee" /></label>
                  <label className={label}>Review by<input type="date" className={input} value={edit.due_date} onChange={(e) => setEdit({ ...edit, due_date: e.target.value })} aria-label="NCR review by" /></label>
                  <label className={`${label} md:col-span-2`}>Resolution{edit.to === 'RESOLVED' || edit.to === 'CLOSED' ? ' (needed)' : ''}<input className={input} value={edit.resolution_notes} onChange={(e) => setEdit({ ...edit, resolution_notes: e.target.value })} aria-label="NCR resolution" placeholder="Corrective action taken, and how it was verified" /></label>
                  <div className="md:col-span-4 flex gap-sm justify-end">
                    <SecondaryButton type="button" onClick={() => setEdit(null)}>Cancel</SecondaryButton>
                    <PrimaryButton type="button" onClick={() => void update(n.id, { status: edit.to, assigned_to: edit.assigned_to, due_date: edit.due_date, resolution_notes: edit.resolution_notes })}>{edit.to !== n.status ? `Save and ${(NEXT_NCR[n.status] ?? []).find(([t]) => t === edit.to)?.[1].toLowerCase() ?? 'save'}` : 'Save'}</PrimaryButton>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compliance

function Compliance({ triggerToast, onChanged }: { triggerToast: Toast; onChanged: () => void }) {
  const may = canChange('/api/compliance-checkpoints');
  const [list, setList] = useState<any[] | null>(null);
  const [form, setForm] = useState<any | null>(null);
  const [check, setCheck] = useState<any | null>(null);
  const [history, setHistory] = useState<{ id: number; rows: any[] } | null>(null);
  const load = useCallback(async () => { try { setList(await api('/api/compliance-checkpoints')); } catch (e: any) { triggerToast(e.message, 'ERROR'); } }, [triggerToast]);
  useEffect(() => { void load(); }, [load]);
  const standards = useMemo(() => [...new Set((list ?? []).map((c) => c.compliance_standard))], [list]);
  const save = async () => {
    const body = { ...form, required_documentation: String(form.docs ?? '').split(/[\n,]/).map((d: string) => d.trim()).filter(Boolean) };
    try { await api(form.id ? `/api/compliance-checkpoints/${form.id}` : '/api/compliance-checkpoints', { method: form.id ? 'PUT' : 'POST', body: JSON.stringify(body) }); setForm(null); await load(); onChanged(); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const record = async () => {
    try { await api('/api/compliance-records', { method: 'POST', body: JSON.stringify(check) }); setCheck(null); triggerToast('Check recorded.', 'SUCCESS'); await load(); onChanged(); if (history?.id === check.compliance_checkpoint_id) setHistory(null); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const toggle = async (c: any) => { try { await api(`/api/compliance-checkpoints/${c.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !c.is_active }) }); await load(); onChanged(); } catch (e: any) { triggerToast(e.message, 'ERROR'); } };
  const showHistory = async (c: any) => {
    if (history?.id === c.id) { setHistory(null); return; }
    try { setHistory({ id: c.id, rows: await api(`/api/compliance-records?checkpoint=${c.id}`) }); } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  return (
    <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-md">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <p className="text-xs text-on-surface-variant max-w-[640px]">The checks your standard asks for (ISO 9001, IPC-A-610, RoHS, …): what is checked, at which stage, and the documents it needs. Record each time it is checked; the last check is its status.</p>
        {may && !form && <PrimaryButton type="button" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setForm({ checkpoint_name: '', compliance_standard: standards[0] ?? 'ISO 9001', stage: 'Receiving', docs: '' })}>New checkpoint</PrimaryButton>}
      </div>
      {form && (
        <div className="bg-surface-container-high rounded-lg p-md grid grid-cols-1 md:grid-cols-3 gap-sm" data-testid="checkpoint-form">
          <label className={label}>Checkpoint<input className={input} value={form.checkpoint_name} onChange={(e) => setForm({ ...form, checkpoint_name: e.target.value })} placeholder="e.g. Incoming goods inspected" aria-label="Checkpoint name" /></label>
          <label className={label}>Standard<input className={input} list="compliance-standards" value={form.compliance_standard} onChange={(e) => setForm({ ...form, compliance_standard: e.target.value })} aria-label="Standard" />
            <datalist id="compliance-standards">{[...new Set([...standards, 'ISO 9001', 'IPC-A-610', 'RoHS', 'REACH', 'AS9100'])].map((s) => <option key={s} value={s} />)}</datalist></label>
          <label className={label}>Stage<select className={input} value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })} aria-label="Stage">
            {['Receiving', 'Production', 'Final inspection', 'Dispatch', 'Supplier', 'Company-wide'].map((s) => <option key={s}>{s}</option>)}</select></label>
          <label className={`${label} md:col-span-2`}>Documents it needs (comma between them)<input className={input} value={form.docs} onChange={(e) => setForm({ ...form, docs: e.target.value })} placeholder="e.g. Certificate of conformity, inspection record" aria-label="Documents" /></label>
          <div className="flex gap-sm justify-end items-end"><SecondaryButton type="button" onClick={() => setForm(null)}>Cancel</SecondaryButton><PrimaryButton type="button" disabled={!form.checkpoint_name.trim() || !form.compliance_standard.trim()} onClick={() => void save()}>Save</PrimaryButton></div>
        </div>
      )}
      {!list ? <Loader2 className="w-4 h-4 animate-spin text-outline" /> : list.length === 0 ? <p className="text-center py-8 text-outline text-xs">No checkpoints yet.</p> : (
        <div className="space-y-2">
          {list.map((c) => (
            <div key={c.id} className={`bg-surface-container-high border border-outline-variant rounded p-3 space-y-2 ${c.is_active ? '' : 'opacity-60'}`} data-checkpoint={c.checkpoint_name}>
              <div className="flex flex-wrap items-start justify-between gap-sm">
                <div className="flex-1 min-w-[240px]">
                  <p className="text-sm font-bold text-on-surface">{c.checkpoint_name} <span className="text-xs font-normal text-on-surface-variant">· {c.compliance_standard} · {c.stage}</span></p>
                  {(c.required_documentation ?? []).length > 0 && <p className="text-[11px] text-outline">Needs: {(c.required_documentation as string[]).join(', ')}</p>}
                  <p className="text-[11px] text-outline">{c.last_at ? `Last checked ${day(c.last_at)} by ${c.last_by}${c.last_reference ? ` (${c.last_reference})` : ''}; ${c.checks} check${c.checks === 1 ? '' : 's'} in all.` : 'Never checked.'}</p>
                </div>
                <div className="flex items-center gap-1"><Pill s={c.last_status} />
                  {may && c.is_active && <button type="button" className="px-2 py-1 text-[11px] font-bold text-primary rounded hover:bg-surface-container" onClick={() => setCheck({ compliance_checkpoint_id: c.id, status: 'COMPLIANT', reference: '', notes: '' })}>Record a check</button>}
                  {c.checks > 0 && <button type="button" className="px-2 py-1 text-[11px] rounded hover:bg-surface-container" onClick={() => void showHistory(c)}>History</button>}
                  {may && <button type="button" className="px-2 py-1 text-[11px] rounded hover:bg-surface-container" onClick={() => setForm({ id: c.id, checkpoint_name: c.checkpoint_name, compliance_standard: c.compliance_standard, stage: c.stage, docs: (c.required_documentation ?? []).join(', ') })}>Edit</button>}
                  {may && <button type="button" className="px-2 py-1 text-[11px] rounded hover:bg-surface-container" onClick={() => void toggle(c)}>{c.is_active ? 'Retire' : 'Bring back'}</button>}
                </div>
              </div>
              {check?.compliance_checkpoint_id === c.id && (
                <div className="flex flex-wrap items-end gap-sm border-t border-outline-variant/40 pt-2">
                  <Choice value={check.status} set={(v) => setCheck({ ...check, status: v })} options={[['COMPLIANT', 'Compliant'], ['NON_COMPLIANT', 'Not compliant'], ['WAIVED', 'Waived']]} aria="Check result" />
                  <label className={label}>For (batch, PO, job…)<input className={input} value={check.reference} onChange={(e) => setCheck({ ...check, reference: e.target.value })} aria-label="Check reference" /></label>
                  <label className={`${label} flex-1 min-w-[200px]`}>Notes{check.status !== 'COMPLIANT' ? ' (needed)' : ''}<input className={input} value={check.notes} onChange={(e) => setCheck({ ...check, notes: e.target.value })} aria-label="Check notes" /></label>
                  <SecondaryButton type="button" onClick={() => setCheck(null)}>Cancel</SecondaryButton><PrimaryButton type="button" onClick={() => void record()}>Record</PrimaryButton>
                </div>
              )}
              {history?.id === c.id && (
                <table className="w-full text-[11px] border-t border-outline-variant/40"><tbody>{(history?.rows ?? []).map((r) => (
                  <tr key={r.id}><td className="py-1 pr-2 whitespace-nowrap text-outline">{day(r.verified_date ?? r.created_at)}</td><td className="pr-2"><Pill s={r.status} /></td><td className="pr-2">{r.reference ?? r.batch_id ?? ''}</td><td className="pr-2 text-on-surface-variant">{r.notes}</td><td className="text-outline">{r.verified_by}</td></tr>
                ))}</tbody></table>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
