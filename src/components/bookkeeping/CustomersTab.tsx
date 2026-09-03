import React, { useMemo, useState } from 'react';
import { Eye, Trash2 } from 'lucide-react';
import { Client } from '../../types';
import { ModuleDataProps, Modal, StatusPill, fmtMoney, fmtDate, EmptyState, SectionCard } from './shared';
import { optimisticListDelete } from '../../lib/optimisticUpdate';
import { confirmDialog } from '../../lib/confirmDialog';

export const CustomersTab: React.FC<ModuleDataProps> = ({ clients, setClients, invoices, paymentsReceived, triggerToast }) => {
  const [viewing, setViewing] = useState<Client | null>(null);
  const [showNewClientModal, setShowNewClientModal] = useState(false);

  const balances = useMemo(() => {
    const map = new Map<number, number>();
    for (const inv of invoices) {
      if (inv.status === 'VOID' || inv.status === 'DRAFT' || !inv.clientId) continue;
      map.set(inv.clientId, (map.get(inv.clientId) || 0) + inv.balanceDue);
    }
    return map;
  }, [invoices]);

  const statementFor = (clientId: number) => {
    const clientInvoices = invoices.filter(i => i.clientId === clientId && i.status !== 'DRAFT').sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate));
    const clientPayments = paymentsReceived.filter(p => p.clientId === clientId).sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));
    return { clientInvoices, clientPayments };
  };

  // Optimistic delete: removes the customer from the list instantly, then
  // fires DELETE in the background. On failure the row is restored and an
  // error toast fires. The old code called refresh() after the await, but
  // refresh() only refetches bookkeeping bootstrap data (invoices, bills,
  // payments) — not clients — so the deleted row stayed visible until the
  // user navigated away. That was a real bug, not just a slow write.
  const handleDelete = async (id: number) => {
    if (!setClients) {
      // Fallback: no setter available, do a synchronous delete + toast.
      // Shouldn't happen in production (BookkeepingView always passes it),
      // but keeps the tab usable if a caller forgets to wire it.
      if (!(await confirmDialog({ title: 'Delete customer', message: 'Delete this customer? This action cannot be undone.', confirmLabel: 'Delete', destructive: true }))) return;
      const res = await fetch(`/api/clients/${id}`, { method: 'DELETE' });
      if (res.ok) triggerToast('Customer deleted.'); else triggerToast('Failed to delete customer', 'ERROR');
      setViewing(null);
      return;
    }
    if (!(await confirmDialog({ title: 'Delete customer', message: 'Delete this customer? This action cannot be undone.', confirmLabel: 'Delete', destructive: true }))) return;
    const wasViewing = viewing?.id === id;
    if (wasViewing) setViewing(null);
    await optimisticListDelete({
      list: clients,
      setList: setClients,
      matches: c => c.id === id,
      request: () => fetch(`/api/clients/${id}`, { method: 'DELETE' }),
      successMsg: 'Customer deleted.',
      errorMsg: 'Failed to delete customer',
    });
  };

  return (
    <div className="space-y-4">
      <SectionCard 
        title="Customers" 
        badge={`${clients.length} customers`}
        actions={
          <button 
            onClick={() => setShowNewClientModal(true)}
            className="px-3 py-1.5 rounded bg-primary text-white text-xs font-bold hover:opacity-90 transition"
          >
            + New Customer
          </button>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">Name</th>
                <th className="px-lg py-sm">Contact</th>
                <th className="px-lg py-sm">Status</th>
                <th className="px-lg py-sm text-right">AR Balance</th>
                <th className="px-lg py-sm text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {clients.map(c => (
                <tr key={c.id} className="hover:bg-surface-variant/20 transition-all">
                  <td className="px-lg py-sm font-bold">{c.clientName}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{c.email || c.contactName || '—'}</td>
                  <td className="px-lg py-sm"><StatusPill status={c.status || 'ACTIVE'} /></td>
                  <td className="px-lg py-sm text-right font-mono font-bold">{(balances.get(c.id) || 0) > 0 ? fmtMoney(balances.get(c.id)) : '—'}</td>
                  <td className="px-lg py-sm text-right flex gap-1 justify-end">
                    <button onClick={() => setViewing(c)} className="p-1.5 rounded hover:bg-surface-container-high text-on-surface-variant" title="Statement"><Eye className="w-3.5 h-3.5" /></button>
                    <button onClick={() => handleDelete(c.id)} className="p-1.5 rounded hover:bg-error/10 text-error" title="Delete customer"><Trash2 className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
              {clients.length === 0 && <EmptyState message="No customers yet — add one from the Customers/Clients page." colSpan={5} />}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {viewing && (() => {
        const { clientInvoices, clientPayments } = statementFor(viewing.id);
        return (
          <Modal title={`Statement — ${viewing.clientName}`} subtitle={`Outstanding: ${fmtMoney(balances.get(viewing.id) || 0)}`} onClose={() => setViewing(null)} maxWidth="max-w-2xl">
            <div className="space-y-4">
              <div>
                <h5 className="text-xs font-bold text-outline uppercase mb-2">Invoices</h5>
                <div className="space-y-1">
                  {clientInvoices.map(inv => (
                    <div key={inv.id} className="flex justify-between items-center text-xs bg-surface-container-low rounded px-3 py-2 border border-outline-variant/30">
                      <div>
                        <span className="font-mono text-primary font-bold">{inv.invoiceNumber}</span>
                        <span className="ml-2 text-outline">{fmtDate(inv.invoiceDate)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusPill status={inv.status} />
                        <span className="font-mono">{fmtMoney(inv.total, inv.currency)}</span>
                      </div>
                    </div>
                  ))}
                  {clientInvoices.length === 0 && <p className="text-xs text-outline italic">No invoices yet.</p>}
                </div>
              </div>
              <div>
                <h5 className="text-xs font-bold text-outline uppercase mb-2">Payments</h5>
                <div className="space-y-1">
                  {clientPayments.map(p => (
                    <div key={p.id} className="flex justify-between items-center text-xs bg-surface-container-low rounded px-3 py-2 border border-outline-variant/30">
                      <div>
                        <span className="font-mono text-primary font-bold">{p.paymentNumber}</span>
                        <span className="ml-2 text-outline">{fmtDate(p.paymentDate)}</span>
                      </div>
                      <span className="font-mono text-green-400">{fmtMoney(p.amount)}</span>
                    </div>
                  ))}
                  {clientPayments.length === 0 && <p className="text-xs text-outline italic">No payments recorded yet.</p>}
                </div>
              </div>
            </div>
          </Modal>
        );
      })()}

      {showNewClientModal && (
        <NewClientModal
          onClose={() => setShowNewClientModal(false)}
          // Insert the returned client straight into App state — refresh() would
          // only refetch bookkeeping bootstrap (invoices/bills/POs), not the
          // clients list, so without this the newly created customer wouldn't
          // appear in the table until the user reloaded the page.
          onSaved={(newClient) => {
            setShowNewClientModal(false);
            if (setClients && newClient) setClients(prev => [...prev, newClient]);
          }}
          triggerToast={triggerToast}
        />
      )}
    </div>
  );
};

const NewClientModal: React.FC<{
  onClose: () => void;
  onSaved: (newClient?: Client) => void;
  triggerToast: (m: string, t?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
}> = ({ onClose, onSaved, triggerToast }) => {
  const [clientName, setClientName] = useState('');
  const [contactName, setContactName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [vatNumber, setVatNumber] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!clientName.trim()) {
      triggerToast('Customer name is required.', 'ERROR');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName: clientName.trim(),
          contactName: contactName.trim() || undefined,
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
          address: address.trim() || undefined,
          vatNumber: vatNumber.trim() || undefined,
          status: 'ACTIVE',
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to create customer');
      const created = await res.json().catch(() => null);
      triggerToast('Customer created successfully.');
      onSaved(created ?? undefined);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to create customer', 'ERROR');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="New Customer" subtitle="Add a new customer to your system" onClose={onClose} maxWidth="max-w-md">
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-bold text-outline uppercase mb-1">Customer Name *</label>
          <input
            type="text"
            className="w-full px-3 py-2 rounded border border-outline-variant bg-surface-container text-on-surface text-sm"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            placeholder="Acme Corporation"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-outline uppercase mb-1">Contact Name</label>
          <input
            type="text"
            className="w-full px-3 py-2 rounded border border-outline-variant bg-surface-container text-on-surface text-sm"
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            placeholder="John Doe"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-outline uppercase mb-1">Email</label>
          <input
            type="email"
            className="w-full px-3 py-2 rounded border border-outline-variant bg-surface-container text-on-surface text-sm"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="john@acme.com"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-outline uppercase mb-1">Phone</label>
          <input
            type="tel"
            className="w-full px-3 py-2 rounded border border-outline-variant bg-surface-container text-on-surface text-sm"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+27 21 123 4567"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-outline uppercase mb-1">Address</label>
          <input
            type="text"
            className="w-full px-3 py-2 rounded border border-outline-variant bg-surface-container text-on-surface text-sm"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="123 Main Street, City, Country"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-outline uppercase mb-1">VAT Number</label>
          <input
            type="text"
            className="w-full px-3 py-2 rounded border border-outline-variant bg-surface-container text-on-surface text-sm"
            value={vatNumber}
            onChange={(e) => setVatNumber(e.target.value)}
            placeholder="ZA123456789"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-md mt-md border-t border-outline-variant/20">
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded bg-surface-container-high text-on-surface text-xs font-bold hover:opacity-90 transition"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={saving}
          className="px-3 py-1.5 rounded bg-primary text-white text-xs font-bold hover:opacity-90 transition disabled:opacity-50"
        >
          {saving ? 'Creating...' : 'Create Customer'}
        </button>
      </div>
    </Modal>
  );
};
