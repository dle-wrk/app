// Sales > Recurring: invoice templates that become DRAFT invoices on each due
// date (daily check on the server, or Run now). Server: src/lib/recurringInvoices.ts.

import React, { useCallback, useEffect, useState } from 'react';
import { CalendarSync, Loader2, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { canChange } from '../../lib/changeAccess';
import { confirmDialog } from '../../lib/confirmDialog';
import { fmtNumber, fmtZAR } from '../../lib/formatMoney';
import { PrimaryButton, SecondaryButton, type ModuleDataProps } from './shared';

const FREQ: Array<[string, string, string]> = [['WEEKLY', 'Weekly', 'weeks'], ['MONTHLY', 'Monthly', 'months'], ['QUARTERLY', 'Quarterly', 'quarters'], ['YEARLY', 'Yearly', 'years']];
const input = 'bg-surface-container border border-outline-variant rounded px-2 py-1.5 text-xs text-on-surface';
// Dates arrive as YYYY-MM-DD text; read them as that day, not as UTC midnight.
const when = (d: string | null) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const today = () => new Date().toISOString().slice(0, 10);
async function api(url: string, init?: RequestInit) {
  const res = await fetch(url, init && init.body ? { ...init, headers: { 'Content-Type': 'application/json' } } : init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
type L = { partNumber: string; description: string; quantity: string; unitPrice: string; taxRateId: string };
type Form = { id?: number; name: string; clientId: string; currency: string; frequency: string; every: string; nextDate: string; endDate: string; termsDays: string; notes: string; lines: L[] };
const blankLine = (): L => ({ partNumber: '', description: '', quantity: '1', unitPrice: '', taxRateId: '' });

export const RecurringInvoicesTab: React.FC<ModuleDataProps> = ({ triggerToast, clients, taxRates, refresh }) => {
  const may = canChange('/api/recurring-invoices');
  const [list, setList] = useState<any[] | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setList(await api('/api/recurring-invoices')); } catch (e: any) { triggerToast(e.message, 'ERROR'); } }, [triggerToast]);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    const f = form!;
    const body = JSON.stringify({ name: f.name, clientId: f.clientId, currency: f.currency, frequency: f.frequency, every: Number(f.every), nextDate: f.nextDate, endDate: f.endDate || null, termsDays: Number(f.termsDays), notes: f.notes,
      lines: f.lines.map((l) => ({ partNumber: l.partNumber, description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), taxRateId: l.taxRateId ? Number(l.taxRateId) : null })) });
    try { await api(f.id ? `/api/recurring-invoices/${f.id}` : '/api/recurring-invoices', { method: f.id ? 'PUT' : 'POST', body }); setForm(null); await load(); triggerToast('Saved.', 'SUCCESS'); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const run = async () => {
    setBusy(true);
    try {
      const r = await api('/api/recurring-invoices/run', { method: 'POST', body: '{}' });
      triggerToast(r.made.length ? `Drafted ${r.made.map((m: any) => m.invoiceNumber).join(', ')}. Check them under Invoices, then Finalize & Send.` : 'Nothing is due.', r.made.length ? 'SUCCESS' : 'INFO');
      await load(); if (r.made.length) await refresh();
    } catch (e: any) { triggerToast(e.message, 'ERROR'); } finally { setBusy(false); }
  };
  const edit = (r: any) => setForm({ id: r.id, name: r.name, clientId: String(r.client_id ?? ''), currency: r.currency, frequency: r.frequency, every: String(r.every), nextDate: String(r.next_date).slice(0, 10), endDate: r.end_date ? String(r.end_date).slice(0, 10) : '', termsDays: String(r.terms_days), notes: r.notes ?? '',
    lines: (r.lines ?? []).map((l: any) => ({ partNumber: l.partNumber ?? '', description: l.description ?? '', quantity: String(l.quantity), unitPrice: String(l.unitPrice), taxRateId: l.taxRateId ? String(l.taxRateId) : '' })) });
  const total = (lines: any[]) => lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unitPrice), 0);

  return (
    <div className="space-y-md" data-testid="recurring-tab">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-md">
        <p className="text-xs text-on-surface-variant max-w-[760px]">Invoices that repeat: service contracts, monitoring, rentals. On each due date a <strong>draft</strong> invoice is made from the template (checked daily), to check and Finalize &amp; Send as usual. Missed dates are caught up. Nothing reaches the books until you send it.</p>
        {may && <div className="flex gap-sm shrink-0">
          <SecondaryButton type="button" onClick={() => void run()} disabled={busy} icon={busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}>Run now</SecondaryButton>
          <PrimaryButton type="button" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setForm({ name: '', clientId: '', currency: 'ZAR', frequency: 'MONTHLY', every: '1', nextDate: today(), endDate: '', termsDays: '30', notes: '', lines: [blankLine()] })}>New recurring invoice</PrimaryButton>
        </div>}
      </div>
      {form && (
        <div className="rounded-xl border border-outline-variant bg-surface-container-high p-md space-y-sm" data-testid="recurring-form">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-sm">
            <label className="text-[10px] text-outline col-span-2">Name<input className={`${input} w-full mt-0.5`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Monitoring - Lumax" aria-label="Name" /></label>
            <label className="text-[10px] text-outline">Customer<select className={`${input} w-full mt-0.5`} value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} aria-label="Customer"><option value="">Choose…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.clientName}</option>)}</select></label>
            <label className="text-[10px] text-outline">Currency<select className={`${input} w-full mt-0.5`} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} aria-label="Currency">{['ZAR', 'USD', 'EUR', 'GBP'].map((c) => <option key={c}>{c}</option>)}</select></label>
            <label className="text-[10px] text-outline">How often<select className={`${input} w-full mt-0.5`} value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })} aria-label="How often">{FREQ.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="text-[10px] text-outline">Every<span className="flex items-center gap-1 mt-0.5"><input className={`${input} w-14`} inputMode="numeric" value={form.every} onChange={(e) => setForm({ ...form, every: e.target.value.replace(/[^0-9]/g, '') })} aria-label="Every" />{FREQ.find((f) => f[0] === form.frequency)?.[2]}</span></label>
            <label className="text-[10px] text-outline">Next invoice<input type="date" className={`${input} w-full mt-0.5`} value={form.nextDate} onChange={(e) => setForm({ ...form, nextDate: e.target.value })} aria-label="Next invoice date" /></label>
            <label className="text-[10px] text-outline">Stop after (optional)<input type="date" className={`${input} w-full mt-0.5`} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} aria-label="End date" /></label>
            <label className="text-[10px] text-outline">Due after (days)<input className={`${input} w-full mt-0.5`} inputMode="numeric" value={form.termsDays} onChange={(e) => setForm({ ...form, termsDays: e.target.value.replace(/[^0-9]/g, '') })} aria-label="Payment terms days" /></label>
            <label className="text-[10px] text-outline col-span-2 md:col-span-3">Notes on the invoice<input className={`${input} w-full mt-0.5`} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} aria-label="Notes" /></label>
          </div>
          <table className="w-full text-xs"><tbody>{form.lines.map((l, i) => {
            const up = (k: keyof L, v: string) => setForm({ ...form, lines: form.lines.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });
            return (
              <tr key={i}>
                <td className="pr-1 py-0.5"><input className={`${input} w-28 font-mono`} value={l.partNumber} onChange={(e) => up('partNumber', e.target.value)} placeholder="Code (optional)" aria-label="Code" /></td>
                <td className="pr-1 py-0.5"><input className={`${input} w-full`} value={l.description} onChange={(e) => up('description', e.target.value)} placeholder="Description" aria-label="Description" /></td>
                <td className="pr-1 py-0.5"><input className={`${input} w-16 font-mono`} inputMode="decimal" value={l.quantity} onChange={(e) => up('quantity', e.target.value)} aria-label="Quantity" /></td>
                <td className="pr-1 py-0.5"><input className={`${input} w-24 font-mono`} inputMode="decimal" value={l.unitPrice} onChange={(e) => up('unitPrice', e.target.value)} placeholder="Unit price" aria-label="Unit price" /></td>
                <td className="pr-1 py-0.5"><select className={input} value={l.taxRateId} onChange={(e) => up('taxRateId', e.target.value)} aria-label="Tax rate"><option value="">No tax</option>{taxRates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></td>
                <td><button type="button" aria-label="Remove line" className="p-1 text-error" onClick={() => setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) })}><Trash2 className="w-3.5 h-3.5" /></button></td>
              </tr>
            );
          })}</tbody></table>
          <div className="flex justify-between">
            <button type="button" className="text-primary text-xs inline-flex items-center gap-1" onClick={() => setForm({ ...form, lines: [...form.lines, blankLine()] })}><Plus className="w-3 h-3" /> Add a line</button>
            <div className="flex gap-sm"><SecondaryButton type="button" onClick={() => setForm(null)}>Cancel</SecondaryButton><PrimaryButton type="button" onClick={() => void save()} icon={<CalendarSync className="w-3.5 h-3.5" />}>Save</PrimaryButton></div>
          </div>
        </div>
      )}
      {!list ? <Loader2 className="w-4 h-4 animate-spin" /> : list.length === 0 ? <p className="text-xs text-on-surface-variant italic">No recurring invoices yet.</p> : (
        <table className="w-full text-left text-xs rounded-xl border border-outline-variant">
          <thead><tr className="text-[10px] text-outline uppercase tracking-wider bg-surface-container-high/30"><th className="px-md py-2">Name</th><th className="px-md py-2">Customer</th><th className="px-md py-2">How often</th><th className="px-md py-2">Next</th><th className="px-md py-2 text-right">Each (excl. tax)</th><th className="px-md py-2">Made</th><th className="px-md py-2" /></tr></thead>
          <tbody className="divide-y divide-outline-variant/30">{list.map((r) => (
            <tr key={r.id} className={r.active ? '' : 'opacity-50'}>
              <td className="px-md py-2 font-bold">{r.name}</td><td className="px-md py-2">{r.client_name}</td>
              <td className="px-md py-2">{r.every > 1 ? `Every ${r.every} ${FREQ.find((f) => f[0] === r.frequency)?.[2]}` : FREQ.find((f) => f[0] === r.frequency)?.[1]}{r.end_date ? `, until ${when(r.end_date)}` : ''}</td>
              <td className="px-md py-2">{r.active ? when(r.next_date) : 'stopped'}</td>
              <td className="px-md py-2 text-right font-mono">{r.currency === 'ZAR' ? fmtZAR(total(r.lines)) : `${r.currency} ${total(r.lines).toFixed(2)}`}</td>
              <td className="px-md py-2 text-outline">{fmtNumber(r.invoices_made)}{r.last_invoice_number ? ` · last ${r.last_invoice_number}` : ''}</td>
              <td className="px-md py-2 text-right whitespace-nowrap">{may && <>
                <button type="button" aria-label={`Edit ${r.name}`} className="p-1.5 rounded hover:bg-surface-container-high" onClick={() => edit(r)}><Pencil className="w-3.5 h-3.5" /></button>
                <button type="button" className="px-2 py-0.5 text-[10px] rounded hover:bg-surface-container-high" onClick={async () => { try { await api(`/api/recurring-invoices/${r.id}`, { method: 'PUT', body: JSON.stringify({ active: !r.active }) }); await load(); } catch (e: any) { triggerToast(e.message, 'ERROR'); } }}>{r.active ? 'Pause' : 'Resume'}</button>
                <button type="button" aria-label={`Delete ${r.name}`} className="p-1.5 rounded hover:bg-error/10 text-error" onClick={async () => { if (await confirmDialog({ title: 'Delete', message: `Delete "${r.name}"? Invoices it already made stay.`, confirmLabel: 'Delete', destructive: true })) { try { await api(`/api/recurring-invoices/${r.id}`, { method: 'DELETE' }); await load(); } catch (e: any) { triggerToast(e.message, 'ERROR'); } } }}><Trash2 className="w-3.5 h-3.5" /></button>
              </>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
};
