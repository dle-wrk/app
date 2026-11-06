// Sales > Returns: customer returns (RMA). Open one from an invoice or on its
// own, mark it received, give each line an outcome, close it (restock and a
// draft credit note). Server: src/lib/returnsRoutes.ts.

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { canChange } from '../../lib/changeAccess';
import { confirmDialog } from '../../lib/confirmDialog';
import { fmtNumber } from '../../lib/formatMoney';
import { PrimaryButton, SecondaryButton, type ModuleDataProps } from './shared';

const OUTCOMES: Array<[string, string]> = [['RESTOCK', 'Restock (back into stock)'], ['SCRAP', 'Scrap'], ['REPAIR', 'Repair and send back'], ['REPLACE', 'Replace'], ['CREDIT', 'Credit only']];
const STATUS: Record<string, string> = { OPEN: 'bg-primary/10 text-primary', RECEIVED: 'bg-amber-500/10 text-amber-500', CLOSED: 'bg-green-500/10 text-green-400', CANCELLED: 'bg-surface-container-highest text-outline' };
const input = 'bg-surface-container border border-outline-variant rounded px-2 py-1.5 text-xs text-on-surface';
const when = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
async function api(url: string, init?: RequestInit) {
  const res = await fetch(url, init && init.body ? { ...init, headers: { 'Content-Type': 'application/json' } } : init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

type Line = { partNumber: string; description: string; quantity: string; serialNumbers: string; reason: string; unitPrice: number; taxRateId: number | null; invoiceItemId: number | null };

type Repair = { pick: boolean; charge: string; note: string };

export const ReturnsTab: React.FC<ModuleDataProps> = ({ triggerToast, invoices, clients, refresh }) => {
  const may = canChange('/api/returns');
  const [list, setList] = useState<any[] | null>(null);
  const [open, setOpenRaw] = useState<any | null>(null);
  const [repairs, setRepairs] = useState<Record<number, Repair>>({});
  const [sendAs, setSendAs] = useState<'DELIVERY' | 'COLLECTION'>('DELIVERY');
  const [repairInvoice, setRepairInvoice] = useState(true);
  const setOpen = (r: any | null) => {
    setOpenRaw(r);
    setRepairs(Object.fromEntries((r?.lines ?? []).filter((l: any) => l.repair_status === 'IN_REPAIR').map((l: any) => [l.id, { pick: true, charge: '', note: '' }])));
  };
  const [form, setForm] = useState<{ clientId: string; invoiceId: string; reason: string; lines: Line[] } | null>(null);
  const [credit, setCredit] = useState(true);
  const load = useCallback(async () => { try { setList(await api('/api/returns')); } catch (e: any) { triggerToast(e.message, 'ERROR'); } }, [triggerToast]);
  useEffect(() => { void load(); }, [load]);
  const reopen = async (id: number) => { try { setOpen(await api(`/api/returns/${id}`)); } catch (e: any) { triggerToast(e.message, 'ERROR'); } };

  const fromInvoice = async (invoiceId: string) => {
    if (!form) return;
    if (!invoiceId) { setForm({ ...form, invoiceId: '' }); return; }
    try {
      const inv = await api(`/api/invoices/${invoiceId}`);
      setForm({ ...form, invoiceId, clientId: String(inv.clientId ?? form.clientId), lines: (inv.items ?? []).map((i: any) => ({
        partNumber: i.partNumber ?? '', description: i.description ?? '', quantity: '', serialNumbers: '', reason: '', unitPrice: Number(i.unitPrice) || 0, taxRateId: i.taxRateId ?? null, invoiceItemId: i.id ?? null,
      })) });
    } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };

  const create = async () => {
    try {
      const r = await api('/api/returns', { method: 'POST', body: JSON.stringify({ clientId: form!.clientId || null, invoiceId: form!.invoiceId || null, reason: form!.reason, lines: form!.lines.filter((l) => Number(l.quantity) > 0) }) });
      triggerToast(`${r.number} opened.`, 'SUCCESS'); setForm(null); await load(); await reopen(r.id);
    } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const act = async (path: string, body: any, done: string) => {
    try { const r = await api(`/api/returns/${open.id}/${path}`, { method: 'POST', body: JSON.stringify(body) }); triggerToast(done.replace('{cn}', r.creditNote ? `; draft credit note ${r.creditNote.number}` : ''), 'SUCCESS'); await reopen(open.id); await load(); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const sendBack = async () => {
    const lines = Object.entries(repairs).filter(([, x]) => x.pick).map(([lineId, x]) => ({ lineId: Number(lineId), charge: x.charge, note: x.note }));
    if (!lines.length) { triggerToast('Tick what has been repaired.', 'ERROR'); return; }
    const charged = lines.some((l) => Number(l.charge) > 0);
    const kind = sendAs === 'DELIVERY' ? 'delivery note' : 'collection note';
    if (!(await confirmDialog({ title: 'Repaired: send back', message: `Raise a draft ${kind} for ${lines.length} repaired line${lines.length === 1 ? '' : 's'} (it takes nothing from stock)${charged && repairInvoice ? ', and a draft invoice for the repair charges' : ''}. Both are drafts to check and send as usual.`, confirmLabel: 'Send back' }))) return;
    try {
      const r = await api(`/api/returns/${open.id}/repaired`, { method: 'POST', body: JSON.stringify({ lines, noteType: sendAs, invoice: repairInvoice }) });
      triggerToast(`${r.repaired} repaired: draft ${r.dispatch.number} in Delivery & Collection${r.invoice ? ` and draft invoice ${r.invoice.number} in Invoices` : ''}.`, 'SUCCESS');
      await reopen(open.id); await load(); if (r.invoice) await refresh();
    } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const repairState = (l: any) => l.repair_status === 'IN_REPAIR' ? 'In repair'
    : l.repair_status === 'REPAIRED' ? ['Repaired', l.repair_dispatch_number, l.repair_invoice_number, Number(l.repair_charge) > 0 ? null : 'no charge'].filter(Boolean).join(' · ') : null;
  const setOutcome = async (lineId: number, outcome: string) => {
    try { await api(`/api/returns/${open.id}/lines/${lineId}`, { method: 'PUT', body: JSON.stringify({ outcome: outcome || null }) }); await reopen(open.id); } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };

  if (open) {
    const live = open.status === 'OPEN' || open.status === 'RECEIVED';
    return (
      <div className="space-y-md" data-testid="return-detail">
        <div className="flex flex-wrap items-center justify-between gap-sm">
          <div>
            <p className="text-sm font-bold text-on-surface">{open.number} · {open.client_name ?? 'No customer'}{open.invoice_number ? ` · ${open.invoice_number}` : ''} <span className={`ml-1 px-2 py-0.5 rounded text-[10px] font-bold ${STATUS[open.status]}`}>{open.status}</span></p>
            <p className="text-[11px] text-outline">{open.reason}{open.credit_note_number ? ` · credit note ${open.credit_note_number}` : ''}</p>
          </div>
          <div className="flex gap-sm items-center">
            <SecondaryButton type="button" onClick={() => setOpen(null)}>Back</SecondaryButton>
            {may && live && <SecondaryButton type="button" onClick={async () => { if (await confirmDialog({ title: 'Cancel return', message: `Cancel ${open.number}? Nothing has changed stock or the books yet.`, confirmLabel: 'Cancel it', destructive: true })) await act('cancel', {}, `${open.number} cancelled.`); }}>Cancel return</SecondaryButton>}
            {may && open.status === 'OPEN' && <PrimaryButton type="button" onClick={() => void act('receive', {}, `${open.number} received.`)}>Mark received</PrimaryButton>}
            {may && open.status === 'RECEIVED' && <>
              <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={credit} onChange={(e) => setCredit(e.target.checked)} /> Draft a credit note</label>
              <PrimaryButton type="button" onClick={async () => { if (await confirmDialog({ title: `Close ${open.number}`, message: `Restocked lines go back into stock (no location yet)${credit ? ', and a draft credit note is raised for the credited lines at their invoiced price, to check and issue' : ''}.${open.lines.some((l: any) => l.outcome === 'REPAIR') ? ' Repair lines stay here, in repair, until you send them back.' : ''}`, confirmLabel: 'Close it' })) await act('close', { creditNote: credit }, `${open.number} closed{cn}.`); }}>Close</PrimaryButton>
            </>}
          </div>
        </div>
        <table className="w-full text-left text-xs rounded-xl border border-outline-variant">
          <thead><tr className="text-[10px] text-outline uppercase tracking-wider bg-surface-container-high/30"><th className="px-md py-2">Item</th><th className="px-md py-2 text-right">Qty</th><th className="px-md py-2">Serials</th><th className="px-md py-2">Reason</th><th className="px-md py-2">Outcome</th></tr></thead>
          <tbody className="divide-y divide-outline-variant/30">{open.lines.map((l: any) => (
            <tr key={l.id}><td className="px-md py-2"><span className="font-mono font-bold">{l.part_number ?? ''}</span><span className="block text-[11px] text-on-surface-variant">{l.description}</span></td>
              <td className="px-md py-2 text-right font-mono">{fmtNumber(Number(l.quantity))}</td><td className="px-md py-2 font-mono text-[11px]">{l.serial_numbers}</td><td className="px-md py-2 text-on-surface-variant">{l.reason}</td>
              <td className="px-md py-2">{may && open.status === 'RECEIVED'
                ? <select className={input} value={l.outcome ?? ''} onChange={(e) => void setOutcome(l.id, e.target.value)} aria-label={`Outcome for ${l.part_number ?? l.description}`}><option value="">Inspect…</option>{OUTCOMES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                : <span>{OUTCOMES.find(([k]) => k === l.outcome)?.[1] ?? (open.status === 'OPEN' ? 'after it arrives' : '')}</span>}
                {repairState(l) && <span className={`block text-[10px] font-bold ${l.repair_status === 'IN_REPAIR' ? 'text-amber-500' : 'text-green-400'}`}>{repairState(l)}</span>}</td></tr>
          ))}</tbody>
        </table>
        {open.lines.some((l: any) => l.repair_status === 'IN_REPAIR') && (
          <div className="rounded-xl border border-amber-500/40 bg-surface-container-high p-md space-y-sm" data-testid="return-repairs">
            <p className="text-sm font-bold text-on-surface">In repair</p>
            <p className="text-[11px] text-on-surface-variant">When they're fixed, tick them and send them back: a draft delivery or collection note goes to Delivery &amp; Collection (it takes nothing from stock, they're the customer's own), and any repair charge goes on a draft invoice. Leave the charge empty for warranty work.</p>
            <table className="w-full text-xs"><tbody>{open.lines.filter((l: any) => l.repair_status === 'IN_REPAIR').map((l: any) => {
              const x = repairs[l.id] ?? { pick: false, charge: '', note: '' };
              const put = (p: Partial<Repair>) => setRepairs({ ...repairs, [l.id]: { ...x, ...p } });
              return (
                <tr key={l.id}>
                  <td className="pr-2 py-0.5"><label className="flex items-center gap-1"><input type="checkbox" checked={x.pick} onChange={(e) => put({ pick: e.target.checked })} disabled={!may} aria-label={`Repaired: ${l.part_number ?? l.description}`} /><span className="font-mono font-bold">{l.part_number ?? ''}</span> <span className="text-on-surface-variant">{l.description} × {fmtNumber(Number(l.quantity))}</span></label></td>
                  <td className="pr-1 py-0.5"><input className={`${input} w-32 font-mono`} inputMode="decimal" value={x.charge} onChange={(e) => put({ charge: e.target.value })} disabled={!may} placeholder="Charge each, excl. VAT" aria-label={`Repair charge for ${l.part_number ?? l.description}`} /></td>
                  <td className="py-0.5"><input className={`${input} w-full`} value={x.note} onChange={(e) => put({ note: e.target.value })} disabled={!may} placeholder="What was fixed" aria-label={`Repair note for ${l.part_number ?? l.description}`} /></td>
                </tr>
              );
            })}</tbody></table>
            {may && (
              <div className="flex flex-wrap items-center justify-end gap-sm">
                <select className={input} value={sendAs} onChange={(e) => setSendAs(e.target.value as any)} aria-label="Send back as"><option value="DELIVERY">We deliver it</option><option value="COLLECTION">Customer collects it</option></select>
                <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={repairInvoice} onChange={(e) => setRepairInvoice(e.target.checked)} /> Draft an invoice for the charges</label>
                <PrimaryButton type="button" onClick={() => void sendBack()}>Repaired: send back</PrimaryButton>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-md" data-testid="returns-tab">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-md">
        <p className="text-xs text-on-surface-variant max-w-[760px]">Goods coming back from a customer. Open a return (from the invoice, to pick its lines), mark it received when it arrives, decide what happens to each line, then close it: restocked lines go back into stock, and a draft credit note can be raised for what is credited. Faulty goods for repair wait here, in repair, until they're fixed, then go back on a delivery or collection note, with a draft invoice for any repair charge.</p>
        {may && <PrimaryButton type="button" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setForm({ clientId: '', invoiceId: '', reason: '', lines: [{ partNumber: '', description: '', quantity: '1', serialNumbers: '', reason: '', unitPrice: 0, taxRateId: null, invoiceItemId: null }] })}>New return</PrimaryButton>}
      </div>
      {form && (
        <div className="rounded-xl border border-outline-variant bg-surface-container-high p-md space-y-sm" data-testid="return-form">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-sm">
            <label className="text-[10px] text-outline">From invoice (optional)<select className={`${input} w-full mt-0.5`} value={form.invoiceId} onChange={(e) => void fromInvoice(e.target.value)} aria-label="From invoice">
              <option value="">None</option>{invoices.filter((i) => i.status !== 'DRAFT' && i.status !== 'VOID').map((i) => <option key={i.id} value={i.id}>{i.invoiceNumber} · {i.clientName}</option>)}</select></label>
            <label className="text-[10px] text-outline">Customer<select className={`${input} w-full mt-0.5`} value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} disabled={!!form.invoiceId} aria-label="Customer">
              <option value="">Choose…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.clientName}</option>)}</select></label>
            <label className="text-[10px] text-outline">Reason<input className={`${input} w-full mt-0.5`} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Faulty on arrival" aria-label="Reason" /></label>
          </div>
          <table className="w-full text-xs"><tbody>{form.lines.map((l, i) => (
            <tr key={i}>
              <td className="pr-1 py-0.5"><input className={`${input} w-28 font-mono`} value={l.partNumber} onChange={(e) => setForm({ ...form, lines: form.lines.map((x, j) => (j === i ? { ...x, partNumber: e.target.value } : x)) })} placeholder="Stock code" aria-label="Stock code" /></td>
              <td className="pr-1 py-0.5"><input className={`${input} w-full`} value={l.description} onChange={(e) => setForm({ ...form, lines: form.lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} placeholder="Description" aria-label="Description" /></td>
              <td className="pr-1 py-0.5"><input className={`${input} w-16 font-mono`} inputMode="decimal" value={l.quantity} onChange={(e) => setForm({ ...form, lines: form.lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)) })} placeholder="Qty" aria-label="Quantity returned" /></td>
              <td className="pr-1 py-0.5"><input className={`${input} w-32`} value={l.serialNumbers} onChange={(e) => setForm({ ...form, lines: form.lines.map((x, j) => (j === i ? { ...x, serialNumbers: e.target.value } : x)) })} placeholder="Serials" aria-label="Serial numbers" /></td>
              <td className="pr-1 py-0.5"><input className={`${input} w-40`} value={l.reason} onChange={(e) => setForm({ ...form, lines: form.lines.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)) })} placeholder="Fault" aria-label="Line reason" /></td>
              <td><button type="button" aria-label="Remove line" className="p-1 text-error" onClick={() => setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) })}><Trash2 className="w-3.5 h-3.5" /></button></td>
            </tr>
          ))}</tbody></table>
          <div className="flex justify-between">
            <button type="button" className="text-primary text-xs inline-flex items-center gap-1" onClick={() => setForm({ ...form, lines: [...form.lines, { partNumber: '', description: '', quantity: '1', serialNumbers: '', reason: '', unitPrice: 0, taxRateId: null, invoiceItemId: null }] })}><Plus className="w-3 h-3" /> Add a line</button>
            <div className="flex gap-sm"><SecondaryButton type="button" onClick={() => setForm(null)}>Cancel</SecondaryButton><PrimaryButton type="button" onClick={() => void create()} icon={<RotateCcw className="w-3.5 h-3.5" />}>Open return</PrimaryButton></div>
          </div>
          {form.invoiceId && <p className="text-[10px] text-outline">Enter the quantity coming back on each invoice line; lines left at 0 aren't part of the return.</p>}
        </div>
      )}
      {!list ? <Loader2 className="w-4 h-4 animate-spin" /> : list.length === 0 ? <p className="text-xs text-on-surface-variant italic">No returns yet.</p> : (
        <table className="w-full text-left text-xs rounded-xl border border-outline-variant">
          <thead><tr className="text-[10px] text-outline uppercase tracking-wider bg-surface-container-high/30"><th className="px-md py-2">Return</th><th className="px-md py-2">Customer</th><th className="px-md py-2">Invoice</th><th className="px-md py-2">Lines</th><th className="px-md py-2">Status</th><th className="px-md py-2">Opened</th></tr></thead>
          <tbody className="divide-y divide-outline-variant/30">{list.map((r) => (
            <tr key={r.id}><td className="px-md py-2"><button type="button" className="font-mono font-bold text-primary hover:underline" onClick={() => void reopen(r.id)}>{r.number}</button></td>
              <td className="px-md py-2">{r.client_name}</td><td className="px-md py-2 font-mono">{r.invoice_number}</td><td className="px-md py-2">{r.lines}</td>
              <td className="px-md py-2"><span className={`px-2 py-0.5 rounded text-[10px] font-bold ${STATUS[r.status]}`}>{r.status}</span>{r.credit_note_number && <span className="text-[10px] text-outline"> · {r.credit_note_number}</span>}{r.in_repair > 0 && <span className="ml-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-500">{r.in_repair} in repair</span>}</td>
              <td className="px-md py-2 text-outline">{when(r.created_at)}</td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
};
