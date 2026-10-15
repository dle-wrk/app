// Bookkeeping > Sales > Potential Orders: work a client may still go ahead
// with, kept out of the books and off the overdue / outstanding lists. Open
// ones show their expected decision date, likelihood and reason; each ends
// Won (a quotation, sales order or draft invoice) or Lost. Server:
// src/lib/potentialOrdersRoutes.ts; totals: src/lib/potentialOrders.ts.

import React, { useEffect, useMemo, useState } from 'react';
import { Hourglass, Plus, Trophy, XCircle, AlertTriangle } from 'lucide-react';
import { ModuleDataProps, Modal, FieldLabel, PrimaryButton, SecondaryButton, DangerButton, CreateButton, inputClass, selectClass, apiGet, apiPost, apiPut, fmtMoney, fmtDate, todayISO } from './shared';
import { LineItemsEditor, EditableLine, newEditableLine, lineTotals } from './LineItemsEditor';
import { canChange } from '../../lib/changeAccess';
import { confirmDialog } from '../../lib/confirmDialog';
import { fmtNumber, fmtZAR } from '../../lib/formatMoney';
import { LIKELIHOODS, pipelineTotals, type PotentialLine, type WinTarget } from '../../lib/potentialOrders';

interface Potential {
  id: number; number: string; clientId: number | null; clientName: string | null; currency: string; lines: PotentialLine[];
  subtotal: number; taxTotal: number; total: number; notes: string | null; expectedDate: string | null; likelihoodPct: number | null;
  reason: string | null; status: 'OPEN' | 'WON' | 'LOST'; outcomeReason: string | null; outcomeAt: string | null;
  outcomeDocType: string | null; outcomeDocNumber: string | null; sourceType: string; sourceNumber: string | null;
  createdBy: string | null; createdAt: string;
}

const SOURCE: Record<string, string> = { new: 'New', invoice: 'From invoice', sales_order: 'From sales order', quotation: 'From quotation' };
const toEditable = (lines: PotentialLine[]): EditableLine[] => lines.map((l) => ({ ...newEditableLine(), partNumber: l.partNumber || undefined, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRateId: l.taxRateId, taxInclusive: l.taxInclusive }));
const fromEditable = (lines: EditableLine[]): PotentialLine[] => lines.filter((l) => l.description.trim() && l.quantity > 0)
  .map((l) => ({ partNumber: l.partNumber?.trim() || null, description: l.description.trim(), quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) || 0, taxRateId: l.taxRateId ?? null, taxInclusive: !!l.taxInclusive }));

export const PotentialOrdersTab: React.FC<ModuleDataProps> = (props) => {
  const { clients, items, taxRates, triggerToast, refresh } = props;
  const [rows, setRows] = useState<Potential[] | null>(null);
  const [filter, setFilter] = useState<'OPEN' | 'WON' | 'LOST' | 'ALL'>('OPEN');
  const [viewing, setViewing] = useState<Potential | null>(null);
  const [creating, setCreating] = useState(false);
  const today = todayISO();

  const load = async () => {
    try { setRows(await apiGet('/api/potential-orders')); } catch (e: any) { triggerToast(e?.message || 'Could not load potential orders.', 'ERROR'); setRows([]); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const totals = useMemo(() => pipelineTotals(rows ?? [], today), [rows, today]);
  const shown = (rows ?? []).filter((r) => filter === 'ALL' || r.status === filter);

  return (
    <div className="space-y-md" data-testid="potential-orders">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-md">
        <div className="max-w-[720px]">
          <h3 className="text-lg font-bold text-on-surface flex items-center gap-2"><Hourglass className="w-5 h-5 text-primary" /> Potential Orders</h3>
          <p className="text-xs text-on-surface-variant mt-1">
            Work a client may still go ahead with, kept out of the books and off the overdue and outstanding lists. Move an invoice, sales order or quote here from its window, or start one here.
            When the client decides, confirm it as a quote, sales order or invoice, or mark it lost.
          </p>
        </div>
        <CreateButton path="/api/potential-orders" type="button" icon={<Plus className="w-4 h-4" />} onClick={() => setCreating(true)}>New potential order</CreateButton>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-sm">
        {[
          ['Open', fmtNumber(totals.count)],
          ['Open value', fmtZAR(totals.total)],
          ['Weighted by likelihood', fmtZAR(totals.weighted)],
          ['Decision due', fmtNumber(totals.decisionDue)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-outline-variant bg-surface-container p-sm">
            <div className="text-[10px] uppercase text-outline font-bold">{label}</div>
            <div className={`text-lg font-black font-mono ${label === 'Decision due' && totals.decisionDue ? 'text-amber-500' : 'text-on-surface'}`}>{value}</div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-outline -mt-2">Values in each order's own currency are added as-is; most are in rand. Weighted counts an order with no likelihood at 50%.</p>

      <div className="flex gap-1" role="group" aria-label="Show">
        {(['OPEN', 'WON', 'LOST', 'ALL'] as const).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f}
            className={`text-[10px] font-bold px-2 py-1 rounded border ${filter === f ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-high border-outline-variant text-on-surface-variant'}`}>{f === 'ALL' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}</button>
        ))}
      </div>

      {!rows ? <p className="text-xs text-outline">Loading…</p> : shown.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-outline-variant/40 p-lg text-center text-sm text-on-surface-variant">
          {filter === 'OPEN' ? 'No open potential orders.' : 'Nothing here.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-outline-variant">
          <table className="w-full text-xs">
            <thead className="bg-surface-container-high text-[10px] uppercase text-outline">
              <tr>
                <th className="text-left px-3 py-2">Number</th><th className="text-left px-3 py-2">Client</th><th className="text-left px-3 py-2">From</th>
                <th className="text-right px-3 py-2">Total</th><th className="text-right px-3 py-2">Likelihood</th><th className="text-left px-3 py-2">Decision by</th><th className="text-left px-3 py-2">Reason / outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {shown.map((r) => {
                const late = r.status === 'OPEN' && r.expectedDate && r.expectedDate <= today;
                return (
                  <tr key={r.id} className="hover:bg-surface-variant/20 cursor-pointer" onClick={() => setViewing(r)} data-testid={`potential-${r.id}`}>
                    <td className="px-3 py-2 font-mono font-bold text-primary">{r.number}</td>
                    <td className="px-3 py-2">{r.clientName || '—'}</td>
                    <td className="px-3 py-2 text-on-surface-variant">{SOURCE[r.sourceType] ?? r.sourceType}{r.sourceNumber ? ` ${r.sourceNumber}` : ''}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmtMoney(r.total, r.currency)}</td>
                    <td className="px-3 py-2 text-right">{r.likelihoodPct != null ? `${r.likelihoodPct}%` : '—'}</td>
                    <td className={`px-3 py-2 ${late ? 'text-amber-500 font-bold' : ''}`}>{r.expectedDate ? fmtDate(r.expectedDate) : '—'}{late ? ' (due)' : ''}</td>
                    <td className="px-3 py-2 text-on-surface-variant">
                      {r.status === 'WON' ? <span className="text-green-500">Won: {r.outcomeDocNumber}</span> : r.status === 'LOST' ? <span className="text-error">Lost: {r.outcomeReason}</span> : r.reason || '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {viewing && (
        <PotentialModal
          potential={viewing} clients={clients} items={items} taxRates={taxRates}
          onClose={() => setViewing(null)}
          onChanged={async (msg) => { triggerToast(msg, 'SUCCESS'); setViewing(null); await load(); await refresh(); }}
          onError={(m) => triggerToast(m, 'ERROR')}
        />
      )}
      {creating && (
        <PotentialModal
          potential={null} clients={clients} items={items} taxRates={taxRates}
          onClose={() => setCreating(false)}
          onChanged={async (msg) => { triggerToast(msg, 'SUCCESS'); setCreating(false); await load(); }}
          onError={(m) => triggerToast(m, 'ERROR')}
        />
      )}
    </div>
  );
};

const PotentialModal: React.FC<{
  potential: Potential | null;
  clients: ModuleDataProps['clients'];
  items: ModuleDataProps['items'];
  taxRates: ModuleDataProps['taxRates'];
  onClose: () => void;
  onChanged: (msg: string) => void;
  onError: (msg: string) => void;
}> = ({ potential, clients, items, taxRates, onClose, onChanged, onError }) => {
  const p = potential;
  const open = !p || p.status === 'OPEN';
  const mayChange = canChange('/api/potential-orders', 'POST') && open;
  const [clientId, setClientId] = useState<string>(p?.clientId != null ? String(p.clientId) : '');
  const [currency, setCurrency] = useState(p?.currency || 'ZAR');
  const [expectedDate, setExpectedDate] = useState(p?.expectedDate || '');
  const [likelihood, setLikelihood] = useState<string>(p?.likelihoodPct != null ? String(p.likelihoodPct) : '50');
  const [reason, setReason] = useState(p?.reason || '');
  const [notes, setNotes] = useState(p?.notes || '');
  const [lines, setLines] = useState<EditableLine[]>(() => (p ? toEditable(p.lines) : [newEditableLine()]));
  const [lostReason, setLostReason] = useState('');
  const [losing, setLosing] = useState(false);
  const [busy, setBusy] = useState(false);

  const totals = lines.reduce((t, l) => { const x = lineTotals(l, taxRates); return { sub: t.sub + x.base, tax: t.tax + x.taxAmount }; }, { sub: 0, tax: 0 });

  const payload = () => ({
    clientId: clientId ? Number(clientId) : undefined, currency, expectedDate: expectedDate || null,
    likelihoodPct: likelihood ? Number(likelihood) : null, reason: reason.trim() || null, notes: notes.trim() || null, lines: fromEditable(lines),
  });

  const save = async () => {
    if (!clientId) { onError('Choose the client.'); return; }
    if (!fromEditable(lines).length) { onError('Add at least one line.'); return; }
    setBusy(true);
    try {
      if (p) { await apiPut(`/api/potential-orders/${p.id}`, payload()); onChanged(`${p.number} saved.`); }
      else { const r = await apiPost('/api/potential-orders', payload()); onChanged(`Potential order ${r.number} created.`); }
    } catch (e: any) { onError(e?.message || 'Could not save it.'); } finally { setBusy(false); }
  };

  const win = async (as: WinTarget) => {
    if (!p) return;
    const label = as === 'invoice' ? 'a draft invoice' : as === 'quotation' ? 'a quotation' : 'a sales order';
    const extra = as === 'sales_order' ? ' Stock is reserved for it.' : as === 'invoice' ? ' It is a draft: check it, then Finalize & Send to put it in the books.' : '';
    if (!(await confirmDialog({ title: 'Confirm the order', message: `Turn ${p.number} into ${label} with these lines?${extra}`, confirmLabel: 'Confirm' }))) return;
    setBusy(true);
    try {
      await apiPut(`/api/potential-orders/${p.id}`, payload()); // keep edits made here
      const r = await apiPost(`/api/potential-orders/${p.id}/won`, { as });
      onChanged(`${p.number} won: now ${label.replace(/^an? /, '')} ${r.outcomeDocNumber}.`);
    } catch (e: any) { onError(e?.message || 'Could not confirm it.'); } finally { setBusy(false); }
  };

  const lose = async () => {
    if (!p) return;
    if (!lostReason.trim()) { onError('Say why it was lost.'); return; }
    setBusy(true);
    try { await apiPost(`/api/potential-orders/${p.id}/lost`, { reason: lostReason.trim() }); onChanged(`${p.number} marked lost.`); }
    catch (e: any) { onError(e?.message || 'Could not mark it lost.'); } finally { setBusy(false); }
  };

  return (
    <Modal title={p ? p.number : 'New potential order'} subtitle={p ? `${SOURCE[p.sourceType] ?? ''}${p.sourceNumber ? ` ${p.sourceNumber}` : ''} · created ${fmtDate(p.createdAt)}${p.createdBy ? ` by ${p.createdBy}` : ''}` : 'Kept out of the books until the client confirms.'} onClose={onClose} maxWidth="max-w-4xl">
      {p && p.status !== 'OPEN' && (
        <div className={`mb-md rounded-lg border p-2 text-xs ${p.status === 'WON' ? 'border-green-500/30 bg-green-500/10 text-green-500' : 'border-error/30 bg-error/10 text-error'}`}>
          {p.status === 'WON' ? `Won${p.outcomeAt ? ` on ${fmtDate(p.outcomeAt)}` : ''}: now ${p.outcomeDocNumber}.` : `Lost${p.outcomeAt ? ` on ${fmtDate(p.outcomeAt)}` : ''}: ${p.outcomeReason}`}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-md">
        <div className="md:col-span-2"><FieldLabel>Client</FieldLabel>
          <select className={selectClass} value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={!mayChange} aria-label="Client">
            <option value="">Select a client…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.clientName}</option>)}
          </select></div>
        <div><FieldLabel>Currency</FieldLabel>
          <select className={selectClass} value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={!mayChange} aria-label="Currency">
            {['ZAR', 'USD', 'EUR', 'GBP'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select></div>
        <div><FieldLabel>Expected decision</FieldLabel><input type="date" className={inputClass} value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} disabled={!mayChange} aria-label="Expected decision date" /></div>
        <div><FieldLabel>Likelihood</FieldLabel>
          <select className={selectClass} value={likelihood} onChange={(e) => setLikelihood(e.target.value)} disabled={!mayChange} aria-label="Likelihood">
            <option value="">Not sure</option>
            {LIKELIHOODS.map((l) => <option key={l} value={l}>{l}%</option>)}
          </select></div>
        <div><FieldLabel>Reason</FieldLabel><input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} disabled={!mayChange} placeholder="e.g. Waiting on budget approval" aria-label="Reason" /></div>
        <div className="md:col-span-3"><FieldLabel>Notes</FieldLabel><input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!mayChange} aria-label="Notes" /></div>
      </div>

      <div className="mt-md">
        <FieldLabel>Lines</FieldLabel>
        {mayChange ? (
          <LineItemsEditor lines={lines} onChange={setLines} items={items} taxRates={taxRates} mode="SALES" currency={currency}
            packages={{ clientId: clientId ? Number(clientId) : null, onNotes: (n) => setNotes((prev) => (prev.includes(n) ? prev : prev.trim() ? `${prev.trim()}\n${n}` : n)), notify: (m, t) => (t === 'ERROR' ? onError(m) : undefined) }} />
        ) : (
          <table className="w-full text-xs rounded border border-outline-variant">
            <tbody className="divide-y divide-outline-variant/30">
              {(p?.lines ?? []).map((l, i) => (
                <tr key={i}><td className="px-2 py-1">{l.description}{l.partNumber ? <span className="block text-[10px] font-mono text-primary">{l.partNumber}</span> : null}</td>
                  <td className="px-2 py-1 text-right">{fmtNumber(l.quantity)}</td><td className="px-2 py-1 text-right font-mono">{fmtMoney(l.unitPrice, p!.currency)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex justify-end mt-md">
        <div className="w-64 space-y-1 text-xs">
          <div className="flex justify-between"><span>Subtotal</span><span className="font-mono">{fmtMoney(totals.sub, currency)}</span></div>
          <div className="flex justify-between text-on-surface-variant"><span>Tax</span><span className="font-mono">{fmtMoney(totals.tax, currency)}</span></div>
          <div className="flex justify-between font-bold text-sm border-t border-outline-variant/40 pt-1"><span>Total</span><span className="font-mono text-primary">{fmtMoney(totals.sub + totals.tax, currency)}</span></div>
        </div>
      </div>

      {mayChange && (
        <div className="mt-md pt-md border-t border-outline-variant/40 space-y-sm">
          <div className="flex flex-wrap gap-2 justify-end">
            <SecondaryButton type="button" onClick={onClose} disabled={busy}>Close</SecondaryButton>
            {p && <DangerButton type="button" icon={<XCircle className="w-3.5 h-3.5" />} onClick={() => setLosing((v) => !v)} disabled={busy}>Mark lost</DangerButton>}
            <PrimaryButton type="button" onClick={() => void save()} disabled={busy}>{p ? 'Save' : 'Create'}</PrimaryButton>
          </div>
          {p && losing && (
            <div className="flex flex-wrap items-center gap-2 justify-end text-xs">
              <input className={`${inputClass} py-1.5 text-xs max-w-sm`} value={lostReason} onChange={(e) => setLostReason(e.target.value)} placeholder="Why was it lost? e.g. Went with a competitor" aria-label="Lost reason" />
              <DangerButton type="button" onClick={() => void lose()} disabled={busy}>Confirm lost</DangerButton>
            </div>
          )}
          {p && (
            <div className="flex flex-wrap items-center gap-2 justify-end">
              <span className="text-[11px] text-outline flex items-center gap-1"><Trophy className="w-3.5 h-3.5 text-green-500" /> Client confirmed? Turn it into:</span>
              <SecondaryButton type="button" onClick={() => void win('quotation')} disabled={busy}>Quotation</SecondaryButton>
              <SecondaryButton type="button" onClick={() => void win('sales_order')} disabled={busy}>Sales order</SecondaryButton>
              <PrimaryButton type="button" onClick={() => void win('invoice')} disabled={busy}>Invoice (draft)</PrimaryButton>
            </div>
          )}
          {p?.sourceType === 'invoice' && (
            <p className="text-[10px] text-outline flex items-center gap-1 justify-end"><AlertTriangle className="w-3 h-3" /> The original invoice {p.sourceNumber} stays void; confirming makes a new one.</p>
          )}
        </div>
      )}
    </Modal>
  );
};
