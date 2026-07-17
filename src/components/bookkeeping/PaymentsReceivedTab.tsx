import React, { useMemo, useState } from 'react';
import { Plus, Ban, Eye } from 'lucide-react';
import { PaymentReceived } from '../../types';
import { ModuleDataProps, Modal, StatusPill, fmtMoney, fmtDate, todayISO, apiPost, apiGet, PrimaryButton, SecondaryButton, DangerButton, FieldLabel, inputClass, selectClass, EmptyState, SectionCard } from './shared';

export const PaymentsReceivedTab: React.FC<ModuleDataProps> = (props) => {
  const { paymentsReceived, triggerToast, refresh } = props;
  const [showCreate, setShowCreate] = useState(false);
  const [viewing, setViewing] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const total = useMemo(() => paymentsReceived.reduce((s, p) => s + p.amount, 0), [paymentsReceived]);

  const openView = async (p: PaymentReceived) => {
    try {
      const full = await apiGet(`/api/payments-received/${p.id}`);
      setViewing(full);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load payment', 'ERROR');
    }
  };

  const handleVoid = async (id: number) => {
    if (!confirm('Void this payment? This un-applies it from any invoices and reverses the ledger entry.')) return;
    setBusy(true);
    try {
      await apiPost(`/api/payments-received/${id}/void`);
      triggerToast('Payment voided.');
      await refresh();
      setViewing(null);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to void payment', 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <SectionCard
        title="Payments Received"
        badge={`${paymentsReceived.length} receipts · ${fmtMoney(total)} total`}
        actions={<PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setShowCreate(true)}>Record Payment</PrimaryButton>}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">Receipt #</th>
                <th className="px-lg py-sm">Customer</th>
                <th className="px-lg py-sm">Date</th>
                <th className="px-lg py-sm">Method</th>
                <th className="px-lg py-sm text-right">Amount</th>
                <th className="px-lg py-sm text-right">Unallocated</th>
                <th className="px-lg py-sm text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {paymentsReceived.map(p => (
                <tr key={p.id} className="hover:bg-surface-variant/20 transition-all">
                  <td className="px-lg py-sm font-mono text-primary font-bold cursor-pointer" onClick={() => openView(p)}>{p.paymentNumber}</td>
                  <td className="px-lg py-sm font-semibold">{p.clientName || 'Unassigned'}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(p.paymentDate)}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{p.method}</td>
                  <td className="px-lg py-sm text-right font-mono font-bold text-green-400">{fmtMoney(p.amount)}</td>
                  <td className="px-lg py-sm text-right font-mono text-outline">{p.unallocatedAmount > 0 ? fmtMoney(p.unallocatedAmount) : '—'}</td>
                  <td className="px-lg py-sm text-right">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => openView(p)} className="p-1.5 rounded hover:bg-surface-container-high text-on-surface-variant" title="View"><Eye className="w-3.5 h-3.5" /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {paymentsReceived.length === 0 && <EmptyState message="No payments recorded yet." colSpan={7} />}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {showCreate && (
        <CreatePaymentModal {...props} onClose={() => setShowCreate(false)} onSaved={async () => { setShowCreate(false); await refresh(); }} />
      )}

      {viewing && (
        <Modal title={viewing.paymentNumber} subtitle={`${viewing.clientName || 'Unassigned'} · ${fmtDate(viewing.paymentDate)}`} onClose={() => setViewing(null)} maxWidth="max-w-lg">
          <div className="space-y-2 text-xs mb-md">
            <div className="flex justify-between"><span className="text-on-surface-variant">Amount</span><span className="font-mono font-bold">{fmtMoney(viewing.amount)}</span></div>
            <div className="flex justify-between"><span className="text-on-surface-variant">Method</span><span>{viewing.method}</span></div>
            {viewing.reference && <div className="flex justify-between"><span className="text-on-surface-variant">Reference</span><span>{viewing.reference}</span></div>}
          </div>
          <h5 className="text-xs font-bold text-on-surface-variant mb-2">Applied to</h5>
          <div className="space-y-1 mb-md">
            {(viewing.allocations || []).map((a: any) => (
              <div key={a.id} className="flex justify-between text-xs bg-surface-container-low rounded px-3 py-2 border border-outline-variant/30">
                <span className="font-mono text-primary">{a.invoiceNumber}</span>
                <span className="font-mono">{fmtMoney(a.amountApplied)}</span>
              </div>
            ))}
            {(!viewing.allocations || viewing.allocations.length === 0) && <p className="text-xs text-outline italic">Unallocated — not yet applied to an invoice.</p>}
          </div>
          <div className="flex justify-end pt-2 border-t border-outline-variant/20">
            <DangerButton icon={<Ban className="w-3.5 h-3.5" />} onClick={() => handleVoid(viewing.id)} disabled={busy}>Void Payment</DangerButton>
          </div>
        </Modal>
      )}
    </div>
  );
};

const CreatePaymentModal: React.FC<ModuleDataProps & { onClose: () => void; onSaved: () => void }> = ({ clients, invoices, accounts, onClose, onSaved, triggerToast }) => {
  const bankAccounts = accounts.filter(a => a.subtype === 'BANK' || a.subtype === 'CASH');
  const [clientId, setClientId] = useState('');
  const [amount, setAmount] = useState(0);
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [method, setMethod] = useState('EFT');
  const [depositAccountId, setDepositAccountId] = useState(String(bankAccounts[0]?.id || ''));
  const [reference, setReference] = useState('');
  const [allocations, setAllocations] = useState<Record<number, number>>({});
  const [saving, setSaving] = useState(false);

  const openInvoices = invoices.filter(i => clientId ? String(i.clientId) === clientId : false).filter(i => ['SENT', 'PARTIAL', 'OVERDUE'].includes(i.status));
  const allocatedTotal = Object.values(allocations).reduce((s, v) => s + (v || 0), 0);

  const setAlloc = (invoiceId: number, value: number, max: number) => {
    setAllocations(prev => ({ ...prev, [invoiceId]: Math.max(0, Math.min(value, max)) }));
  };

  const submit = async () => {
    if (!depositAccountId) { triggerToast('Choose which account received the funds.', 'ERROR'); return; }
    if (amount <= 0) { triggerToast('Enter an amount greater than zero.', 'ERROR'); return; }
    if (allocatedTotal - amount > 0.005) { triggerToast('Allocated total exceeds the payment amount.', 'ERROR'); return; }
    setSaving(true);
    try {
      await apiPost('/api/payments-received', {
        clientId: clientId ? Number(clientId) : null,
        paymentDate, amount, method, depositAccountId: Number(depositAccountId), reference,
        allocations: Object.entries(allocations).filter(([, v]) => v > 0).map(([invoiceId, amountApplied]) => ({ invoiceId: Number(invoiceId), amountApplied })),
      });
      triggerToast('Payment recorded.');
      onSaved();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to record payment', 'ERROR');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Record Payment Received" subtitle="Allocate the payment across one or more open invoices, or leave unallocated." onClose={onClose} maxWidth="max-w-xl">
      <div className="grid grid-cols-2 gap-3 mb-md">
        <div className="col-span-2">
          <FieldLabel>Customer</FieldLabel>
          <select className={selectClass} value={clientId} onChange={(e) => { setClientId(e.target.value); setAllocations({}); }}>
            <option value="">Select customer</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.clientName}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Amount</FieldLabel>
          <input type="number" min={0.01} step="0.01" className={inputClass} value={amount} onChange={(e) => setAmount(parseFloat(e.target.value) || 0)} />
        </div>
        <div>
          <FieldLabel>Date</FieldLabel>
          <input type="date" className={inputClass} value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
        </div>
        <div>
          <FieldLabel>Method</FieldLabel>
          <select className={selectClass} value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="EFT">EFT</option><option value="CARD">Card</option><option value="CASH">Cash</option><option value="CHEQUE">Cheque</option><option value="OTHER">Other</option>
          </select>
        </div>
        <div>
          <FieldLabel>Deposited to</FieldLabel>
          <select className={selectClass} value={depositAccountId} onChange={(e) => setDepositAccountId(e.target.value)}>
            <option value="">Select account</option>
            {bankAccounts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <FieldLabel>Reference</FieldLabel>
          <input className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
      </div>

      {clientId && (
        <div className="mb-md">
          <h5 className="text-xs font-bold text-on-surface-variant mb-2">Open invoices for this customer</h5>
          {openInvoices.length === 0 && <p className="text-xs text-outline italic">No open invoices — payment will be recorded as unallocated credit.</p>}
          <div className="space-y-1.5">
            {openInvoices.map(inv => (
              <div key={inv.id} className="flex items-center justify-between gap-2 bg-surface-container-low rounded-lg px-3 py-2 border border-outline-variant/30 text-xs">
                <div>
                  <span className="font-mono text-primary font-bold">{inv.invoiceNumber}</span>
                  <span className="block text-outline text-[10px]">Balance due: {fmtMoney(inv.balanceDue, inv.currency)}</span>
                </div>
                <input
                  type="number" min={0} step="0.01"
                  className={`${inputClass} w-28 py-1 text-right`}
                  value={allocations[inv.id] || ''}
                  placeholder="0.00"
                  onChange={(e) => setAlloc(inv.id, parseFloat(e.target.value) || 0, inv.balanceDue)}
                />
              </div>
            ))}
          </div>
          <div className="text-xs text-right mt-2 text-on-surface-variant">Allocated: <span className="font-mono font-bold text-on-surface">{fmtMoney(allocatedTotal)}</span> of {fmtMoney(amount)}</div>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-md border-t border-outline-variant/20">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton onClick={submit} disabled={saving}>{saving ? 'Saving...' : 'Record Payment'}</PrimaryButton>
      </div>
    </Modal>
  );
};
