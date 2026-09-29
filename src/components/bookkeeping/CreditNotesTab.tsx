// Credit notes surface. Lists every CN (DRAFT / ISSUED / APPLIED /
// REFUNDED), lets the operator open one to view + apply against
// another invoice or refund the remaining balance. Fresh CNs are
// created from the invoice viewer (see InvoicesTab); this tab is the
// after-the-fact management surface.

import React, { useEffect, useState } from 'react';
import { Eye, Trash2, Download, FileText, Wallet } from 'lucide-react';
import {
  ModuleDataProps, Modal, StatusPill, fmtMoney, fmtDate,
  apiGet, apiPost,
  PrimaryButton, SecondaryButton, DangerButton, FieldLabel, inputClass, selectClass, EmptyState, SectionCard,
} from './shared';
import { buildAndSaveDocPdf } from '../../lib/pdfDocs';

export const CreditNotesTab: React.FC<ModuleDataProps> = ({ triggerToast, invoices, accounts }) => {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<any | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const list = await apiGet('/api/credit-notes');
      setRows(Array.isArray(list) ? list : []);
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to load credit notes', 'ERROR');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const open = async (id: number) => {
    try {
      const full = await apiGet(`/api/credit-notes/${id}`);
      setViewing(full);
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to load credit note', 'ERROR');
    }
  };

  return (
    <div className="space-y-4">
      <SectionCard title="Credit Notes" badge={`${rows.length} note${rows.length === 1 ? '' : 's'}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">CN #</th>
                <th className="px-lg py-sm">Client</th>
                <th className="px-lg py-sm">Against</th>
                <th className="px-lg py-sm">Date</th>
                <th className="px-lg py-sm text-right">Total</th>
                <th className="px-lg py-sm text-right">Remaining</th>
                <th className="px-lg py-sm">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {rows.map(r => (
                <tr key={r.id} className="hover:bg-surface-variant/20 cursor-pointer" onClick={() => open(r.id)}>
                  <td className="px-lg py-sm font-mono text-primary font-bold">{r.creditNoteNumber}</td>
                  <td className="px-lg py-sm">{r.clientName || '—'}</td>
                  <td className="px-lg py-sm font-mono text-outline text-[11px]">{r.invoiceNumber || '—'}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(r.creditDate)}</td>
                  <td className="px-lg py-sm text-right font-mono font-bold">{fmtMoney(r.total, r.currency)}</td>
                  <td className={`px-lg py-sm text-right font-mono ${r.remaining > 0.005 ? 'text-tertiary font-bold' : 'text-outline'}`}>{fmtMoney(r.remaining, r.currency)}</td>
                  <td className="px-lg py-sm"><StatusPill status={r.status} /></td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <EmptyState message="No credit notes yet. Create one from an invoice's viewer (Issue Credit Note button)." colSpan={7} />
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {viewing && (
        <ViewModal
          cn={viewing}
          invoices={invoices}
          accounts={accounts || []}
          onClose={() => setViewing(null)}
          onChanged={async () => { const full = await apiGet(`/api/credit-notes/${viewing.id}`); setViewing(full); await load(); }}
          triggerToast={triggerToast}
        />
      )}
    </div>
  );
};

const ViewModal: React.FC<{
  cn: any;
  invoices: any[];
  accounts: any[];
  onClose: () => void;
  onChanged: () => void;
  triggerToast: (m: string, t?: any) => void;
}> = ({ cn, invoices, accounts, onClose, onChanged, triggerToast }) => {
  const [busy, setBusy] = useState(false);
  const [applyInv, setApplyInv] = useState<string>('');
  const [applyAmt, setApplyAmt] = useState<string>(String(cn.remaining ?? 0));
  const [refundAmt, setRefundAmt] = useState<string>(String(cn.remaining ?? 0));
  const [refundAccount, setRefundAccount] = useState<string>('');

  const bankAccounts = accounts.filter(a => a.type === 'ASSET' && (a.subtype === 'BANK' || a.subtype === 'CASH' || /bank|cash/i.test(a.name || '')));

  const doIssue = async () => {
    setBusy(true);
    try {
      const r = await apiPost(`/api/credit-notes/${cn.id}/issue`, {});
      triggerToast(`Issued ${cn.creditNoteNumber}${r.autoApplied ? ` — auto-applied ${r.autoApplied.toFixed(2)}` : ''}.`);
      onChanged();
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to issue', 'ERROR');
    } finally {
      setBusy(false);
    }
  };
  const doApply = async () => {
    if (!applyInv || !(Number(applyAmt) > 0)) { triggerToast('Pick an invoice and enter an amount.', 'ERROR'); return; }
    setBusy(true);
    try {
      await apiPost(`/api/credit-notes/${cn.id}/apply`, { invoiceId: Number(applyInv), amount: Number(applyAmt) });
      triggerToast(`Applied ${Number(applyAmt).toFixed(2)} against invoice.`);
      onChanged();
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to apply', 'ERROR');
    } finally {
      setBusy(false);
    }
  };
  const doRefund = async () => {
    if (!refundAccount || !(Number(refundAmt) > 0)) { triggerToast('Pick a bank account and enter an amount.', 'ERROR'); return; }
    setBusy(true);
    try {
      await apiPost(`/api/credit-notes/${cn.id}/refund`, { amount: Number(refundAmt), bankAccountId: Number(refundAccount) });
      triggerToast(`Refund of ${Number(refundAmt).toFixed(2)} recorded.`);
      onChanged();
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to refund', 'ERROR');
    } finally {
      setBusy(false);
    }
  };
  const savePdf = async () => {
    try {
      await buildAndSaveDocPdf({
        docType: 'Credit Note',
        docNumber: cn.creditNoteNumber,
        currency: cn.currency,
        meta: [
          { label: 'Client', value: cn.clientName || '—' },
          { label: 'Against invoice', value: cn.invoiceNumber || '—' },
          { label: 'Credit date', value: fmtDate(cn.creditDate) },
          { label: 'Status', value: cn.status },
          { label: 'Reason', value: cn.reason || '—' },
          { label: 'Remaining', value: fmtMoney(cn.remaining, cn.currency) },
        ],
        lines: (cn.items || []).map((it: any) => ({
          partNumber: it.partNumber,
          description: it.description + (it.restock ? '  [restock]' : ''),
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          lineTotal: it.lineTotal,
        })),
        totals: { subtotal: cn.subtotal, tax: cn.taxTotal, total: cn.total, amountPaid: cn.amountApplied + cn.amountRefunded, balanceDue: cn.remaining },
        notes: cn.notes,
      });
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to save PDF', 'ERROR');
    }
  };

  const openInvoices = invoices.filter((i: any) => i.clientId === cn.clientId && ['SENT', 'PARTIAL', 'OVERDUE'].includes(i.status) && (i.balanceDue || 0) > 0.005);

  return (
    <Modal title={cn.creditNoteNumber} subtitle={`${cn.clientName || ''} · ${fmtDate(cn.creditDate)}`} onClose={onClose} maxWidth="max-w-3xl">
      <div className="flex items-center gap-2 mb-md flex-wrap">
        <StatusPill status={cn.status} />
        {cn.invoiceNumber && <span className="text-[10px] text-outline">Against invoice <span className="font-mono text-primary font-bold">{cn.invoiceNumber}</span></span>}
        {cn.reason && <span className="text-[10px] text-outline">· Reason: {cn.reason}</span>}
      </div>

      <div className="rounded-lg border border-outline-variant/40 mb-md overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="bg-surface-container-high/50 text-outline text-[10px] uppercase">
              <th className="py-2 px-3">Description</th>
              <th className="py-2 px-3 text-right">Qty</th>
              <th className="py-2 px-3 text-right">Unit</th>
              <th className="py-2 px-3 text-right">Line total</th>
              <th className="py-2 px-3 text-center">Restock</th>
            </tr>
          </thead>
          <tbody>
            {(cn.items || []).map((it: any) => (
              <tr key={it.id} className="border-t border-outline-variant/20">
                <td className="py-2 px-3">{it.partNumber && <span className="font-mono text-[10px] text-outline mr-1">{it.partNumber}</span>}{it.description}</td>
                <td className="py-2 px-3 text-right font-mono">{it.quantity}</td>
                <td className="py-2 px-3 text-right font-mono">{fmtMoney(it.unitPrice, cn.currency)}</td>
                <td className="py-2 px-3 text-right font-mono font-bold">{fmtMoney(it.lineTotal, cn.currency)}</td>
                <td className="py-2 px-3 text-center">{it.restock ? '✓' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end gap-6 text-xs mb-md">
        <div className="space-y-1 w-56">
          <div className="flex justify-between"><span className="text-outline">Subtotal</span><span className="font-mono">{fmtMoney(cn.subtotal, cn.currency)}</span></div>
          <div className="flex justify-between"><span className="text-outline">Tax</span><span className="font-mono">{fmtMoney(cn.taxTotal, cn.currency)}</span></div>
          <div className="flex justify-between font-bold border-t border-outline-variant/30 pt-1"><span>Total</span><span className="font-mono text-primary">{fmtMoney(cn.total, cn.currency)}</span></div>
          <div className="flex justify-between text-green-400"><span>Applied</span><span className="font-mono">{fmtMoney(cn.amountApplied, cn.currency)}</span></div>
          <div className="flex justify-between text-green-400"><span>Refunded</span><span className="font-mono">{fmtMoney(cn.amountRefunded, cn.currency)}</span></div>
          <div className="flex justify-between font-bold border-t border-outline-variant/30 pt-1"><span>Remaining</span><span className={`font-mono ${cn.remaining > 0.005 ? 'text-tertiary' : ''}`}>{fmtMoney(cn.remaining, cn.currency)}</span></div>
        </div>
      </div>

      {cn.allocations?.length > 0 && (
        <div className="mb-md">
          <div className="text-xs font-bold text-outline uppercase mb-1">Applied against</div>
          <div className="space-y-1">
            {cn.allocations.map((a: any) => (
              <div key={a.id} className="flex items-center justify-between text-xs bg-surface-container-low border border-outline-variant/40 rounded px-3 py-1.5">
                <span><span className="font-mono text-primary font-bold">{a.invoiceNumber}</span> · {fmtDate(a.appliedAt)}</span>
                <span className="font-mono font-bold">{fmtMoney(a.amountApplied, cn.currency)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(cn.status === 'ISSUED' || cn.status === 'APPLIED') && cn.remaining > 0.005 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-md mb-md">
          <div className="p-3 rounded-lg border border-outline-variant/40 bg-surface-container-low space-y-2">
            <div className="text-xs font-bold text-outline uppercase">Apply against another invoice</div>
            <select className={selectClass} value={applyInv} onChange={(e) => setApplyInv(e.target.value)}>
              <option value="">— Select open invoice —</option>
              {openInvoices.map((i: any) => (
                <option key={i.id} value={i.id}>{i.invoiceNumber} · balance {fmtMoney(i.balanceDue, cn.currency)}</option>
              ))}
            </select>
            <input type="number" step="0.01" className={`${inputClass} font-mono text-right`} value={applyAmt} onChange={(e) => setApplyAmt(e.target.value)} />
            <PrimaryButton onClick={doApply} disabled={busy}>Apply</PrimaryButton>
          </div>
          <div className="p-3 rounded-lg border border-outline-variant/40 bg-surface-container-low space-y-2">
            <div className="text-xs font-bold text-outline uppercase">Refund cash</div>
            <select className={selectClass} value={refundAccount} onChange={(e) => setRefundAccount(e.target.value)}>
              <option value="">— From bank account —</option>
              {bankAccounts.map((a: any) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
            </select>
            <input type="number" step="0.01" className={`${inputClass} font-mono text-right`} value={refundAmt} onChange={(e) => setRefundAmt(e.target.value)} />
            <PrimaryButton icon={<Wallet className="w-3.5 h-3.5" />} onClick={doRefund} disabled={busy}>Record refund</PrimaryButton>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-md border-t border-outline-variant/20">
        <SecondaryButton icon={<Download className="w-3.5 h-3.5" />} onClick={savePdf}>Save PDF</SecondaryButton>
        {cn.status === 'DRAFT' && (
          <PrimaryButton onClick={doIssue} disabled={busy}>Issue credit note</PrimaryButton>
        )}
      </div>
    </Modal>
  );
};
