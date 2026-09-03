import React, { useMemo, useState } from 'react';
import { Plus, Ban, Eye } from 'lucide-react';
import { PaymentMade } from '../../types';
import { ModuleDataProps, Modal, fmtMoney, fmtDate, todayISO, apiPost, apiGet, PrimaryButton, SecondaryButton, DangerButton, FieldLabel, inputClass, selectClass, EmptyState, SectionCard } from './shared';
import { confirmDialog } from '../../lib/confirmDialog';

export const PaymentsMadeTab: React.FC<ModuleDataProps> = (props) => {
  const { paymentsMade, triggerToast, refresh } = props;
  const [showCreate, setShowCreate] = useState(false);
  const [viewing, setViewing] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const total = useMemo(() => paymentsMade.reduce((s, p) => s + p.amount, 0), [paymentsMade]);

  const openView = async (p: PaymentMade) => {
    try {
      const full = await apiGet(`/api/payments-made/${p.id}`);
      setViewing(full);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load payment', 'ERROR');
    }
  };

  const handleVoid = async (id: number) => {
    if (!(await confirmDialog({ title: 'Void payment', message: 'Void this payment? This un-applies it from any bills and reverses the ledger entry.', confirmLabel: 'Void', destructive: true }))) return;
    setBusy(true);
    try {
      await apiPost(`/api/payments-made/${id}/void`);
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
        title="Payments Made"
        badge={`${paymentsMade.length} payments · ${fmtMoney(total)} total`}
        actions={<PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setShowCreate(true)}>Record Payment</PrimaryButton>}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">Payment #</th>
                <th className="px-lg py-sm">Supplier</th>
                <th className="px-lg py-sm">Date</th>
                <th className="px-lg py-sm">Method</th>
                <th className="px-lg py-sm text-right">Amount</th>
                <th className="px-lg py-sm text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {paymentsMade.map(p => (
                <tr key={p.id} className="hover:bg-surface-variant/20 transition-all">
                  <td className="px-lg py-sm font-mono text-primary font-bold cursor-pointer" onClick={() => openView(p)}>{p.paymentNumber}</td>
                  <td className="px-lg py-sm font-semibold">{p.supplierName || p.supplierId || '—'}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(p.paymentDate)}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{p.method}</td>
                  <td className="px-lg py-sm text-right font-mono font-bold text-error">{fmtMoney(p.amount)}</td>
                  <td className="px-lg py-sm text-right">
                    <button onClick={() => openView(p)} className="p-1.5 rounded hover:bg-surface-container-high text-on-surface-variant" title="View"><Eye className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
              {paymentsMade.length === 0 && <EmptyState message="No payments recorded yet." colSpan={6} />}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {showCreate && <CreateBillPaymentModal {...props} onClose={() => setShowCreate(false)} onSaved={async () => { setShowCreate(false); await refresh(); }} />}

      {viewing && (
        <Modal title={viewing.paymentNumber} subtitle={`${viewing.supplierName || viewing.supplierId || '—'} · ${fmtDate(viewing.paymentDate)}`} onClose={() => setViewing(null)} maxWidth="max-w-lg">
          <div className="space-y-2 text-xs mb-md">
            <div className="flex justify-between"><span className="text-on-surface-variant">Amount</span><span className="font-mono font-bold">{fmtMoney(viewing.amount)}</span></div>
            <div className="flex justify-between"><span className="text-on-surface-variant">Method</span><span>{viewing.method}</span></div>
          </div>
          <h5 className="text-xs font-bold text-on-surface-variant mb-2">Applied to</h5>
          <div className="space-y-1 mb-md">
            {(viewing.allocations || []).map((a: any) => (
              <div key={a.id} className="flex justify-between text-xs bg-surface-container-low rounded px-3 py-2 border border-outline-variant/30">
                <span className="font-mono text-primary">{a.billNumber}</span>
                <span className="font-mono">{fmtMoney(a.amountApplied)}</span>
              </div>
            ))}
            {(!viewing.allocations || viewing.allocations.length === 0) && <p className="text-xs text-outline italic">Unallocated.</p>}
          </div>
          <div className="flex justify-end pt-2 border-t border-outline-variant/20">
            <DangerButton icon={<Ban className="w-3.5 h-3.5" />} onClick={() => handleVoid(viewing.id)} disabled={busy}>Void Payment</DangerButton>
          </div>
        </Modal>
      )}
    </div>
  );
};

const CreateBillPaymentModal: React.FC<ModuleDataProps & { onClose: () => void; onSaved: () => void }> = ({ suppliers, bills, accounts, onClose, onSaved, triggerToast }) => {
  const bankAccounts = accounts.filter(a => a.subtype === 'BANK' || a.subtype === 'CASH');
  const [supplierId, setSupplierId] = useState('');
  const [amount, setAmount] = useState(0);
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [method, setMethod] = useState('EFT');
  const [paidFromAccountId, setPaidFromAccountId] = useState(String(bankAccounts[0]?.id || ''));
  const [reference, setReference] = useState('');
  const [allocations, setAllocations] = useState<Record<number, number>>({});
  const [saving, setSaving] = useState(false);

  const openBills = bills.filter(b => supplierId ? b.supplierId === supplierId : false).filter(b => ['AWAITING_PAYMENT', 'PARTIAL', 'OVERDUE'].includes(b.status));
  const allocatedTotal = Object.values(allocations).reduce((s, v) => s + (v || 0), 0);

  const setAlloc = (billId: number, value: number, max: number) => setAllocations(prev => ({ ...prev, [billId]: Math.max(0, Math.min(value, max)) }));

  const submit = async () => {
    if (!paidFromAccountId) { triggerToast('Choose which account to pay from.', 'ERROR'); return; }
    if (amount <= 0) { triggerToast('Enter an amount greater than zero.', 'ERROR'); return; }
    if (allocatedTotal - amount > 0.005) { triggerToast('Allocated total exceeds the payment amount.', 'ERROR'); return; }
    setSaving(true);
    try {
      await apiPost('/api/payments-made', {
        supplierId: supplierId || null, paymentDate, amount, method, paidFromAccountId: Number(paidFromAccountId), reference,
        allocations: Object.entries(allocations).filter(([, v]) => v > 0).map(([billId, amountApplied]) => ({ billId: Number(billId), amountApplied })),
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
    <Modal title="Record Payment Made" subtitle="Allocate the payment across one or more open bills." onClose={onClose} maxWidth="max-w-xl">
      <div className="grid grid-cols-2 gap-3 mb-md">
        <div className="col-span-2">
          <FieldLabel>Supplier</FieldLabel>
          <select className={selectClass} value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setAllocations({}); }}>
            <option value="">Select supplier</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
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
          <FieldLabel>Paid from</FieldLabel>
          <select className={selectClass} value={paidFromAccountId} onChange={(e) => setPaidFromAccountId(e.target.value)}>
            <option value="">Select account</option>
            {bankAccounts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <FieldLabel>Reference</FieldLabel>
          <input className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
      </div>

      {supplierId && (
        <div className="mb-md">
          <h5 className="text-xs font-bold text-on-surface-variant mb-2">Open bills for this supplier</h5>
          {openBills.length === 0 && <p className="text-xs text-outline italic">No open bills.</p>}
          <div className="space-y-1.5">
            {openBills.map(b => (
              <div key={b.id} className="flex items-center justify-between gap-2 bg-surface-container-low rounded-lg px-3 py-2 border border-outline-variant/30 text-xs">
                <div>
                  <span className="font-mono text-primary font-bold">{b.billNumber}</span>
                  <span className="block text-outline text-[10px]">Balance due: {fmtMoney(b.balanceDue, b.currency)}</span>
                </div>
                <input type="number" min={0} step="0.01" className={`${inputClass} w-28 py-1 text-right`} value={allocations[b.id] || ''} placeholder="0.00" onChange={(e) => setAlloc(b.id, parseFloat(e.target.value) || 0, b.balanceDue)} />
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
