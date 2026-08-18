import React, { useMemo, useState } from 'react';
import { Eye, Plus } from 'lucide-react';
import { Client } from '../../types';
import {
  ModuleDataProps,
  Modal,
  StatusPill,
  fmtMoney,
  fmtDate,
  EmptyState,
  SectionCard,
  PrimaryButton,
  SecondaryButton,
  FieldLabel,
  inputClass,
  selectClass,
} from './shared';

const emptyCustomerForm = {
  clientName: '',
  contactName: '',
  email: '',
  phone: '',
  address: '',
  vatNumber: '',
  status: 'ACTIVE' as 'ACTIVE' | 'INACTIVE',
};

export const CustomersTab: React.FC<ModuleDataProps> = ({ clients, invoices, paymentsReceived, setClients, triggerToast }) => {
  const [viewing, setViewing] = useState<Client | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [form, setForm] = useState(emptyCustomerForm);

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

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    const clientName = form.clientName.trim();
    if (!clientName) {
      triggerToast('Customer name is required.', 'ERROR');
      return;
    }
    if (!setClients) {
      triggerToast('Customer creation is unavailable in this view.', 'ERROR');
      return;
    }

    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName,
          contactName: form.contactName.trim() || null,
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
          address: form.address.trim() || null,
          vatNumber: form.vatNumber.trim() || null,
          status: form.status,
        }),
      });

      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.error || 'Failed to create customer');
      }

      const created: Client = {
        id: payload.id,
        clientName: payload.clientName,
        contactName: payload.contactName,
        email: payload.email,
        phone: payload.phone,
        address: payload.address,
        vatNumber: payload.vatNumber,
        status: payload.status || 'ACTIVE',
        createdAt: payload.createdAt || new Date().toISOString(),
      };

      setClients(prev => [...prev, created]);
      setForm(emptyCustomerForm);
      setShowCreateModal(false);
      triggerToast('Customer created successfully.', 'SUCCESS');
    } catch (err: any) {
      triggerToast(err.message || 'Failed to create customer.', 'ERROR');
    }
  };

  return (
    <div className="space-y-4">
      <SectionCard
        title="Customers"
        badge={`${clients.length} customers`}
        actions={(
          <PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => { setForm(emptyCustomerForm); setShowCreateModal(true); }}>
            Add customer
          </PrimaryButton>
        )}
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
                  <td className="px-lg py-sm text-right">
                    <button onClick={() => setViewing(c)} className="p-1.5 rounded hover:bg-surface-container-high text-on-surface-variant" title="Statement"><Eye className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
              {clients.length === 0 && <EmptyState message="No customers yet — add one from the Customers/Clients page." colSpan={5} />}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {showCreateModal && (
        <Modal title="Add customer" onClose={() => setShowCreateModal(false)} maxWidth="max-w-xl">
          <form onSubmit={handleCreateCustomer} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="md:col-span-2">
                <FieldLabel>Customer name</FieldLabel>
                <input
                  className={inputClass}
                  value={form.clientName}
                  onChange={e => setForm(prev => ({ ...prev, clientName: e.target.value }))}
                  placeholder="Acme Engineering"
                />
              </div>
              <div>
                <FieldLabel>Contact name</FieldLabel>
                <input className={inputClass} value={form.contactName} onChange={e => setForm(prev => ({ ...prev, contactName: e.target.value }))} placeholder="Jane Smith" />
              </div>
              <div>
                <FieldLabel>Status</FieldLabel>
                <select className={selectClass} value={form.status} onChange={e => setForm(prev => ({ ...prev, status: e.target.value as 'ACTIVE' | 'INACTIVE' }))}>
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="INACTIVE">INACTIVE</option>
                </select>
              </div>
              <div>
                <FieldLabel>Email</FieldLabel>
                <input className={inputClass} type="email" value={form.email} onChange={e => setForm(prev => ({ ...prev, email: e.target.value }))} placeholder="jane@acme.co" />
              </div>
              <div>
                <FieldLabel>Phone</FieldLabel>
                <input className={inputClass} value={form.phone} onChange={e => setForm(prev => ({ ...prev, phone: e.target.value }))} placeholder="+27 12 345 6789" />
              </div>
              <div className="md:col-span-2">
                <FieldLabel>Address</FieldLabel>
                <textarea className={`${inputClass} resize-none`} rows={3} value={form.address} onChange={e => setForm(prev => ({ ...prev, address: e.target.value }))} placeholder="Street, suburb, city, country" />
              </div>
              <div className="md:col-span-2">
                <FieldLabel>VAT number</FieldLabel>
                <input className={inputClass} value={form.vatNumber} onChange={e => setForm(prev => ({ ...prev, vatNumber: e.target.value }))} placeholder="VAT / tax ID" />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <SecondaryButton type="button" onClick={() => setShowCreateModal(false)}>Cancel</SecondaryButton>
              <PrimaryButton type="submit">Save customer</PrimaryButton>
            </div>
          </form>
        </Modal>
      )}

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
    </div>
  );
};
