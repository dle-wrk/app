import React, { useMemo, useState } from 'react';
import { Plus, Ban } from 'lucide-react';
import { ModuleDataProps, Modal, StatusPill, fmtMoney, fmtDate, todayISO, apiPost, PrimaryButton, SecondaryButton, DangerButton, FieldLabel, inputClass, selectClass, EmptyState, SectionCard } from './shared';
import { confirmDialog } from '../../lib/confirmDialog';

export const ExpensesTab: React.FC<ModuleDataProps> = (props) => {
  const { expenses, triggerToast, refresh } = props;
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const monthTotal = useMemo(() => {
    const now = new Date();
    return expenses.filter(e => e.status !== 'VOID' && new Date(e.expenseDate).getMonth() === now.getMonth() && new Date(e.expenseDate).getFullYear() === now.getFullYear()).reduce((s, e) => s + e.total, 0);
  }, [expenses]);

  const handleVoid = async (id: number) => {
    if (!(await confirmDialog({ title: 'Void expense', message: 'Void this expense? This reverses the ledger entry.', confirmLabel: 'Void', destructive: true }))) return;
    setBusy(id);
    try {
      await apiPost(`/api/expenses/${id}/void`);
      triggerToast('Expense voided.');
      await refresh();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to void expense', 'ERROR');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
          <span className="text-[11px] text-on-surface-variant font-bold block mb-1">This month</span>
          <span className="text-xl font-black text-error">{fmtMoney(monthTotal)}</span>
        </div>
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
          <span className="text-[11px] text-on-surface-variant font-bold block mb-1">Total recorded</span>
          <span className="text-xl font-black text-on-surface">{expenses.filter(e => e.status !== 'VOID').length}</span>
        </div>
      </div>

      <SectionCard
        title="Expenses"
        badge="Paid immediately — no accounts payable"
        actions={<PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setShowCreate(true)}>New Expense</PrimaryButton>}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">Expense #</th>
                <th className="px-lg py-sm">Payee</th>
                <th className="px-lg py-sm">Category</th>
                <th className="px-lg py-sm">Date</th>
                <th className="px-lg py-sm text-right">Total</th>
                <th className="px-lg py-sm">Status</th>
                <th className="px-lg py-sm text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {expenses.map(e => (
                <tr key={e.id} className="hover:bg-surface-variant/20 transition-all">
                  <td className="px-lg py-sm font-mono text-primary font-bold">{e.expenseNumber}</td>
                  <td className="px-lg py-sm font-semibold">{e.payee || '—'}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{e.categoryAccountName || '—'}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(e.expenseDate)}</td>
                  <td className="px-lg py-sm text-right font-mono font-bold">{fmtMoney(e.total)}</td>
                  <td className="px-lg py-sm"><StatusPill status={e.status} /></td>
                  <td className="px-lg py-sm text-right">
                    {e.status !== 'VOID' && (
                      <DangerButton onClick={() => handleVoid(e.id)} disabled={busy === e.id} icon={<Ban className="w-3 h-3" />} className="py-1">{busy === e.id ? '...' : 'Void'}</DangerButton>
                    )}
                  </td>
                </tr>
              ))}
              {expenses.length === 0 && <EmptyState message="No expenses recorded yet." colSpan={7} />}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {showCreate && <CreateExpenseModal {...props} onClose={() => setShowCreate(false)} onSaved={async () => { setShowCreate(false); await refresh(); }} />}
    </div>
  );
};

const CreateExpenseModal: React.FC<ModuleDataProps & { onClose: () => void; onSaved: () => void }> = ({ accounts, suppliers, taxRates, onClose, onSaved, triggerToast }) => {
  const expenseAccounts = accounts.filter(a => a.type === 'EXPENSE');
  const bankAccounts = accounts.filter(a => a.subtype === 'BANK' || a.subtype === 'CASH');
  const [payee, setPayee] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [expenseDate, setExpenseDate] = useState(todayISO());
  const [categoryAccountId, setCategoryAccountId] = useState(String(expenseAccounts.find(a => a.code === '6900')?.id || expenseAccounts[0]?.id || ''));
  const [paidFromAccountId, setPaidFromAccountId] = useState(String(bankAccounts[0]?.id || ''));
  const [amount, setAmount] = useState(0);
  const [taxRateId, setTaxRateId] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const taxPct = taxRates.find(t => String(t.id) === taxRateId)?.rate || 0;
  const taxAmount = Math.round(amount * (taxPct / 100) * 100) / 100;
  const total = Math.round((amount + taxAmount) * 100) / 100;

  const submit = async () => {
    if (!categoryAccountId || !paidFromAccountId) { triggerToast('Choose a category and a paid-from account.', 'ERROR'); return; }
    if (amount <= 0) { triggerToast('Amount must be greater than zero.', 'ERROR'); return; }
    setSaving(true);
    try {
      await apiPost('/api/expenses', {
        expenseDate, payee, supplierId: supplierId || null,
        categoryAccountId: Number(categoryAccountId), paidFromAccountId: Number(paidFromAccountId),
        amount, taxRateId: taxRateId ? Number(taxRateId) : undefined, reference, notes,
      });
      triggerToast('Expense recorded.');
      onSaved();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to record expense', 'ERROR');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="New Expense" subtitle="For one-off spend paid immediately (e.g. fuel, courier, office supplies)." onClose={onClose} maxWidth="max-w-lg">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <FieldLabel>Payee</FieldLabel>
          <input className={inputClass} value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="e.g. City Power, Uber" />
        </div>
        <div className="col-span-2">
          <FieldLabel hint="Optional — link to an existing supplier">Supplier</FieldLabel>
          <select className={selectClass} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">None</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Date</FieldLabel>
          <input type="date" className={inputClass} value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
        </div>
        <div>
          <FieldLabel>Amount (excl. tax)</FieldLabel>
          <input type="number" min={0.01} step="0.01" className={inputClass} value={amount} onChange={(e) => setAmount(parseFloat(e.target.value) || 0)} />
        </div>
        <div>
          <FieldLabel>Category</FieldLabel>
          <select className={selectClass} value={categoryAccountId} onChange={(e) => setCategoryAccountId(e.target.value)}>
            {expenseAccounts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Tax</FieldLabel>
          <select className={selectClass} value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)}>
            <option value="">No tax</option>
            {taxRates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="col-span-2">
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
        <div className="col-span-2">
          <FieldLabel>Notes</FieldLabel>
          <textarea className={inputClass} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>

      <div className="flex justify-between items-center mt-md pt-md border-t border-outline-variant/20">
        <div className="text-xs text-on-surface-variant">Total: <span className="font-mono font-bold text-on-surface">{fmtMoney(total)}</span></div>
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton onClick={submit} disabled={saving}>{saving ? 'Saving...' : 'Record Expense'}</PrimaryButton>
        </div>
      </div>
    </Modal>
  );
};
