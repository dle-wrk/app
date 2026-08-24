import React, { useState } from 'react';
import { Eye, Trash2 } from 'lucide-react';
import { ClientOrder } from '../../types';
import { ModuleDataProps, Modal, StatusPill, fmtMoney, fmtDate, apiGet, apiDelete, DangerButton, EmptyState, SectionCard } from './shared';

export const SalesOrdersTab: React.FC<ModuleDataProps> = ({ clientOrders, clients, triggerToast, refresh }) => {
  const [viewing, setViewing] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const clientName = (id?: number) => clients.find(c => c.id === id)?.clientName || 'Unassigned';

  const openView = async (order: ClientOrder) => {
    try {
      const allItems = await apiGet('/api/client-order-items');
      const items = Array.isArray(allItems) ? allItems.filter((it: any) => it.clientOrderId === order.id) : [];
      setViewing({ ...order, items });
    } catch (err: any) {
      setViewing({ ...order, items: [] });
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this sales order? This cannot be undone.')) return;
    setBusy(true);
    try {
      await apiDelete(`/api/client-orders/${id}`);
      triggerToast('Sales order deleted.');
      await refresh();
      setViewing(null);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to delete sales order', 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <SectionCard title="Sales Orders" badge={`${clientOrders.length} orders`} actions={<span className="text-[10px] text-outline">Convert fulfilled orders to Invoices in the Sales → Invoices tab</span>}>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">Order #</th>
                <th className="px-lg py-sm">Client</th>
                <th className="px-lg py-sm">Order Date</th>
                <th className="px-lg py-sm">Required</th>
                <th className="px-lg py-sm text-right">Total</th>
                <th className="px-lg py-sm">Status</th>
                <th className="px-lg py-sm text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {clientOrders.map(o => (
                <tr key={o.id} className="hover:bg-surface-variant/20 transition-all">
                  <td className="px-lg py-sm font-mono text-primary font-bold cursor-pointer" onClick={() => openView(o)}>{o.orderNumber}</td>
                  <td className="px-lg py-sm font-semibold">{clientName(o.clientId)}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(o.orderDate)}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(o.requiredDate)}</td>
                  <td className="px-lg py-sm text-right font-mono">{fmtMoney(o.total, o.currency)}</td>
                  <td className="px-lg py-sm"><StatusPill status={o.status} /></td>
                  <td className="px-lg py-sm text-right">
                    <button onClick={() => openView(o)} className="p-1.5 rounded hover:bg-surface-container-high text-on-surface-variant" title="View"><Eye className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
              {clientOrders.length === 0 && <EmptyState message="No sales orders yet." colSpan={7} />}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {viewing && (
        <Modal title={viewing.orderNumber} subtitle={`${clientName(viewing.clientId)} · ${fmtDate(viewing.orderDate)}`} onClose={() => setViewing(null)} maxWidth="max-w-2xl">
          <div className="flex items-center gap-2 mb-md"><StatusPill status={viewing.status} /></div>
          {viewing.items && viewing.items.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-outline-variant/40 mb-md">
              <table className="w-full text-left text-xs">
                <thead><tr className="bg-surface-container-high/50 text-outline text-[10px] uppercase"><th className="py-2 px-3">Description</th><th className="py-2 px-3 text-right">Qty</th><th className="py-2 px-3 text-right">Price</th><th className="py-2 px-3 text-right">Total</th></tr></thead>
                <tbody>
                  {viewing.items.map((it: any) => (
                    <tr key={it.id} className="border-t border-outline-variant/20">
                      <td className="py-2 px-3">{it.description}</td>
                      <td className="py-2 px-3 text-right font-mono">{it.quantity}</td>
                      <td className="py-2 px-3 text-right font-mono">{fmtMoney(it.unitPrice, viewing.currency)}</td>
                      <td className="py-2 px-3 text-right font-mono font-bold">{fmtMoney(it.lineTotal, viewing.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-outline italic mb-md">No line items on this order.</p>
          )}
          <div className="flex items-center justify-between pt-2 border-t border-outline-variant/20 mt-md">
            <DangerButton icon={<Trash2 className="w-3.5 h-3.5" />} onClick={() => handleDelete(viewing.id)} disabled={busy}>Delete</DangerButton>
            <div className="w-56 space-y-1 text-xs">
              <div className="flex justify-between font-bold text-sm"><span>Total</span><span className="font-mono text-primary">{fmtMoney(viewing.total, viewing.currency)}</span></div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};
