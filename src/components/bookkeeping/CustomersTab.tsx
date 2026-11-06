import React, { useMemo, useState } from 'react';
import { canChange } from '../../lib/changeAccess';
import { Eye, Trash2, FileText, Download, Loader2 } from 'lucide-react';
import { Client } from '../../types';
import { ModuleDataProps, Modal, StatusPill, fmtMoney, fmtDate, EmptyState, SectionCard, apiGet } from './shared';
import { optimisticListDelete } from '../../lib/optimisticUpdate';
import { confirmDialog } from '../../lib/confirmDialog';
import { saveStatementsPdf } from '../../lib/statementPdf';
import type { CustomerStatement } from '../../lib/customerStatement';
import { Customer360Modal } from './Customer360Modal';
import { customerSummaries } from '../../lib/customerSummary';

export const CustomersTab: React.FC<ModuleDataProps> = ({ clients, setClients, clientOrders, invoices, paymentsReceived, triggerToast }) => {
  const [viewing, setViewing] = useState<Client | null>(null);
  const [showNewClientModal, setShowNewClientModal] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);

  // One All Customers statement, grouped and sorted by customer, first transaction to today.
  const downloadAllStatements = async () => {
    setDownloadingAll(true);
    try {
      const asOf = new Date().toISOString().slice(0, 10);
      const all = (await apiGet(`/api/reports/customer-statements?asOf=${asOf}`)) as CustomerStatement[];
      if (!all.length) { triggerToast('There are no customers yet.', 'INFO'); return; }
      await saveStatementsPdf(all, asOf, { all: true });
      const owing = all.reduce((n, s) => n + s.closingBalance, 0);
      triggerToast(`Statement for all ${all.length} customers downloaded, ${fmtMoney(owing)} owing in all.`);
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to generate statements', 'ERROR');
    } finally {
      setDownloadingAll(false);
    }
  };

  const today = new Date().toISOString().slice(0, 10);
  const summaries = useMemo(() => customerSummaries(clients, invoices, paymentsReceived, clientOrders, today), [clients, invoices, paymentsReceived, clientOrders, today]);
  const sorted = useMemo(() => [...clients].sort((a, b) => a.clientName.localeCompare(b.clientName, undefined, { sensitivity: 'base' })), [clients]);
  const sum = (k: 'invoiced' | 'paid' | 'balance' | 'overdue') => [...summaries.values()].reduce((n, s) => n + s[k], 0);
  const dash = <span className="text-outline">—</span>;

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
          <div className="flex gap-2">
            <button
              onClick={downloadAllStatements}
              disabled={downloadingAll}
              className="px-3 py-1.5 rounded border border-primary text-primary text-xs font-bold hover:bg-primary/10 transition flex items-center gap-1.5 disabled:opacity-50"
              title="One statement for all customers, sorted by customer, from the first transaction to today"
            >
              {downloadingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              Download all statements
            </button>
            {canChange('/api/clients') &&
              <button
                onClick={() => setShowNewClientModal(true)}
                className="px-3 py-1.5 rounded bg-primary text-white text-xs font-bold hover:opacity-90 transition"
              >
                + New Customer
              </button>}
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">Name</th>
                <th className="px-lg py-sm">Contact</th>
                <th className="px-lg py-sm">VAT no.</th>
                <th className="px-lg py-sm text-right">Terms</th>
                <th className="px-lg py-sm text-right" title="Open sales orders, and quotations">Orders</th>
                <th className="px-lg py-sm text-right">Invoices</th>
                <th className="px-lg py-sm">Last activity</th>
                <th className="px-lg py-sm text-right">Invoiced</th>
                <th className="px-lg py-sm text-right">Paid</th>
                <th className="px-lg py-sm text-right">AR Balance</th>
                <th className="px-lg py-sm">Status</th>
                <th className="px-lg py-sm text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {sorted.map(c => { const s = summaries.get(c.id)!; return (
                <tr
                  key={c.id}
                  data-customer={c.clientName}
                  className="hover:bg-surface-variant/20 transition-all cursor-pointer align-top"
                  onClick={() => setViewing(c)}
                >
                  <td className="px-lg py-sm">
                    <div className="font-bold">{c.clientName}</div>
                    {c.address && <div className="text-[10px] text-on-surface-variant max-w-[220px] truncate" title={c.address}>{c.address}</div>}
                  </td>
                  <td className="px-lg py-sm text-on-surface-variant">
                    {c.contactName || c.email || c.phone ? (
                      <>
                        {c.contactName && <div className="text-on-surface">{c.contactName}</div>}
                        {c.email && <div className="text-[10px]">{c.email}</div>}
                        {c.phone && <div className="text-[10px]">{c.phone}</div>}
                      </>
                    ) : dash}
                  </td>
                  <td className="px-lg py-sm font-mono text-on-surface-variant">{c.vatNumber || dash}</td>
                  <td className="px-lg py-sm text-right text-on-surface-variant">{c.paymentTermsDays != null ? `${c.paymentTermsDays} days` : dash}</td>
                  <td className="px-lg py-sm text-right">
                    {s.openOrders || s.quotes ? (
                      <>
                        <div className="font-bold">{s.openOrders}</div>
                        {s.quotes > 0 && <div className="text-[10px] text-on-surface-variant">+ {s.quotes} quote{s.quotes === 1 ? '' : 's'}</div>}
                      </>
                    ) : dash}
                  </td>
                  <td className="px-lg py-sm text-right">{s.invoices || dash}</td>
                  <td className="px-lg py-sm text-on-surface-variant whitespace-nowrap">{s.lastActivity ? fmtDate(s.lastActivity) : dash}</td>
                  <td className="px-lg py-sm text-right font-mono">{s.invoiced ? fmtMoney(s.invoiced) : dash}</td>
                  <td className="px-lg py-sm text-right font-mono text-green-500">{s.paid ? fmtMoney(s.paid) : dash}</td>
                  <td className="px-lg py-sm text-right font-mono">
                    <div className="font-bold">{Math.abs(s.balance) > 0.005 ? fmtMoney(s.balance) : dash}</div>
                    {s.overdue > 0 && <div className="text-[10px] text-error">{fmtMoney(s.overdue)} overdue ({s.overdueCount})</div>}
                  </td>
                  <td className="px-lg py-sm"><StatusPill status={c.status || 'ACTIVE'} /></td>
                  {/* stopPropagation on the actions cell so clicking the statement PDF
                      or delete button doesn't also fire the row's open-drawer handler. */}
                  <td className="px-lg py-sm text-right flex gap-1 justify-end" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => setViewing(c)} className="p-1.5 rounded hover:bg-surface-container-high text-on-surface-variant" title="Open customer 360"><Eye className="w-3.5 h-3.5" /></button>
                    <button
                      onClick={async () => {
                        try {
                          const asOf = new Date().toISOString().slice(0, 10);
                          const s = (await apiGet(`/api/reports/customer-statement?clientId=${c.id}&asOf=${asOf}`)) as CustomerStatement;
                          await saveStatementsPdf([s], asOf);
                          triggerToast(`Statement downloaded — ${fmtMoney(s.aging.total)} open across ${s.overdueInvoices.length} overdue invoice(s).`);
                        } catch (err: any) {
                          triggerToast(err?.message || 'Failed to generate statement', 'ERROR');
                        }
                      }}
                      className="p-1.5 rounded hover:bg-surface-container-high text-primary"
                      title="Download statement PDF"
                    >
                      <FileText className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => handleDelete(c.id)} className="p-1.5 rounded hover:bg-error/10 text-error" title="Delete customer"><Trash2 className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ); })}
              {clients.length === 0 && <EmptyState message="No customers yet — add one from the Customers/Clients page." colSpan={12} />}
            </tbody>
            {clients.length > 0 && (
              <tfoot>
                <tr className="border-t border-outline-variant bg-surface-container-high/50 font-bold">
                  <td className="px-lg py-sm" colSpan={7}>All {clients.length} customers</td>
                  <td className="px-lg py-sm text-right font-mono">{fmtMoney(sum('invoiced'))}</td>
                  <td className="px-lg py-sm text-right font-mono text-green-500">{fmtMoney(sum('paid'))}</td>
                  <td className="px-lg py-sm text-right font-mono">
                    <div>{fmtMoney(sum('balance'))}</div>
                    {sum('overdue') > 0 && <div className="text-[10px] text-error">{fmtMoney(sum('overdue'))} overdue</div>}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </SectionCard>

      {viewing && (
        <Customer360Modal
          client={viewing}
          clientOrders={clientOrders}
          invoices={invoices}
          paymentsReceived={paymentsReceived}
          triggerToast={triggerToast}
          onClose={() => setViewing(null)}
        />
      )}

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
