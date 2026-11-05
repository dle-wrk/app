// Projects > Project Processing: one build of a project, start to finish.
// 1 book the kit out, 2 label and book in what's built (each unit its own
// serial, the build a batch code), 3 count what's left of each part sent and
// put it back (to the part, or to a packet item), 4 complete.
// Server: src/lib/projectBuilds.ts (and Kit Booking's book-out, with buildId).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus, PackageMinus, PackagePlus, ClipboardCheck, CheckCircle2, Printer, ScanLine, ArrowLeft, AlertTriangle } from 'lucide-react';
import { canChange } from '../../lib/changeAccess';
import { confirmDialog } from '../../lib/confirmDialog';
import { fmtNumber } from '../../lib/formatMoney';
import { printLabels } from '../../lib/stockLabels';
import { PrimaryButton, SecondaryButton } from '../bookkeeping/shared';

type Toast = (msg: string, type?: string) => void;
const input = 'bg-surface-container-high border border-outline-variant rounded px-2 py-1.5 text-xs text-on-surface';
const label = 'text-[11px] font-bold text-on-surface-variant';
const when = (d: string | null) => (d ? new Date(d).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const STATUS: Record<string, [string, string]> = {
  PLANNED: ['Planned', 'bg-blue-500/10 text-blue-400'], BOOKED_OUT: ['Kit booked out', 'bg-yellow-500/10 text-yellow-400'], BUILDING: ['Building', 'bg-orange-500/10 text-orange-400'],
  COMPLETE: ['Complete', 'bg-green-500/10 text-green-400'], CANCELLED: ['Cancelled', 'bg-gray-500/10 text-outline'],
};
const Status = ({ s }: { s: string }) => <span className={`px-2 py-0.5 rounded text-[10px] font-bold whitespace-nowrap ${STATUS[s]?.[1] ?? ''}`}>{STATUS[s]?.[0] ?? s}</span>;

async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init && init.body ? { ...init, headers: { 'Content-Type': 'application/json' } } : init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

/** The next serial a format gives (a preview: {MODEL}, {YYYY}, {0000}). */
export function previewCode(format: string, model: string, n = 1) {
  return String(format).replace(/\{MODEL\}/gi, model).replace(/\{YYYY\}/gi, String(new Date().getFullYear())).replace(/\{(0+)\}/, (_, z: string) => String(n).padStart(z.length, '0'));
}

export default function ProjectProcessingView({ triggerToast, onOpenItem }: { triggerToast: Toast; onOpenItem?: (s: string) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  return open === null
    ? <BuildList triggerToast={triggerToast} onOpen={setOpen} />
    : <BuildSheet id={open} triggerToast={triggerToast} onOpenItem={onOpenItem} onBack={() => setOpen(null)} />;
}

// ---------------------------------------------------------------------------

function BuildList({ triggerToast, onOpen }: { triggerToast: Toast; onOpen: (id: number) => void }) {
  const may = canChange('/api/builds');
  const [list, setList] = useState<any[] | null>(null);
  const [opts, setOpts] = useState<any>(null);
  const [form, setForm] = useState<{ projectId: string; modelNumber: string; qty: string; notes: string } | null>(null);
  const [showDone, setShowDone] = useState(false);
  const load = useCallback(async () => { try { setList(await api('/api/builds')); } catch (e: any) { triggerToast(e.message, 'ERROR'); } }, [triggerToast]);
  useEffect(() => { void load(); }, [load]);
  const startNew = async () => {
    try {
      const o = opts ?? await api('/api/builds/options'); setOpts(o);
      setForm({ projectId: '', modelNumber: '', qty: '1', notes: '' });
    } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  // A project's product: the one it is a board of, else the one its last build made.
  const productFor = (projectId: string) => opts?.boards.find((b: any) => b.project_id === projectId)?.model_number
    ?? (list ?? []).find((b) => b.project_id === projectId)?.model_number ?? '';
  const create = async () => {
    if (!form) return;
    try { const b = await api('/api/builds', { method: 'POST', body: JSON.stringify(form) }); triggerToast(`${b.number} started.`, 'SUCCESS'); setForm(null); onOpen(b.id); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const shown = (list ?? []).filter((b) => showDone || !['COMPLETE', 'CANCELLED'].includes(b.status));
  return (
    <div className="p-container-margin space-y-md max-w-7xl mx-auto w-full">
      <div className="flex flex-wrap items-end justify-between gap-md">
        <div>
          <h3 className="font-headline-sm text-lg text-on-surface">Project processing</h3>
          <p className="text-on-surface-variant text-xs max-w-[760px]">A build from start to finish: book the kit out, label and book in what's built, count what's left of each part and put it back (loose parts off a reel into a packet), then complete it.</p>
        </div>
        {may && !form && <PrimaryButton type="button" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => void startNew()}>New build</PrimaryButton>}
      </div>
      {form && opts && (
        <div className="bg-surface-container border border-primary/40 rounded-xl p-md grid grid-cols-1 md:grid-cols-4 gap-sm items-end" data-testid="build-form">
          <label className={label}>Project<select className={`${input} w-full mt-1`} value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value, modelNumber: form.modelNumber || productFor(e.target.value) })} aria-label="Project">
            <option value="">Choose…</option>{opts.projects.map((p: any) => <option key={p.id} value={String(p.id)}>{p.project_name}{String(p.status ?? '').toLowerCase() === 'inactive' ? ' (inactive)' : ''}</option>)}</select></label>
          <label className={label}>Builds (Production Costs)<input className={`${input} w-full mt-1 font-mono`} list="build-products" value={form.modelNumber} onChange={(e) => setForm({ ...form, modelNumber: e.target.value })} placeholder="Model number" aria-label="Product" />
            <datalist id="build-products">{opts.products.map((p: any) => <option key={p.model_number} value={p.model_number}>{p.description}</option>)}</datalist></label>
          <label className={label}>How many<input className={`${input} w-full mt-1 font-mono`} inputMode="numeric" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value.replace(/[^0-9]/g, '') })} aria-label="Quantity" /></label>
          <div className="flex gap-sm justify-end"><SecondaryButton type="button" onClick={() => setForm(null)}>Cancel</SecondaryButton>
            <PrimaryButton type="button" disabled={!form.projectId || !form.modelNumber.trim() || !Number(form.qty)} onClick={() => void create()}>Start build</PrimaryButton></div>
          <label className={`${label} md:col-span-4`}>Notes (optional)<input className={`${input} w-full mt-1`} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} aria-label="Build notes" /></label>
        </div>
      )}
      <label className="flex items-center gap-2 text-xs text-on-surface-variant"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show completed and cancelled</label>
      {!list ? <Loader2 className="w-4 h-4 animate-spin text-outline" /> : shown.length === 0 ? <p className="text-xs text-on-surface-variant italic">No builds{showDone ? '' : ' in progress'}.</p> : (
        <div className="rounded-xl border border-outline-variant overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead><tr className="text-[10px] text-outline uppercase bg-surface-container-high/30"><th className="px-md py-2">Build</th><th className="px-md py-2">Project</th><th className="px-md py-2">Builds</th><th className="px-md py-2 text-right">Planned</th><th className="px-md py-2 text-right">Built</th><th className="px-md py-2">Batch</th><th className="px-md py-2">Status</th></tr></thead>
            <tbody className="divide-y divide-outline-variant/30">
              {shown.map((b) => (
                <tr key={b.id} data-build={b.number}>
                  <td className="px-md py-2"><button type="button" className="font-mono font-bold text-primary hover:underline" onClick={() => onOpen(b.id)}>{b.number}</button><span className="block text-[10px] text-outline">{when(b.created_at)}</span></td>
                  <td className="px-md py-2">{b.project_name}</td>
                  <td className="px-md py-2"><span className="font-mono">{b.model_number}</span><span className="block text-[10px] text-outline">{b.product_description}</span></td>
                  <td className="px-md py-2 text-right font-mono">{fmtNumber(b.qty_planned)}</td>
                  <td className="px-md py-2 text-right font-mono">{fmtNumber(b.qty_built)}</td>
                  <td className="px-md py-2 font-mono">{b.batch_code}</td>
                  <td className="px-md py-2"><Status s={b.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Step({ n, title, icon, done, children }: { n: number; title: string; icon: React.ReactNode; done?: boolean; children: React.ReactNode }) {
  return (
    <div className={`bg-surface-container border rounded-xl p-md space-y-sm ${done ? 'border-green-500/30' : 'border-outline-variant'}`} data-step={n}>
      <p className="text-sm font-bold text-on-surface flex items-center gap-2">{icon}<span>{n}. {title}</span>{done && <CheckCircle2 className="w-4 h-4 text-green-500" />}</p>
      {children}
    </div>
  );
}

function BuildSheet({ id, triggerToast, onOpenItem, onBack }: { id: number; triggerToast: Toast; onOpenItem?: (s: string) => void; onBack: () => void }) {
  const may = canChange('/api/builds');
  const [d, setD] = useState<any>(null);
  const load = useCallback(async () => { try { setD(await api(`/api/builds/${id}`)); } catch (e: any) { triggerToast(e.message, 'ERROR'); } }, [id, triggerToast]);
  useEffect(() => { void load(); }, [load]);
  if (!d) return <div className="p-container-margin"><Loader2 className="w-4 h-4 animate-spin text-outline" /></div>;
  const b = d.build;
  const closed = b.status === 'COMPLETE' || b.status === 'CANCELLED';
  const cancel = async () => {
    if (!(await confirmDialog({ title: `Cancel ${b.number}`, message: 'Nothing has been booked out for it.', confirmLabel: 'Cancel build', destructive: true }))) return;
    try { await api(`/api/builds/${id}/cancel`, { method: 'POST', body: '{}' }); await load(); } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  return (
    <div className="p-container-margin space-y-md max-w-7xl mx-auto w-full" data-testid="build-sheet">
      <div className="flex flex-wrap items-start justify-between gap-md">
        <div>
          <button type="button" onClick={onBack} className="text-xs text-primary inline-flex items-center gap-1 hover:underline"><ArrowLeft className="w-3.5 h-3.5" /> All builds</button>
          <h3 className="font-headline-sm text-lg text-on-surface mt-1">{b.number} <span className="text-on-surface-variant text-sm font-normal">· {b.project_name} → {b.model_number} × {fmtNumber(b.qty_planned)}</span></h3>
          <p className="text-[11px] text-outline">Batch <span className="font-mono">{b.batch_code}</span> · started {when(b.created_at)}{b.created_by ? ` by ${b.created_by}` : ''}{b.notes ? ` · ${b.notes}` : ''}</p>
        </div>
        <div className="flex items-center gap-sm"><Status s={b.status} />{may && b.status === 'PLANNED' && <SecondaryButton type="button" onClick={() => void cancel()}>Cancel build</SecondaryButton>}</div>
      </div>
      <BookOut d={d} may={may && b.status === 'PLANNED'} triggerToast={triggerToast} onDone={load} />
      <BookIn d={d} may={may && !closed && b.status !== 'PLANNED'} triggerToast={triggerToast} onDone={load} />
      <CountBack d={d} may={may && !closed && b.status !== 'PLANNED'} triggerToast={triggerToast} onOpenItem={onOpenItem} onDone={load} />
      <Complete d={d} may={may && !closed && b.status !== 'PLANNED'} triggerToast={triggerToast} onDone={load} />
    </div>
  );
}

function BookOut({ d, may, triggerToast, onDone }: { d: any; may: boolean; triggerToast: Toast; onDone: () => void }) {
  const b = d.build;
  const [lines, setLines] = useState<any[] | null>(null);
  const [leaveOut, setLeaveOut] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try { const l = await api('/api/kit-booking/validate', { method: 'POST', body: JSON.stringify({ projectId: b.project_id, buildQty: b.qty_planned }) }); setLines(l); setLeaveOut(new Set()); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); } finally { setBusy(false); }
  };
  const short = (lines ?? []).filter((l) => Number(l.shortage_qty ?? 0) > 0 && !leaveOut.has(l.component_id));
  const bookOut = async () => {
    setBusy(true);
    try {
      const r = await api('/api/kit-booking/execute', { method: 'POST', body: JSON.stringify({ projectId: b.project_id, buildQty: b.qty_planned, buildId: b.id, dnf: [...leaveOut] }) });
      triggerToast(`Kit booked out: ${fmtNumber(r.deductions.length)} lines${r.skipped.length ? `, ${fmtNumber(r.skipped.length)} left out` : ''}.`, 'SUCCESS');
      onDone();
    } catch (e: any) { triggerToast(e.message, 'ERROR'); } finally { setBusy(false); }
  };
  const total = d.issues.reduce((s: number, i: any) => s + i.booked_out, 0);
  return (
    <Step n={1} title="Book the kit out" icon={<PackageMinus className="w-4 h-4 text-primary" />} done={b.status !== 'PLANNED'}>
      {b.status !== 'PLANNED' ? (
        <p className="text-xs text-on-surface-variant">{b.booked_out_at ? `Booked out ${when(b.booked_out_at)}: ` : ''}{fmtNumber(d.issues.length)} parts, {fmtNumber(total)} pieces. They're listed under step 3.</p>
      ) : !may ? <p className="text-xs text-outline">Not booked out yet.</p> : !lines ? (
        <div className="flex flex-wrap items-center gap-sm"><SecondaryButton type="button" disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : 'Check the kit'}</SecondaryButton>
          <span className="text-[11px] text-outline">The project's BOM for {fmtNumber(b.qty_planned)}, against stock. To pick other reels for a line, use P&amp;P Kit Booking.</span></div>
      ) : (
        <div className="space-y-sm">
          <div className="max-h-[320px] overflow-y-auto custom-scrollbar rounded-lg border border-outline-variant">
            <table className="w-full text-[11px]"><thead className="sticky top-0 bg-surface-container-high"><tr className="text-[10px] text-outline uppercase"><th className="px-2 py-1 text-left">Line</th><th className="px-2 py-1 text-left">Takes</th><th className="px-2 py-1 text-right">Needs</th><th className="px-2 py-1 text-right">Short</th><th className="px-2 py-1">Leave out</th></tr></thead>
              <tbody className="divide-y divide-outline-variant/30">{lines.map((l) => {
                const s = Number(l.shortage_qty ?? 0);
                return (
                  <tr key={l.component_id} className={s > 0 && !leaveOut.has(l.component_id) ? 'bg-error/5' : ''} data-kit-line={l.component_id}>
                    <td className="px-2 py-1 font-mono">{l.component_id}</td><td className="px-2 py-1 font-mono text-on-surface-variant">{l.resolved_part_number}</td>
                    <td className="px-2 py-1 text-right font-mono">{fmtNumber(l.qty_required)}</td><td className={`px-2 py-1 text-right font-mono ${s > 0 ? 'text-error font-bold' : 'text-outline'}`}>{s > 0 ? fmtNumber(s) : '—'}</td>
                    <td className="px-2 py-1 text-center"><input type="checkbox" checked={leaveOut.has(l.component_id)} onChange={() => setLeaveOut((x) => { const n = new Set(x); n.has(l.component_id) ? n.delete(l.component_id) : n.add(l.component_id); return n; })} aria-label={`Leave out ${l.component_id}`} /></td>
                  </tr>
                );
              })}</tbody></table>
          </div>
          {short.length > 0 && <p className="text-[11px] text-error flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> {fmtNumber(short.length)} line{short.length === 1 ? ' is' : 's are'} short. Leave {short.length === 1 ? 'it' : 'them'} out, or book in the stock first.</p>}
          <div className="flex gap-sm justify-end"><SecondaryButton type="button" onClick={() => setLines(null)}>Close</SecondaryButton>
            <PrimaryButton type="button" disabled={busy || short.length > 0} onClick={() => void bookOut()}>{busy ? 'Booking out…' : `Book out for ${fmtNumber(b.qty_planned)}`}</PrimaryButton></div>
        </div>
      )}
    </Step>
  );
}

function BookIn({ d, may, triggerToast, onDone }: { d: any; may: boolean; triggerToast: Toast; onDone: () => void }) {
  const b = d.build; const p = d.product;
  const [formats, setFormats] = useState<{ unit: string; batch: string } | null>(null);
  const [labels, setLabels] = useState(String(Math.max(1, b.qty_planned - b.qty_built)));
  const [count, setCount] = useState('');
  const [scan, setScan] = useState('');
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const units: any[] = d.units;
  const waiting = units.filter((u) => u.status === 'LABELLED');
  const inStock = units.filter((u) => u.status === 'IN_STOCK');
  const saveFormats = async () => {
    try { await api('/api/builds/product-format', { method: 'PUT', body: JSON.stringify({ modelNumber: b.model_number, unitFormat: formats!.unit, batchFormat: formats!.batch }) }); setFormats(null); onDone(); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const print = (serials: string[], batch: string) => {
    const title = p?.description ?? b.model_number;
    if (!printLabels([{ kind: 'batch', code: batch, title: `${b.number} · ${title}` }, ...serials.map((s) => ({ kind: 'unit' as const, code: s, title }))])) triggerToast('The print window was blocked: allow pop-ups for this site.', 'ERROR');
  };
  const makeLabels = async () => {
    try { const r = await api(`/api/builds/${b.id}/labels`, { method: 'POST', body: JSON.stringify({ count: Number(labels) }) }); print(r.serials, r.batch); onDone(); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const bookIn = async (body: any) => {
    try {
      const r = await api(`/api/builds/${b.id}/book-in`, { method: 'POST', body: JSON.stringify(body) });
      setNote({ text: `Booked in ${r.serials.length === 1 ? r.serials[0] : `${fmtNumber(r.serials.length)} units`} as ${r.code}.` }); setCount(''); onDone();
    } catch (e: any) { setNote({ text: e.message, bad: true }); } finally { setTimeout(() => scanRef.current?.focus(), 0); }
  };
  return (
    <Step n={2} title="Label and book in what's built" icon={<PackagePlus className="w-4 h-4 text-primary" />} done={b.qty_built >= b.qty_planned}>
      <p className="text-xs text-on-surface-variant">
        {fmtNumber(b.qty_built)} of {fmtNumber(b.qty_planned)} booked in as <span className="font-mono">{b.model_number}</span>{waiting.length ? `; ${fmtNumber(waiting.length)} labelled, not booked in yet` : ''}.
        {p ? <> Serials <span className="font-mono">{previewCode(p.unit_format, b.model_number)}</span>, batch <span className="font-mono">{b.batch_code}</span>.</> : null}
        {may && p && !formats && <> <button type="button" className="text-primary hover:underline" onClick={() => setFormats({ unit: p.unit_format, batch: p.batch_format })}>Change the formats</button></>}
      </p>
      {formats && (
        <div className="flex flex-wrap items-end gap-sm rounded-lg bg-surface-container-high p-sm">
          <label className={label}>Unit serial<input className={`${input} block mt-0.5 font-mono w-56`} value={formats.unit} onChange={(e) => setFormats({ ...formats, unit: e.target.value })} aria-label="Unit serial format" /></label>
          <label className={label}>Batch<input className={`${input} block mt-0.5 font-mono w-48`} value={formats.batch} onChange={(e) => setFormats({ ...formats, batch: e.target.value })} aria-label="Batch format" /></label>
          <span className="text-[11px] text-outline">e.g. <span className="font-mono">{previewCode(formats.unit, b.model_number)}</span>. {'{MODEL}'} the code, {'{0000}'} the running number, {'{YYYY}'} the year. For {b.model_number}, every build.</span>
          <SecondaryButton type="button" onClick={() => setFormats(null)}>Cancel</SecondaryButton><PrimaryButton type="button" onClick={() => void saveFormats()}>Save</PrimaryButton>
        </div>
      )}
      {may && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-sm">
          <div className="rounded-lg border border-outline-variant p-sm space-y-1">
            <p className="text-[11px] font-bold text-on-surface flex items-center gap-1"><Printer className="w-3.5 h-3.5" /> Labels</p>
            <div className="flex items-center gap-sm"><input className={`${input} w-20 font-mono text-right`} inputMode="numeric" value={labels} onChange={(e) => setLabels(e.target.value.replace(/[^0-9]/g, ''))} aria-label="Labels to print" />
              <SecondaryButton type="button" disabled={!Number(labels)} onClick={() => void makeLabels()}>Print unit labels</SecondaryButton></div>
            {waiting.length > 0 && <button type="button" className="text-[11px] text-primary hover:underline" onClick={() => print(waiting.map((u) => u.serial), b.batch_code)}>Print the {fmtNumber(waiting.length)} waiting again</button>}
            <p className="text-[10px] text-outline">With a batch label for the build. Stick one on each unit, scan it when it's done.</p>
          </div>
          <div className="rounded-lg border border-outline-variant p-sm space-y-1">
            <p className="text-[11px] font-bold text-on-surface flex items-center gap-1"><ScanLine className="w-3.5 h-3.5" /> Scan a finished unit</p>
            <input ref={scanRef} className={`${input} w-full font-mono py-2`} value={scan} onChange={(e) => setScan(e.target.value)} placeholder={previewCode(p?.unit_format ?? '', b.model_number)}
              onKeyDown={(e) => { if (e.key === 'Enter' && scan.trim()) { e.preventDefault(); const s = scan.trim(); setScan(''); void bookIn({ serials: [s] }); } }} aria-label="Scan a unit" />
            {note && <p className={`text-[11px] ${note.bad ? 'text-error' : 'text-on-surface'}`} role="status">{note.text}</p>}
          </div>
          <div className="rounded-lg border border-outline-variant p-sm space-y-1">
            <p className="text-[11px] font-bold text-on-surface">Or book in a number</p>
            <div className="flex items-center gap-sm"><input className={`${input} w-20 font-mono text-right`} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/[^0-9]/g, ''))} aria-label="Units to book in" />
              <SecondaryButton type="button" disabled={!Number(count)} onClick={() => void bookIn({ count: Number(count) })}>Book in</SecondaryButton></div>
            <p className="text-[10px] text-outline">Labelled units first, then new serials.</p>
          </div>
        </div>
      )}
      {units.length > 0 && (
        <details><summary className="cursor-pointer text-[11px] text-outline">Units ({fmtNumber(inStock.length)} in stock{waiting.length ? `, ${fmtNumber(waiting.length)} waiting` : ''})</summary>
          <div className="flex flex-wrap gap-1 mt-1">{units.map((u) => <span key={u.serial} className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${u.status === 'IN_STOCK' ? 'bg-green-500/10 text-green-500' : u.status === 'SCRAPPED' ? 'bg-error/10 text-error line-through' : 'bg-surface-container-high text-on-surface-variant'}`} title={u.booked_in_at ? `Booked in ${when(u.booked_in_at)} by ${u.booked_in_by}` : 'Labelled'}>{u.serial}</span>)}</div>
        </details>
      )}
    </Step>
  );
}

function CountBack({ d, may, triggerToast, onOpenItem, onDone }: { d: any; may: boolean; triggerToast: Toast; onOpenItem?: (s: string) => void; onDone: () => void }) {
  const b = d.build;
  const counted = useMemo(() => new Map<string, any[]>(d.returns.reduce((m: Map<string, any[]>, r: any) => m.set(r.serial_number, [...(m.get(r.serial_number) ?? []), r]), new Map())), [d.returns]);
  const [entry, setEntry] = useState<Record<string, { counted: string; toPacket: boolean; packetCode: string }>>({});
  const [busy, setBusy] = useState(false);
  const row = (code: string, i: any) => entry[code] ?? { counted: '', toPacket: false, packetCode: i.packet_code ?? `${code}-PKT` };
  const set = (code: string, i: any, p: Partial<{ counted: string; toPacket: boolean; packetCode: string }>) => setEntry((e) => ({ ...e, [code]: { ...row(code, i), ...p } }));
  const ready = d.issues.filter((i: any) => (entry[i.serial_number]?.counted ?? '') !== '');
  const save = async () => {
    const over = ready.filter((i: any) => Number(entry[i.serial_number].counted) + (counted.get(i.serial_number) ?? []).reduce((s, r) => s + r.counted, 0) > i.booked_out);
    if (over.length && !(await confirmDialog({ title: 'More than was sent', message: `${over.map((i: any) => i.serial_number).join(', ')}: the count is more than this build took. It will still all be put back into stock.`, confirmLabel: 'Put it back' }))) return;
    setBusy(true);
    try {
      await api(`/api/builds/${b.id}/returns`, { method: 'POST', body: JSON.stringify({ lines: ready.map((i: any) => { const e = entry[i.serial_number]; return { serialNumber: i.serial_number, counted: Number(e.counted), toPacket: e.toPacket, packetCode: e.toPacket ? e.packetCode : undefined }; }) }) });
      triggerToast(`${fmtNumber(ready.length)} part${ready.length === 1 ? '' : 's'} counted back into stock.`, 'SUCCESS'); setEntry({}); onDone();
    } catch (e: any) { triggerToast(e.message, 'ERROR'); } finally { setBusy(false); }
  };
  const allCounted = d.issues.length > 0 && d.issues.every((i: any) => counted.has(i.serial_number));
  return (
    <Step n={3} title="Count what's left and put it back" icon={<ClipboardCheck className="w-4 h-4 text-primary" />} done={allCounted}>
      {d.issues.length === 0 ? <p className="text-xs text-outline">Book the kit out first.</p> : (
        <>
          <p className="text-xs text-on-surface-variant">Count what came back of each part sent and enter it. It goes back to the part, or tick <strong>Packet</strong> for loose parts off a reel: they go to a packet item of their own (packaging X1 PACKET), made the first time and added to after. Leave a line empty if nothing came back yet.</p>
          <div className="rounded-lg border border-outline-variant overflow-x-auto max-h-[420px] overflow-y-auto custom-scrollbar">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-surface-container-high"><tr className="text-[10px] text-outline uppercase"><th className="px-2 py-1 text-left">Part</th><th className="px-2 py-1 text-right">Sent</th><th className="px-2 py-1 text-right">Back so far</th><th className="px-2 py-1 text-right">Counted now</th><th className="px-2 py-1 text-left">Packet</th></tr></thead>
              <tbody className="divide-y divide-outline-variant/30">
                {d.issues.map((i: any) => {
                  const r = row(i.serial_number, i);
                  const back = counted.get(i.serial_number) ?? [];
                  return (
                    <tr key={i.serial_number} data-return={i.serial_number}>
                      <td className="px-2 py-1">{onOpenItem ? <button type="button" className="font-mono font-bold text-primary hover:underline" onClick={() => onOpenItem(i.serial_number)}>{i.serial_number}</button> : <span className="font-mono font-bold">{i.serial_number}</span>}<span className="block text-[10px] text-outline">{i.name}{i.packaging ? ` · ${i.packaging}` : ''}</span></td>
                      <td className="px-2 py-1 text-right font-mono">{fmtNumber(i.booked_out)}</td>
                      <td className="px-2 py-1 text-right font-mono text-on-surface-variant" title={back.map((x) => `${x.counted} to ${x.to_code}`).join(', ')}>{back.length ? fmtNumber(back.reduce((s, x) => s + x.counted, 0)) : '—'}</td>
                      <td className="px-2 py-1 text-right">{may ? <input className={`${input} w-20 text-right font-mono py-1`} inputMode="numeric" value={r.counted} onChange={(e) => set(i.serial_number, i, { counted: e.target.value.replace(/[^0-9]/g, '') })} aria-label={`Counted back ${i.serial_number}`} /> : null}</td>
                      <td className="px-2 py-1">{may && (
                        <span className="flex items-center gap-1">
                          <input type="checkbox" checked={r.toPacket} onChange={(e) => set(i.serial_number, i, { toPacket: e.target.checked })} aria-label={`As a packet ${i.serial_number}`} />
                          {r.toPacket && <input className={`${input} w-32 font-mono py-1`} value={r.packetCode} onChange={(e) => set(i.serial_number, i, { packetCode: e.target.value })} aria-label={`Packet code ${i.serial_number}`} title={i.packet_code ? 'Its packet already exists: the count is added to it' : 'A new packet item, copied from the part'} />}
                          {r.toPacket && <span className="text-[10px] text-outline">{i.packet_code && r.packetCode.toUpperCase() === String(i.packet_code).toUpperCase() ? 'adds to it' : 'new'}</span>}
                        </span>
                      )}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {may && <div className="flex justify-end"><PrimaryButton type="button" disabled={busy || !ready.length} onClick={() => void save()}>{busy ? 'Putting back…' : `Put back ${fmtNumber(ready.length)} counted`}</PrimaryButton></div>}
        </>
      )}
    </Step>
  );
}

function Complete({ d, may, triggerToast, onDone }: { d: any; may: boolean; triggerToast: Toast; onDone: () => void }) {
  const b = d.build;
  const [scrapped, setScrapped] = useState('0');
  const [notes, setNotes] = useState('');
  const [scrapWaiting, setScrapWaiting] = useState(false);
  const waiting = d.units.filter((u: any) => u.status === 'LABELLED').length;
  const notCounted = d.issues.filter((i: any) => !d.returns.some((r: any) => r.serial_number === i.serial_number)).length;
  const used = d.usage.reduce((s: number, u: any) => s + u.used, 0);
  const complete = async () => {
    if (notCounted && !(await confirmDialog({ title: `Complete ${b.number}`, message: `${notCounted} part${notCounted === 1 ? ' has' : 's have'} not been counted back. Everything sent for ${notCounted === 1 ? 'it' : 'them'} is taken as used.`, confirmLabel: 'Complete' }))) return;
    try { await api(`/api/builds/${b.id}/complete`, { method: 'POST', body: JSON.stringify({ scrapped: Number(scrapped || 0), notes, scrapUnbooked: scrapWaiting }) }); triggerToast(`${b.number} complete.`, 'SUCCESS'); onDone(); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  return (
    <Step n={4} title="Complete the build" icon={<CheckCircle2 className="w-4 h-4 text-primary" />} done={b.status === 'COMPLETE'}>
      <p className="text-xs text-on-surface-variant" data-testid="build-summary">
        {fmtNumber(b.qty_built)} of {fmtNumber(b.qty_planned)} built and booked in{b.qty_scrapped ? `, ${fmtNumber(b.qty_scrapped)} scrapped` : ''}; {fmtNumber(used)} pieces of {fmtNumber(d.issues.length)} parts used{notCounted ? ` (${fmtNumber(notCounted)} not counted back)` : ''}.
        {b.status === 'COMPLETE' && <> Completed {when(b.completed_at)}{b.completed_by ? ` by ${b.completed_by}` : ''}{b.completion_notes ? `: ${b.completion_notes}` : '.'}</>}
      </p>
      {may && (
        <div className="flex flex-wrap items-end gap-sm">
          <label className={label}>Scrapped<input className={`${input} block mt-0.5 w-20 text-right font-mono`} inputMode="numeric" value={scrapped} onChange={(e) => setScrapped(e.target.value.replace(/[^0-9]/g, ''))} aria-label="Scrapped" /></label>
          <label className={`${label} flex-1 min-w-[240px]`}>Notes<input className={`${input} block mt-0.5 w-full`} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Completion notes" placeholder="What went well, what to change next time" /></label>
          {waiting > 0 && <label className="flex items-center gap-1 text-[11px] text-on-surface-variant"><input type="checkbox" checked={scrapWaiting} onChange={(e) => setScrapWaiting(e.target.checked)} /> The {fmtNumber(waiting)} labelled, not booked in, were scrapped</label>}
          <PrimaryButton type="button" disabled={waiting > 0 && !scrapWaiting} onClick={() => void complete()}>Complete</PrimaryButton>
        </div>
      )}
      {d.usage.some((u: any) => u.over > 0) && <p className="text-[11px] text-amber-500">More came back than was sent for: {d.usage.filter((u: any) => u.over > 0).map((u: any) => `${u.serial_number} (+${u.over})`).join(', ')}.</p>}
    </Step>
  );
}
