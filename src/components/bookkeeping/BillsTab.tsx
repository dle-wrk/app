import React, { useMemo, useState } from 'react';
import { Plus, Send, Ban, Eye, Wallet } from 'lucide-react';
import { Bill, PurchaseOrder } from '../../types';
import { ModuleDataProps, Modal, StatusPill, fmtMoney, fmtDate, todayISO, addDaysISO, apiPost, apiGet, PrimaryButton, SecondaryButton, DangerButton, FieldLabel, inputClass, selectClass, EmptyState, SectionCard } from './shared';
import { LineItemsEditor, EditableLine, newEditableLine } from './LineItemsEditor';
import { ErrorBoundary } from '../ErrorBoundary';

const STATUS_FILTERS = ['ALL', 'DRAFT', 'AWAITING_PAYMENT', 'PARTIAL', 'PAID', 'OVERDUE', 'VOID'];

export const BillsTab: React.FC<ModuleDataProps & { prefillFromPO?: PurchaseOrder | null; onPrefillConsumed?: () => void }> = (props) => {
  const { bills, triggerToast, refresh, prefillFromPO, onPrefillConsumed } = props;
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [showEditor, setShowEditor] = useState(!!prefillFromPO);
  const [viewing, setViewing] = useState<any>(null);
  const [payingBill, setPayingBill] = useState<Bill | null>(null);
  const [busy, setBusy] = useState(false);

  React.useEffect(() => {
    if (prefillFromPO) setShowEditor(true);
  }, [prefillFromPO]);

  const filtered = useMemo(() => bills.filter(b => statusFilter === 'ALL' || b.status === statusFilter), [bills, statusFilter]);
  const totals = useMemo(() => ({
    outstanding: bills.filter(b => ['AWAITING_PAYMENT', 'PARTIAL', 'OVERDUE'].includes(b.status)).reduce((s, b) => s + b.balanceDue, 0),
    overdue: bills.filter(b => b.status === 'OVERDUE').reduce((s, b) => s + b.balanceDue, 0),
  }), [bills]);

  const openView = async (b: Bill) => {
    try {
      const full = await apiGet(`/api/bills/${b.id}`);
      setViewing(full);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load bill', 'ERROR');
    }
  };

  const handleFinalize = async (id: number) => {
    setBusy(true);
    try {
      await apiPost(`/api/bills/${id}/finalize`);
      triggerToast('Bill posted to the ledger.');
      await refresh();
      setViewing(null);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to finalize bill', 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  const handleVoid = async (id: number) => {
    if (!confirm('Void this bill? This posts a reversing journal entry.')) return;
    setBusy(true);
    try {
      await apiPost(`/api/bills/${id}/void`);
      triggerToast('Bill voided.');
      await refresh();
      setViewing(null);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to void bill', 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
          <span className="text-[11px] text-on-surface-variant font-bold block mb-1">Outstanding (AP)</span>
          <span className="text-xl font-black text-primary">{fmtMoney(totals.outstanding)}</span>
        </div>
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
          <span className="text-[11px] text-on-surface-variant font-bold block mb-1">Overdue</span>
          <span className="text-xl font-black text-error">{fmtMoney(totals.overdue)}</span>
        </div>
      </div>

      <SectionCard
        title="Bills"
        actions={
          <>
            <div className="hidden md:flex gap-1">
              {STATUS_FILTERS.map(s => (
                <button key={s} onClick={() => setStatusFilter(s)} className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-colors ${statusFilter === s ? 'bg-primary text-white border-primary' : 'bg-surface-container-high text-on-surface-variant border-outline-variant'}`}>{s.replace('_', ' ')}</button>
              ))}
            </div>
            <PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setShowEditor(true)}>New Bill</PrimaryButton>
          </>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">Bill #</th>
                <th className="px-lg py-sm">Supplier</th>
                <th className="px-lg py-sm">Date</th>
                <th className="px-lg py-sm">Due</th>
                <th className="px-lg py-sm text-right">Total</th>
                <th className="px-lg py-sm text-right">Balance Due</th>
                <th className="px-lg py-sm">Status</th>
                <th className="px-lg py-sm text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {filtered.map(b => (
                <tr key={b.id} className="hover:bg-surface-variant/20 transition-all">
                  <td className="px-lg py-sm font-mono text-primary font-bold cursor-pointer" onClick={() => openView(b)}>{b.billNumber}</td>
                  <td className="px-lg py-sm font-semibold">{b.supplierName || b.supplierId || '—'}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(b.billDate)}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(b.dueDate)}</td>
                  <td className="px-lg py-sm text-right font-mono">{fmtMoney(b.total, b.currency)}</td>
                  <td className="px-lg py-sm text-right font-mono font-bold">{fmtMoney(b.balanceDue, b.currency)}</td>
                  <td className="px-lg py-sm"><StatusPill status={b.status} /></td>
                  <td className="px-lg py-sm text-right">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => openView(b)} className="p-1.5 rounded hover:bg-surface-container-high text-on-surface-variant" title="View"><Eye className="w-3.5 h-3.5" /></button>
                      {['AWAITING_PAYMENT', 'PARTIAL', 'OVERDUE'].includes(b.status) && (
                        <button onClick={() => setPayingBill(b)} className="p-1.5 rounded hover:bg-surface-container-high text-green-400" title="Pay"><Wallet className="w-3.5 h-3.5" /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && <EmptyState message="No bills match this filter yet." colSpan={8} />}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {showEditor && (
        <BillEditorModal
          {...props}
          prefillFromPO={prefillFromPO}
          onClose={() => { setShowEditor(false); onPrefillConsumed?.(); }}
          onSaved={async () => { setShowEditor(false); onPrefillConsumed?.(); await refresh(); }}
        />
      )}

      {viewing && (
        <Modal title={viewing.billNumber} subtitle={`${viewing.supplierName || viewing.supplierId || 'No supplier'} · ${fmtDate(viewing.billDate)}`} onClose={() => setViewing(null)} maxWidth="max-w-2xl">
          <div className="flex items-center gap-2 mb-md"><StatusPill status={viewing.status} /><span className="text-xs text-on-surface-variant">Due {fmtDate(viewing.dueDate)}</span></div>
          <div className="overflow-x-auto rounded-lg border border-outline-variant/40 mb-md">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="bg-surface-container-high/50 text-outline text-[10px] uppercase">
                  <th className="py-2 px-3">Description</th>
                  <th className="py-2 px-3 text-right">Qty</th>
                  <th className="py-2 px-3 text-right">Cost</th>
                  <th className="py-2 px-3 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {(viewing.items || []).map((it: any) => (
                  <tr key={it.id} className="border-t border-outline-variant/20">
                    <td className="py-2 px-3">{it.description}{it.partNumber && <span className="block text-[10px] text-outline font-mono">{it.partNumber}</span>}</td>
                    <td className="py-2 px-3 text-right font-mono">{it.quantity}</td>
                    <td className="py-2 px-3 text-right font-mono">{fmtMoney(it.unitPrice, viewing.currency)}</td>
                    <td className="py-2 px-3 text-right font-mono font-bold">{fmtMoney(it.lineTotal, viewing.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end mb-md">
            <div className="w-56 space-y-1 text-xs">
              <div className="flex justify-between"><span className="text-on-surface-variant">Subtotal</span><span className="font-mono">{fmtMoney(viewing.subtotal, viewing.currency)}</span></div>
              <div className="flex justify-between"><span className="text-on-surface-variant">Tax</span><span className="font-mono">{fmtMoney(viewing.taxTotal, viewing.currency)}</span></div>
              <div className="flex justify-between font-bold"><span>Total</span><span className="font-mono text-primary">{fmtMoney(viewing.total, viewing.currency)}</span></div>
              <div className="flex justify-between text-green-400"><span>Paid</span><span className="font-mono">{fmtMoney(viewing.amountPaid, viewing.currency)}</span></div>
              <div className="flex justify-between font-bold border-t border-outline-variant/30 pt-1"><span>Balance Due</span><span className="font-mono">{fmtMoney(viewing.balanceDue, viewing.currency)}</span></div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 justify-end pt-2 border-t border-outline-variant/20">
            {viewing.status === 'DRAFT' && <PrimaryButton icon={<Send className="w-3.5 h-3.5" />} onClick={() => handleFinalize(viewing.id)} disabled={busy}>Finalize</PrimaryButton>}
            {['AWAITING_PAYMENT', 'PARTIAL', 'OVERDUE'].includes(viewing.status) && (
              <>
                <PrimaryButton icon={<Wallet className="w-3.5 h-3.5" />} onClick={() => { setPayingBill(viewing); setViewing(null); }}>Pay Bill</PrimaryButton>
                <DangerButton icon={<Ban className="w-3.5 h-3.5" />} onClick={() => handleVoid(viewing.id)} disabled={busy}>Void</DangerButton>
              </>
            )}
          </div>
        </Modal>
      )}

      {payingBill && (
        <QuickBillPaymentModal bill={payingBill} accounts={props.accounts} triggerToast={triggerToast} onClose={() => setPayingBill(null)} onSaved={async () => { setPayingBill(null); await refresh(); }} />
      )}
    </div>
  );
};

const BillEditorModal: React.FC<ModuleDataProps & { prefillFromPO?: PurchaseOrder | null; onClose: () => void; onSaved: () => void }> = ({ suppliers, items, taxRates, accounts, prefillFromPO, onClose, onSaved, triggerToast }) => {
  const [supplierId, setSupplierId] = useState(prefillFromPO?.supplierId || '');
  const [billDate, setBillDate] = useState(todayISO());
  const [dueDate, setDueDate] = useState(addDaysISO(30));
  const [currency, setCurrency] = useState(prefillFromPO?.currency || 'ZAR');
  const [notes, setNotes] = useState('');
  const poItems = (prefillFromPO as any)?.items as any[] | undefined;
  const [lines, setLines] = useState<EditableLine[]>(
    poItems?.length
      ? poItems.map((it: any) => ({ key: `L${it.id}`, partNumber: it.partNumber, description: it.description, quantity: it.quantity, unitPrice: it.unitPrice, taxRateId: it.taxRateId ?? null, receiveStock: !!it.partNumber }))
      : [newEditableLine()]
  );
  const [saving, setSaving] = useState<'DRAFT' | 'AWAITING_PAYMENT' | null>(null);

  const submit = async (status: 'DRAFT' | 'AWAITING_PAYMENT') => {
    const validLines = lines.filter(l => l.description.trim() && l.quantity > 0);
    if (!validLines.length) { triggerToast('Add at least one line item.', 'ERROR'); return; }
    setSaving(status);
    try {
      await apiPost('/api/bills', {
        supplierId: supplierId || null,
        purchaseOrderId: prefillFromPO?.id || null,
        billDate, dueDate, currency, notes, status,
        items: validLines.map(l => ({ partNumber: l.partNumber || undefined, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRateId: l.taxRateId || undefined, accountId: l.accountId || undefined, receiveStock: !!l.receiveStock })),
      });
      triggerToast(status === 'AWAITING_PAYMENT' ? 'Bill finalized and posted to the ledger.' : 'Bill saved as draft.');
      onSaved();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to save bill', 'ERROR');
    } finally {
      setSaving(null);
    }
  };

  return (
    <Modal title={prefillFromPO ? `Bill from ${prefillFromPO.poNumber}` : 'New Bill'} subtitle="Draft first, then finalize to post to the ledger and (optionally) receive stock." onClose={onClose} maxWidth="max-w-4xl">
      <div className="grid md:grid-cols-4 gap-3 mb-md">
        <div className="md:col-span-2">
          <FieldLabel>Supplier</FieldLabel>
          <select className={selectClass} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">Select supplier</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Bill Date</FieldLabel>
          <input type="date" className={inputClass} value={billDate} onChange={(e) => setBillDate(e.target.value)} />
        </div>
        <div>
          <FieldLabel>Due Date</FieldLabel>
          <input type="date" className={inputClass} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
      </div>

      <ErrorBoundary>
        <LineItemsEditor lines={lines} onChange={setLines} items={items} taxRates={taxRates} accounts={accounts} mode="PURCHASE" currency={currency} />
      </ErrorBoundary>

      <div className="mt-md">
        <FieldLabel>Notes</FieldLabel>
        <textarea className={inputClass} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="flex justify-end gap-2 pt-md mt-md border-t border-outline-variant/20">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <SecondaryButton onClick={() => submit('DRAFT')} disabled={!!saving}>{saving === 'DRAFT' ? 'Saving...' : 'Save Draft'}</SecondaryButton>
        <PrimaryButton icon={<Send className="w-3.5 h-3.5" />} onClick={() => submit('AWAITING_PAYMENT')} disabled={!!saving}>{saving === 'AWAITING_PAYMENT' ? 'Posting...' : 'Finalize'}</PrimaryButton>
      </div>
    </Modal>
  );
};

const QuickBillPaymentModal: React.FC<{ bill: Bill; accounts: ModuleDataProps['accounts']; onClose: () => void; onSaved: () => void; triggerToast: ModuleDataProps['triggerToast'] }> = ({ bill, accounts, onClose, onSaved, triggerToast }) => {
  const bankAccounts = accounts.filter(a => a.subtype === 'BANK' || a.subtype === 'CASH');
  const [amount, setAmount] = useState(bill.balanceDue);
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [method, setMethod] = useState('EFT');
  const [paidFromAccountId, setPaidFromAccountId] = useState(String(bankAccounts[0]?.id || ''));
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!paidFromAccountId) { triggerToast('Choose which account to pay from.', 'ERROR'); return; }
    if (amount <= 0) { triggerToast('Amount must be greater than zero.', 'ERROR'); return; }
    setSaving(true);
    try {
      await apiPost('/api/payments-made', {
        supplierId: bill.supplierId || null,
        paymentDate, amount, method, paidFromAccountId: Number(paidFromAccountId), reference,
        allocations: [{ billId: bill.id, amountApplied: Math.min(amount, bill.balanceDue) }],
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
    <Modal title={`Pay ${bill.billNumber}`} subtitle={`Balance due: ${fmtMoney(bill.balanceDue, bill.currency)}`} onClose={onClose} maxWidth="max-w-md">
      <div className="space-y-3">
        <div>
          <FieldLabel>Amount to pay</FieldLabel>
          <input type="number" min={0.01} step="0.01" className={inputClass} value={amount} onChange={(e) => setAmount(parseFloat(e.target.value) || 0)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
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
        </div>
        <div>
          <FieldLabel>Paid from</FieldLabel>
          <select className={selectClass} value={paidFromAccountId} onChange={(e) => setPaidFromAccountId(e.target.value)}>
            <option value="">Select account</option>
            {bankAccounts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Reference</FieldLabel>
          <input className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-md mt-md border-t border-outline-variant/20">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton icon={<Wallet className="w-3.5 h-3.5" />} onClick={submit} disabled={saving}>{saving ? 'Saving...' : 'Pay Bill'}</PrimaryButton>
      </div>
    </Modal>
  );
};
