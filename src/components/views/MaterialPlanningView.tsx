// Manufacturing > Material Planning: what every open sales order and planned
// build needs, against stock and what's on order, by date; what to buy and
// by when. And what each product is made of, so a product on a sales order
// is broken down into its boards' parts. Server: src/lib/materialPlanningRoutes.ts.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, ChevronDown, ChevronRight, Layers, Loader2, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { canChange } from '../../lib/changeAccess';
import { confirmDialog } from '../../lib/confirmDialog';
import { fmtNumber } from '../../lib/formatMoney';
import { PrimaryButton, SecondaryButton } from '../bookkeeping/shared';

type Toast = (msg: string, type?: string) => void;
interface Row { partNumber: string; name: string; stock: number; demand: number; onOrder: number; safety: number; shortBy: string | null; shortfall: number; orderBy: string | null; late: boolean; leadDays: number | null; leadNote: string; supplier: string | null; demands: Array<{ qty: number; needBy: string | null; source: string }>; receipts: Array<{ qty: number; due: string | null; source: string }> }
interface Plan { rows: Row[]; unmapped: Array<{ model: string; qty: number }>; demandCount: number }
const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

function Products({ triggerToast, onSaved }: { triggerToast: Toast; onSaved: () => void }) {
  const may = canChange('/api/material-planning');
  const [data, setData] = useState<{ products: Array<{ model_number: string; description: string; category: string; boards: Array<{ projectId: number; perUnit: number }> }>; projects: Array<{ id: string; project_name: string; status: string }> } | null>(null);
  const [edit, setEdit] = useState<Record<string, Array<{ projectId: string; perUnit: string }>>>({});
  const load = useCallback(async () => { const r = await fetch('/api/material-planning/products'); setData(await r.json()); }, []);
  useEffect(() => { void load(); }, [load]);
  if (!data) return <Loader2 className="w-3.5 h-3.5 animate-spin" />;
  const save = async (model: string) => {
    const boards = (edit[model] ?? []).filter((b) => b.projectId).map((b) => ({ projectId: Number(b.projectId), perUnit: Number(b.perUnit) || 1 }));
    const res = await fetch(`/api/material-planning/products/${encodeURIComponent(model)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ boards }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { triggerToast(body.error || 'Could not save.', 'ERROR'); return; }
    setEdit((e) => { const n = { ...e }; delete n[model]; return n; });
    await load(); onSaved();
  };
  const project = (id: number | string) => data.projects.find((p) => String(p.id) === String(id))?.project_name ?? `Project ${id}`;
  return (
    <div className="space-y-sm" data-testid="product-boards">
      <p className="text-xs text-on-surface-variant max-w-[760px]">Say which boards each product is built from and how many per unit (a TCU might be 1 × TCU06 PCB and 1 × POWER PACK). A product sold on a sales order is then broken down into those boards' BOM parts. Products with no boards can't be planned.</p>
      <div className="rounded-xl border border-outline-variant overflow-x-auto">
        <table className="w-full text-left text-xs"><thead><tr className="text-[10px] text-outline uppercase tracking-wider bg-surface-container-high/30"><th className="px-md py-2">Product</th><th className="px-md py-2">Made of</th><th className="px-md py-2" /></tr></thead>
          <tbody className="divide-y divide-outline-variant/30">{data.products.map((p) => {
            const e = edit[p.model_number];
            return (
              <tr key={p.model_number} data-product={p.model_number}>
                <td className="px-md py-2 align-top"><span className="font-mono font-bold">{p.model_number}</span><span className="block text-[11px] text-on-surface-variant">{p.description}</span></td>
                <td className="px-md py-2 align-top">{e ? (
                  <div className="space-y-1">{e.map((b, i) => (
                    <div key={i} className="flex gap-1 items-center">
                      <input className="w-16 bg-surface-container border border-outline-variant rounded px-2 py-1 text-xs font-mono" inputMode="decimal" value={b.perUnit} onChange={(ev) => setEdit({ ...edit, [p.model_number]: e.map((x, j) => (j === i ? { ...x, perUnit: ev.target.value } : x)) })} aria-label="Boards per unit" />
                      <span className="text-outline">×</span>
                      <select className="bg-surface-container border border-outline-variant rounded px-2 py-1 text-xs" value={b.projectId} onChange={(ev) => setEdit({ ...edit, [p.model_number]: e.map((x, j) => (j === i ? { ...x, projectId: ev.target.value } : x)) })} aria-label="Board">
                        <option value="">Choose a board…</option>{data.projects.map((pr) => <option key={pr.id} value={pr.id}>{pr.project_name}</option>)}
                      </select>
                      <button type="button" aria-label="Remove board" className="p-1 text-error" onClick={() => setEdit({ ...edit, [p.model_number]: e.filter((_, j) => j !== i) })}><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>))}
                    <button type="button" className="text-primary text-[11px] inline-flex items-center gap-1" onClick={() => setEdit({ ...edit, [p.model_number]: [...e, { projectId: '', perUnit: '1' }] })}><Plus className="w-3 h-3" /> Add a board</button>
                  </div>
                ) : p.boards.length ? p.boards.map((b) => `${b.perUnit} × ${project(b.projectId)}`).join(', ') : <span className="text-outline">Not set</span>}</td>
                <td className="px-md py-2 align-top text-right whitespace-nowrap">{may && (e
                  ? <><SecondaryButton type="button" onClick={() => setEdit((x) => { const n = { ...x }; delete n[p.model_number]; return n; })}>Cancel</SecondaryButton> <PrimaryButton type="button" onClick={() => void save(p.model_number)}>Save</PrimaryButton></>
                  : <SecondaryButton type="button" onClick={() => setEdit({ ...edit, [p.model_number]: p.boards.length ? p.boards.map((b) => ({ projectId: String(b.projectId), perUnit: String(b.perUnit) })) : [{ projectId: '', perUnit: '1' }] })}>Edit</SecondaryButton>)}</td>
              </tr>
            );
          })}</tbody></table>
      </div>
    </div>
  );
}

export default function MaterialPlanningView({ triggerToast, onOpenItem }: { triggerToast: Toast; onOpenItem?: (s: string) => void }) {
  const may = canChange('/api/material-planning');
  const [tab, setTab] = useState<'plan' | 'products'>('plan');
  const [opts, setOpts] = useState({ quotes: false, kits: false, safety: false });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [onlyBuy, setOnlyBuy] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ quotes: opts.quotes ? '1' : '0', kits: opts.kits ? '1' : '0', safety: opts.safety ? '1' : '0' });
      const res = await fetch(`/api/material-planning?${q}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setPlan(body);
      setPicked(new Set(body.rows.filter((r: Row) => r.shortfall > 0).map((r: Row) => r.partNumber)));
    } catch (e: any) { triggerToast(`Could not plan: ${e?.message || e}`, 'ERROR'); } finally { setLoading(false); }
  }, [opts, triggerToast]);
  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => (plan?.rows ?? []).filter((r) => !onlyBuy || r.shortfall > 0), [plan, onlyBuy]);
  const toBuy = (plan?.rows ?? []).filter((r) => r.shortfall > 0);
  const late = toBuy.filter((r) => r.late).length;

  const draft = async () => {
    const lines = toBuy.filter((r) => picked.has(r.partNumber)).map((r) => ({ partNumber: r.partNumber, qty: r.shortfall }));
    if (!lines.length) return;
    if (!(await confirmDialog({ title: 'Draft purchase orders', message: `Draft purchase orders for ${fmtNumber(lines.length)} part${lines.length === 1 ? '' : 's'}, one per supplier, for the quantities shown? They are drafts: check suppliers and prices before sending.`, confirmLabel: 'Draft them' }))) return;
    const res = await fetch('/api/material-planning/draft-pos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { triggerToast(body.error || 'Could not draft them.', 'ERROR'); return; }
    triggerToast(`Drafted ${body.created.map((c: any) => `${c.poNumber}${c.supplier ? ` (${c.supplier})` : ''}`).join(', ')}. Find them under Purchase Orders.`, 'SUCCESS');
    await load();
  };

  return (
    <div className="p-container-margin space-y-md max-w-7xl mx-auto w-full">
      <div>
        <h3 className="font-headline-sm text-lg text-on-surface flex items-center gap-2"><CalendarClock className="w-5 h-5 text-primary" /> Material planning</h3>
        <p className="text-on-surface-variant text-xs max-w-[820px]">Everything open sales orders and planned production jobs need, against stock and open purchase orders, by date. A part shows when it first runs short, how many to buy, and the date to order by (that date less its supplier's lead time).</p>
      </div>
      <div className="flex gap-1 border-b border-outline-variant/30">
        {([['plan', 'Plan', <CalendarClock key="p" className="w-3.5 h-3.5" />], ['products', 'What products are made of', <Layers key="l" className="w-3.5 h-3.5" />]] as const).map(([k, label, icon]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold border-b-2 ${tab === k ? 'text-primary border-primary' : 'text-on-surface-variant border-transparent hover:text-on-surface'}`}>{icon}{label}</button>
        ))}
      </div>
      <div className="bg-surface-container border border-outline-variant rounded-xl p-lg space-y-md">
        {tab === 'products' ? <Products triggerToast={triggerToast} onSaved={() => void load()} /> : <>
          <div className="flex flex-wrap items-center gap-md text-xs">
            {([['quotes', 'Include quotes'], ['kits', 'Include saved kits'], ['safety', 'Keep low-stock levels as safety stock']] as const).map(([k, label]) => (
              <label key={k} className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} />{label}</label>
            ))}
            <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={onlyBuy} onChange={(e) => setOnlyBuy(e.target.checked)} />Only parts to buy</label>
            <span className="ml-auto flex gap-sm">
              <SecondaryButton type="button" onClick={() => void load()} disabled={loading} icon={loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}>Refresh</SecondaryButton>
              {may && toBuy.length > 0 && <PrimaryButton type="button" onClick={() => void draft()} disabled={!picked.size} icon={<ShoppingCart className="w-3.5 h-3.5" />}>Draft POs for {fmtNumber([...picked].filter((p) => toBuy.some((r) => r.partNumber === p)).length)}</PrimaryButton>}
            </span>
          </div>
          {plan && (
            <p className="text-xs text-on-surface" data-testid="plan-summary">
              {toBuy.length ? `${fmtNumber(toBuy.length)} part${toBuy.length === 1 ? '' : 's'} to buy` : 'Nothing to buy: stock and open orders cover every demand'}{late ? `, ${fmtNumber(late)} already past their order-by date` : ''}. From {fmtNumber(plan.demandCount)} demand lines.
            </p>
          )}
          {plan && plan.unmapped.length > 0 && (
            <p className="text-[11px] text-amber-500 flex items-start gap-1"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>Not planned, because what they're made of isn't set: {plan.unmapped.map((u) => `${u.model} (${fmtNumber(u.qty)})`).join(', ')}. Set them under <button type="button" className="underline" onClick={() => setTab('products')}>What products are made of</button>.</span></p>
          )}
          {!plan ? <Loader2 className="w-4 h-4 animate-spin" /> : rows.length === 0 ? <p className="text-xs text-on-surface-variant italic">{onlyBuy ? 'Nothing to buy.' : 'No demand.'}</p> : (
            <div className="rounded-xl border border-outline-variant overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead><tr className="text-[10px] text-outline uppercase tracking-wider bg-surface-container-high/30">
                  <th className="px-sm py-2" /><th className="px-md py-2">Part</th><th className="px-md py-2 text-right">Needed</th><th className="px-md py-2 text-right">Stock</th><th className="px-md py-2 text-right">On order</th>
                  <th className="px-md py-2 text-right">To buy</th><th className="px-md py-2">Short from</th><th className="px-md py-2">Order by</th><th className="px-md py-2">Supplier</th>
                </tr></thead>
                <tbody className="divide-y divide-outline-variant/30">{rows.map((r) => (
                  <React.Fragment key={r.partNumber}>
                    <tr data-plan-row={r.partNumber} className={r.late ? 'bg-error/5' : ''}>
                      <td className="px-sm py-2">{r.shortfall > 0 && may && <input type="checkbox" checked={picked.has(r.partNumber)} onChange={() => setPicked((p) => { const n = new Set(p); n.has(r.partNumber) ? n.delete(r.partNumber) : n.add(r.partNumber); return n; })} aria-label={`Order ${r.partNumber}`} />}</td>
                      <td className="px-md py-2"><button type="button" className="inline-flex items-center gap-1" onClick={() => setOpen((o) => { const n = new Set(o); n.has(r.partNumber) ? n.delete(r.partNumber) : n.add(r.partNumber); return n; })} aria-label="Show where it's needed">{open.has(r.partNumber) ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}</button>
                        {onOpenItem ? <button type="button" className="font-mono font-bold text-primary hover:underline" onClick={() => onOpenItem(r.partNumber)}>{r.partNumber}</button> : <span className="font-mono font-bold">{r.partNumber}</span>}<span className="block text-[10px] text-on-surface-variant ml-5">{r.name}</span></td>
                      <td className="px-md py-2 text-right font-mono">{fmtNumber(r.demand)}</td>
                      <td className="px-md py-2 text-right font-mono">{fmtNumber(r.stock)}</td>
                      <td className="px-md py-2 text-right font-mono">{r.onOrder ? fmtNumber(r.onOrder) : ''}</td>
                      <td className={`px-md py-2 text-right font-mono font-bold ${r.shortfall ? 'text-error' : 'text-green-500'}`}>{r.shortfall ? fmtNumber(r.shortfall) : 'covered'}</td>
                      <td className="px-md py-2 whitespace-nowrap">{r.shortfall ? date(r.shortBy) : ''}</td>
                      <td className={`px-md py-2 whitespace-nowrap ${r.late ? 'text-error font-bold' : ''}`} title={r.leadNote}>{r.shortfall ? `${date(r.orderBy)}${r.late ? ' (late)' : ''}` : ''}{r.shortfall && r.leadDays !== null ? <span className="block text-[10px] text-outline font-normal">{r.leadDays}-day lead</span> : null}</td>
                      <td className="px-md py-2 text-on-surface-variant">{r.supplier ?? <span className="text-outline">unknown</span>}</td>
                    </tr>
                    {open.has(r.partNumber) && (
                      <tr><td /><td colSpan={8} className="px-md py-2 bg-surface-container-high/30 text-[11px]">
                        {r.demands.map((d, i) => <div key={i}>Needs {fmtNumber(d.qty)} by {date(d.needBy)} · {d.source}</div>)}
                        {r.receipts.map((x, i) => <div key={`r${i}`} className="text-green-500">{fmtNumber(x.qty)} due {date(x.due)} · {x.source}</div>)}
                        {r.safety > 0 && <div className="text-outline">Keeps {fmtNumber(r.safety)} as safety stock.</div>}
                      </td></tr>
                    )}
                  </React.Fragment>
                ))}</tbody>
              </table>
            </div>
          )}
        </>}
      </div>
    </div>
  );
}
