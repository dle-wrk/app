import React, { useMemo, useState } from 'react';
import { Plus, Eye, FileText } from 'lucide-react';
import { PurchaseOrder } from '../../types';
import { ModuleDataProps, Modal, StatusPill, fmtMoney, fmtDate, todayISO, apiPost, apiPut, apiGet, PrimaryButton, SecondaryButton, FieldLabel, inputClass, selectClass, EmptyState, SectionCard } from './shared';
import { LineItemsEditor, EditableLine, newEditableLine } from './LineItemsEditor';
import { ErrorBoundary } from '../ErrorBoundary';

export const PurchaseOrdersTab: React.FC<ModuleDataProps & { onConvertToBill?: (po: PurchaseOrder) => void }> = (props) => {
  const { purchaseOrders, triggerToast, refresh, onConvertToBill } = props;
  const [showCreate, setShowCreate] = useState(false);
  const [viewing, setViewing] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const openView = async (po: PurchaseOrder) => {
    try {
      const full = await apiGet(`/api/purchase-orders/${po.id}`);
      setViewing(full);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load purchase order', 'ERROR');
    }
  };

  const updateStatus = async (id: number, status: string) => {
    setBusy(true);
    try {
      await apiPut(`/api/purchase-orders/${id}/status`, { status });
      triggerToast('Purchase order updated.');
      await refresh();
      setViewing(null);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to update purchase order', 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <SectionCard
        title="Purchase Orders"
        badge={`${purchaseOrders.length} orders`}
        actions={<PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setShowCreate(true)}>New Purchase Order</PrimaryButton>}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">PO #</th>
                <th className="px-lg py-sm">Supplier</th>
                <th className="px-lg py-sm">Order Date</th>
                <th className="px-lg py-sm">Expected</th>
                <th className="px-lg py-sm text-right">Total</th>
                <th className="px-lg py-sm">Status</th>
                <th className="px-lg py-sm text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {purchaseOrders.map(po => (
                <tr key={po.id} className="hover:bg-surface-variant/20 transition-all">
                  <td className="px-lg py-sm font-mono text-primary font-bold cursor-pointer" onClick={() => openView(po)}>{po.poNumber}</td>
                  <td className="px-lg py-sm font-semibold">{po.supplierName || po.supplierId || '—'}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(po.orderDate)}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(po.expectedDate)}</td>
                  <td className="px-lg py-sm text-right font-mono">{fmtMoney(po.total, po.currency)}</td>
                  <td className="px-lg py-sm"><StatusPill status={po.status} /></td>
                  <td className="px-lg py-sm text-right">
                    <button onClick={() => openView(po)} className="p-1.5 rounded hover:bg-surface-container-high text-on-surface-variant" title="View"><Eye className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
              {purchaseOrders.length === 0 && <EmptyState message="No purchase orders yet." colSpan={7} />}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {showCreate && (
        <POEditorModal {...props} onClose={() => setShowCreate(false)} onSaved={async () => { setShowCreate(false); await refresh(); }} />
      )}

      {viewing && (
        <Modal title={viewing.poNumber} subtitle={`${viewing.supplierName || viewing.supplierId || 'No supplier'} · ${fmtDate(viewing.orderDate)}`} onClose={() => setViewing(null)} maxWidth="max-w-2xl">
          <div className="flex items-center gap-2 mb-md"><StatusPill status={viewing.status} /></div>
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
              <div className="flex justify-between font-bold text-sm"><span>Total</span><span className="font-mono text-primary">{fmtMoney(viewing.total, viewing.currency)}</span></div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 justify-end pt-2 border-t border-outline-variant/20">
            {viewing.status === 'DRAFT' && <SecondaryButton onClick={() => updateStatus(viewing.id, 'SENT')} disabled={busy}>Mark Sent</SecondaryButton>}
            {['SENT', 'PARTIAL'].includes(viewing.status) && <SecondaryButton onClick={() => updateStatus(viewing.id, 'RECEIVED')} disabled={busy}>Mark Received</SecondaryButton>}
            {viewing.status !== 'CANCELLED' && viewing.status !== 'RECEIVED' && <SecondaryButton onClick={() => updateStatus(viewing.id, 'CANCELLED')} disabled={busy}>Cancel</SecondaryButton>}
            {onConvertToBill && <PrimaryButton icon={<FileText className="w-3.5 h-3.5" />} onClick={() => { onConvertToBill(viewing); setViewing(null); }}>Convert to Bill</PrimaryButton>}
          </div>
        </Modal>
      )}
    </div>
  );
};

const POEditorModal: React.FC<ModuleDataProps & { onClose: () => void; onSaved: () => void }> = ({ suppliers, items, taxRates, onClose, onSaved, triggerToast }) => {
  const [supplierId, setSupplierId] = useState('');
  const [orderDate, setOrderDate] = useState(todayISO());
  const [expectedDate, setExpectedDate] = useState('');
  const [currency, setCurrency] = useState('ZAR');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<EditableLine[]>([newEditableLine()]);
  const [saving, setSaving] = useState<'DRAFT' | 'SENT' | null>(null);

  const submit = async (status: 'DRAFT' | 'SENT') => {
    const validLines = lines.filter(l => l.description.trim() && l.quantity > 0);
    if (!validLines.length) { triggerToast('Add at least one line item.', 'ERROR'); return; }
    setSaving(status);
    try {
      await apiPost('/api/purchase-orders', {
        supplierId: supplierId || null, orderDate, expectedDate: expectedDate || null, currency, notes, status,
        items: validLines.map(l => ({ partNumber: l.partNumber || undefined, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRateId: l.taxRateId || undefined })),
      });
      triggerToast('Purchase order created.');
      onSaved();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to create purchase order', 'ERROR');
    } finally {
      setSaving(null);
    }
  };

  return (
    <Modal title="New Purchase Order" subtitle="Purchase orders don't hit the ledger until they become a Bill." onClose={onClose} maxWidth="max-w-4xl">
      <div className="grid md:grid-cols-4 gap-3 mb-md">
        <div className="md:col-span-2">
          <FieldLabel>Supplier</FieldLabel>
          <select className={selectClass} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">Select supplier</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Order Date</FieldLabel>
          <input type="date" className={inputClass} value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
        </div>
        <div>
          <FieldLabel>Expected Date</FieldLabel>
          <input type="date" className={inputClass} value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
        </div>
      </div>

      <ErrorBoundary>
        <LineItemsEditor lines={lines} onChange={setLines} items={items} taxRates={taxRates} mode="PURCHASE" currency={currency} />
      </ErrorBoundary>

      <div className="mt-md">
        <FieldLabel>Notes</FieldLabel>
        <textarea className={inputClass} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="flex justify-end gap-2 pt-md mt-md border-t border-outline-variant/20">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <SecondaryButton onClick={() => submit('DRAFT')} disabled={!!saving}>{saving === 'DRAFT' ? 'Saving...' : 'Save Draft'}</SecondaryButton>
        <PrimaryButton onClick={() => submit('SENT')} disabled={!!saving}>{saving === 'SENT' ? 'Sending...' : 'Save & Send'}</PrimaryButton>
      </div>
    </Modal>
  );
};
