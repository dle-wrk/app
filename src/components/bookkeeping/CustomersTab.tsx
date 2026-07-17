import React, { useMemo, useState } from 'react';
import { Eye } from 'lucide-react';
import { Client } from '../../types';
import { ModuleDataProps, Modal, StatusPill, fmtMoney, fmtDate, EmptyState, SectionCard } from './shared';

export const CustomersTab: React.FC<ModuleDataProps> = ({ clients, invoices, paymentsReceived }) => {
  const [viewing, setViewing] = useState<Client | null>(null);

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

  return (
    <div className="space-y-4">
      <SectionCard title="Customers" badge={`${clients.length} customers`}>
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
