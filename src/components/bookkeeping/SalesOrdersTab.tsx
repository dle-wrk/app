import React, { useMemo, useRef, useState } from 'react';
import { Plus, Eye, Trash2, Upload, Download, Paperclip, CheckCircle2, XCircle, Printer, Truck } from 'lucide-react';
import { ClientOrder } from '../../types';
import { ModuleDataProps, Modal, StatusPill, fmtMoney, fmtDate, todayISO, apiGet, apiPost, apiDelete, PrimaryButton, SecondaryButton, DangerButton, FieldLabel, inputClass, selectClass, EmptyState, SectionCard } from './shared';
import { LineItemsEditor, EditableLine, newEditableLine, lineTotals } from './LineItemsEditor';
import { confirmDialog } from '../../lib/confirmDialog';
import { renderBrandHeader, waitForBrandImage } from '../../lib/printBrand';

const STATUS_FILTERS = ['ALL', 'DRAFT', 'APPROVED', 'FULFILLED', 'CANCELLED'];

// 10MB soft cap in the UI so the user gets a friendlier message than the
// server's 20MB backstop. Chosen to fit a typical customer PO PDF with
// scanned-page images; larger and we prompt the user to trim.
const DOC_MAX_BYTES = 10 * 1024 * 1024;

interface SalesOrdersTabExtras {
  onCreateDispatch?: (orderId: number, noteType: 'DELIVERY' | 'COLLECTION') => void;
}

export const SalesOrdersTab: React.FC<ModuleDataProps & SalesOrdersTabExtras> = (props) => {
  const { clientOrders, setClientOrders, clients, items, taxRates, triggerToast, refresh } = props;
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [showEditor, setShowEditor] = useState(false);
  const [viewing, setViewing] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const clientName = (id?: number) => clients.find(c => c.id === id)?.clientName || 'Unassigned';

  const filtered = useMemo(
    () => clientOrders.filter(o => statusFilter === 'ALL' || o.status === statusFilter),
    [clientOrders, statusFilter],
  );

  const openView = async (order: ClientOrder) => {
    // Line items live on their own endpoint; fetching them on-demand keeps the
    // list load cheap. If it errors we still open the modal so the header +
    // doc controls remain reachable — just show an empty items table.
    try {
      const allItems = await apiGet('/api/client-order-items');
      const orderItems = Array.isArray(allItems) ? allItems.filter((it: any) => it.clientOrderId === order.id) : [];
      setViewing({ ...order, items: orderItems });
    } catch {
      setViewing({ ...order, items: [] });
    }
  };

  // Deliberately NOT using optimisticListDelete here: the server can reject
  // this delete with a business-logic 409 when the order has linked invoices,
  // dispatch notes, or build jobs, and the specific message from the server
  // ("2 invoices, 1 delivery/collection note" etc.) is far more useful than a
  // generic "failed to delete" toast. Handled inline so the specific message
  // reaches the user.
  const handleDelete = async (id: number) => {
    if (!(await confirmDialog({
      title: 'Delete sales order',
      message: 'Delete this sales order? This cannot be undone.\n\nIf any invoices, delivery/collection notes, or build jobs reference this order, the delete will be blocked — void those first.',
      confirmLabel: 'Delete',
      destructive: true,
    }))) return;

    const snap = clientOrders;
    if (setClientOrders) setClientOrders(prev => prev.filter(o => o.id !== id));
    setViewing(null);

    try {
      const res = await fetch(`/api/client-orders/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = body?.error || `Failed to delete sales order (${res.status})`;
        if (setClientOrders) setClientOrders(snap);
        triggerToast(msg, 'ERROR');
        return;
      }
      triggerToast('Sales order deleted.');
      if (!setClientOrders) await refresh();
    } catch (err: any) {
      if (setClientOrders) setClientOrders(snap);
      triggerToast(err?.message || 'Failed to delete sales order', 'ERROR');
    }
  };

  // Refresh a single order from the server (used after doc upload / verify
  // toggle where the whole doc metadata + verified state changes).
  const refetchOrder = async (id: number) => {
    try {
      const all = await apiGet('/api/client-orders');
      const fresh = Array.isArray(all) ? all.find((o: any) => o.id === id) : null;
      if (fresh && setClientOrders) {
        setClientOrders(prev => prev.map(o => o.id === id ? { ...o, ...fresh } : o));
        if (viewing && viewing.id === id) setViewing((v: any) => ({ ...v, ...fresh }));
      }
    } catch {
      // silent — the list will refresh next time anyway
    }
  };

  return (
    <div className="space-y-4">
      <SectionCard
        title="Sales Orders"
        badge={`${clientOrders.length} orders`}
        actions={
          <div className="flex items-center gap-sm">
            <div className="flex items-center gap-1 flex-wrap">
              {STATUS_FILTERS.map(s => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`text-[10px] font-bold px-2 py-1 rounded border transition-all ${statusFilter === s ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-high border-outline-variant text-on-surface-variant hover:bg-surface-container-highest'}`}
                >
                  {s}
                </button>
              ))}
            </div>
            <PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setShowEditor(true)}>New Sales Order</PrimaryButton>
          </div>
        }
      >
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
                <th className="px-lg py-sm text-center">POP</th>
                <th className="px-lg py-sm text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {filtered.map(o => (
                <tr key={o.id} className="hover:bg-surface-variant/20 transition-all cursor-pointer" onClick={() => openView(o)}>
                  <td className="px-lg py-sm font-mono text-primary font-bold">{o.orderNumber}</td>
                  <td className="px-lg py-sm font-semibold">{clientName(o.clientId)}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(o.orderDate)}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(o.requiredDate)}</td>
                  <td className="px-lg py-sm text-right font-mono">{fmtMoney(o.total, o.currency)}</td>
                  <td className="px-lg py-sm"><StatusPill status={o.status} /></td>
                  <td className="px-lg py-sm text-center">
                    {o.verified ? (
                      <span title={`Verified${o.verifiedAt ? ` on ${fmtDate(o.verifiedAt)}` : ''}`} className="inline-flex items-center gap-1 text-green-400 text-[10px] font-bold">
                        <CheckCircle2 className="w-3 h-3" /> VERIFIED
                      </span>
                    ) : o.hasVerificationDoc ? (
                      <span title={o.verificationDocFilename || 'Document attached'} className="inline-flex items-center gap-1 text-secondary text-[10px] font-bold">
                        <Paperclip className="w-3 h-3" /> ATTACHED
                      </span>
                    ) : (
                      <span className="text-outline text-[10px]">—</span>
                    )}
                  </td>
                  <td className="px-lg py-sm text-right" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => openView(o)} className="p-1.5 rounded hover:bg-surface-container-high text-on-surface-variant" title="View"><Eye className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <EmptyState message={statusFilter === 'ALL' ? 'No sales orders yet. Create one to attach a POP/PO for verification.' : `No orders with status ${statusFilter}.`} colSpan={8} />
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {showEditor && (
        <SalesOrderEditorModal
          {...props}
          onClose={() => setShowEditor(false)}
          onCreated={(created) => {
            if (setClientOrders) setClientOrders(prev => [created, ...prev]);
            setShowEditor(false);
            // Open the fresh order so the user can immediately attach a POP.
            setViewing({ ...created, items: [] });
          }}
        />
      )}

      {viewing && (
        <SalesOrderViewModal
          order={viewing}
          clientName={clientName(viewing.clientId)}
          busy={busy}
          setBusy={setBusy}
          triggerToast={triggerToast}
          onClose={() => setViewing(null)}
          onDelete={() => handleDelete(viewing.id)}
          onDocChanged={() => refetchOrder(viewing.id)}
          onCreateDispatch={props.onCreateDispatch ? (noteType) => {
            setViewing(null);
            props.onCreateDispatch!(viewing.id, noteType);
          } : undefined}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Create modal — client + dates + line items. Uses the shared LineItemsEditor
// so tax/currency behave identically to invoices and bills. POP upload lives
// in the view modal instead of here to keep create flow lean: create first,
// then attach the doc when it arrives.
// ---------------------------------------------------------------------------
const SalesOrderEditorModal: React.FC<ModuleDataProps & { onClose: () => void; onCreated: (order: ClientOrder) => void }> = ({ onClose, onCreated, clients, items, taxRates, triggerToast }) => {
  const [clientId, setClientId] = useState<string>('');
  const [orderDate, setOrderDate] = useState<string>(todayISO());
  const [requiredDate, setRequiredDate] = useState<string>('');
  const [currency, setCurrency] = useState<string>('ZAR');
  const [notes, setNotes] = useState<string>('');
  const [lines, setLines] = useState<EditableLine[]>([newEditableLine()]);
  const [saving, setSaving] = useState(false);

  const totals = useMemo(() => {
    let subtotal = 0, tax = 0;
    for (const line of lines) {
      const t = lineTotals(line, taxRates);
      subtotal += t.base;
      tax += t.taxAmount;
    }
    return { subtotal: Math.round(subtotal * 100) / 100, tax: Math.round(tax * 100) / 100, total: Math.round((subtotal + tax) * 100) / 100 };
  }, [lines, taxRates]);

  const submit = async () => {
    if (!clientId) { triggerToast('Choose a client for this sales order.', 'ERROR'); return; }
    const validLines = lines.filter(l => l.description.trim() && (l.quantity || 0) > 0);
    if (validLines.length === 0) { triggerToast('Add at least one line item.', 'ERROR'); return; }

    setSaving(true);
    try {
      const payload = {
        clientId: Number(clientId),
        orderDate,
        requiredDate: requiredDate || null,
        status: 'DRAFT',
        currency,
        subtotal: totals.subtotal,
        tax: totals.tax,
        total: totals.total,
        notes: notes || null,
        items: validLines.map(l => {
          const t = lineTotals(l, taxRates);
          return {
            partNumber: l.partNumber || null,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            lineTotal: t.lineTotal,
          };
        }),
      };
      const created = await apiPost('/api/client-orders', payload);
      triggerToast(`Sales order ${created.orderNumber} created.`);
      onCreated(created);
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to create sales order', 'ERROR');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="New Sales Order" subtitle="Auto-numbered as SO-YYYY-NNNN. You can attach the POP/PO after saving." onClose={onClose} maxWidth="max-w-4xl">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-md">
        <div className="md:col-span-2">
          <FieldLabel>Client</FieldLabel>
          <select className={selectClass} value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">Select a client…</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.clientName}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Order Date</FieldLabel>
          <input type="date" className={inputClass} value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
        </div>
        <div>
          <FieldLabel>Required Date</FieldLabel>
          <input type="date" className={inputClass} value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)} />
        </div>
        <div>
          <FieldLabel>Currency</FieldLabel>
          <select className={selectClass} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="ZAR">ZAR</option>
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
            <option value="GBP">GBP</option>
          </select>
        </div>
        <div className="md:col-span-3">
          <FieldLabel>Notes</FieldLabel>
          <input className={inputClass} placeholder="Optional — visible on the printed order" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>

      <div className="mt-md">
        <FieldLabel>Line Items</FieldLabel>
        <LineItemsEditor
          lines={lines}
          onChange={setLines}
          items={items}
          taxRates={taxRates}
          mode="SALES"
          currency={currency}
        />
      </div>

      <div className="flex items-center justify-between pt-md mt-md border-t border-outline-variant/40">
        <div className="text-xs text-outline">Draft — status can change after saving.</div>
        <div className="w-64 space-y-1 text-xs">
          <div className="flex justify-between"><span>Subtotal</span><span className="font-mono">{fmtMoney(totals.subtotal, currency)}</span></div>
          <div className="flex justify-between text-on-surface-variant"><span>Tax</span><span className="font-mono">{fmtMoney(totals.tax, currency)}</span></div>
          <div className="flex justify-between font-bold text-sm border-t border-outline-variant/40 pt-1"><span>Total</span><span className="font-mono text-primary">{fmtMoney(totals.total, currency)}</span></div>
        </div>
      </div>

      <div className="flex justify-end gap-sm pt-md">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Create Sales Order'}</PrimaryButton>
      </div>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// View modal — order header + line items + POP/PO upload + verify toggle +
// print. This is the workhorse: the user creates the order, comes back to
// this modal to attach the client's PDF, and ticks "verified" once they've
// eyeballed it against the order.
// ---------------------------------------------------------------------------
const SalesOrderViewModal: React.FC<{
  order: any;
  clientName: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  triggerToast: (msg: string, type?: any) => void;
  onClose: () => void;
  onCreateDispatch?: (noteType: 'DELIVERY' | 'COLLECTION') => void;
  onDelete: () => void;
  onDocChanged: () => void;
}> = ({ order, clientName, busy, setBusy, triggerToast, onClose, onDelete, onDocChanged, onCreateDispatch }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (file: File) => {
    if (file.size > DOC_MAX_BYTES) {
      triggerToast(`Document is ${(file.size / 1024 / 1024).toFixed(1)}MB — max 10MB. Trim the PDF or split it.`, 'ERROR');
      return;
    }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      // btoa needs a binary string; chunk to avoid "String too long" on large
      // buffers. 8KB chunks keep the call-stack cost trivial.
      let binary = '';
      const bytes = new Uint8Array(buf);
      const chunkSize = 0x2000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
      }
      const base64 = btoa(binary);
      await apiPost(`/api/client-orders/${order.id}/document`, {
        data: base64,
        mime: file.type || 'application/octet-stream',
        filename: file.name,
      });
      triggerToast('POP/PO attached.');
      onDocChanged();
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to upload document', 'ERROR');
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemoveDoc = async () => {
    if (!(await confirmDialog({ title: 'Remove attachment', message: 'Remove the attached POP/PO? The verified flag will also be cleared.', confirmLabel: 'Remove', destructive: true }))) return;
    setBusy(true);
    try {
      await fetch(`/api/client-orders/${order.id}/document`, { method: 'DELETE' });
      triggerToast('Attachment removed.');
      onDocChanged();
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to remove attachment', 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleVerify = async () => {
    const target = !order.verified;
    if (target && !order.hasVerificationDoc) {
      triggerToast('Attach the POP/PO before verifying.', 'ERROR');
      return;
    }
    setBusy(true);
    try {
      // verifiedBy is now derived from the session user on the server, not
      // trusted from the client — see clientsRoutes.ts PUT /verify handler.
      const res = await fetch(`/api/client-orders/${order.id}/verify`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verified: target }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to update verification');
      triggerToast(target ? 'Order marked verified.' : 'Verification cleared.');
      onDocChanged();
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to update verification', 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  const openPrint = async () => {
    // Opens a new tab with a printable summary. Rendered inline (no lib) so
    // it works offline and doesn't add an html2pdf dependency for a doc that
    // the browser's own print dialog already handles cleanly.
    const w = window.open('', '_blank', 'width=900,height=1000');
    if (!w) { triggerToast('Popup blocked — allow popups to print.', 'ERROR'); return; }
    const html = renderPrintableSalesOrder(order, clientName);
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.focus();
    // Wait for the brand logo image before firing print so the printed
    // page never comes out with a blank spot where the header should be.
    await waitForBrandImage(w);
    w.print();
  };

  return (
    <Modal title={order.orderNumber} subtitle={`${clientName} · ${fmtDate(order.orderDate)}`} onClose={onClose} maxWidth="max-w-3xl">
      <div className="flex items-center gap-2 mb-md flex-wrap">
        <StatusPill status={order.status} />
        {order.verified && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-500/10 text-green-400 border border-green-500/20">
            <CheckCircle2 className="w-3 h-3" /> VERIFIED{order.verifiedAt ? ` · ${fmtDate(order.verifiedAt)}` : ''}
          </span>
        )}
      </div>

      {order.items && order.items.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-outline-variant/40 mb-md">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-outline text-[10px] uppercase">
                <th className="py-2 px-3">Description</th>
                <th className="py-2 px-3 text-right">Qty</th>
                <th className="py-2 px-3 text-right">Price</th>
                <th className="py-2 px-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((it: any) => (
                <tr key={it.id} className="border-t border-outline-variant/20">
                  <td className="py-2 px-3">
                    {it.partNumber && <span className="font-mono text-[10px] text-primary mr-1">{it.partNumber}</span>}
                    {it.description}
                  </td>
                  <td className="py-2 px-3 text-right font-mono">{it.quantity}</td>
                  <td className="py-2 px-3 text-right font-mono">{fmtMoney(it.unitPrice, order.currency)}</td>
                  <td className="py-2 px-3 text-right font-mono font-bold">{fmtMoney(it.lineTotal, order.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-outline italic mb-md">No line items on this order.</p>
      )}

      <SectionCard title="Proof-of-Purchase / Customer PO">
        <div className="p-md space-y-sm">
          {order.hasVerificationDoc ? (
            <div className="flex items-center gap-sm p-sm bg-surface-container-high/40 rounded-lg border border-outline-variant/30 flex-wrap">
              <Paperclip className="w-4 h-4 text-secondary shrink-0" />
              <span className="text-xs font-semibold flex-1 truncate">{order.verificationDocFilename || 'document'}</span>
              <span className="text-[10px] text-outline whitespace-nowrap">{order.verificationDocMime}</span>
              <a href={`/api/client-orders/${order.id}/document`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">
                <Download className="w-3 h-3" /> Open
              </a>
              <DangerButton icon={<Trash2 className="w-3 h-3" />} onClick={handleRemoveDoc} disabled={busy} className="py-1">Remove</DangerButton>
            </div>
          ) : (
            <div className="p-sm bg-surface-container-high/40 rounded-lg border border-outline-variant/30 text-xs text-outline italic">
              No POP/PO attached yet. Upload the client's PDF or image to enable verification.
            </div>
          )}

          <div className="flex items-center justify-between gap-sm flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,image/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }}
            />
            <SecondaryButton icon={<Upload className="w-3.5 h-3.5" />} onClick={() => fileInputRef.current?.click()} disabled={busy}>
              {order.hasVerificationDoc ? 'Replace…' : 'Upload POP/PO…'}
            </SecondaryButton>

            <button
              type="button"
              onClick={handleToggleVerify}
              disabled={busy || (!order.hasVerificationDoc && !order.verified)}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${order.verified ? 'bg-green-500/10 border-green-500/40 text-green-400 hover:bg-green-500/20' : 'bg-surface-container-high border-outline-variant text-on-surface hover:bg-surface-container-highest'}`}
            >
              {order.verified ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
              {order.verified ? 'Verified — click to unverify' : 'Mark as verified'}
            </button>
          </div>
          {!order.hasVerificationDoc && !order.verified && (
            <p className="text-[10px] text-outline">Verification is disabled until a POP/PO is attached.</p>
          )}
        </div>
      </SectionCard>

      <div className="flex items-center justify-between pt-md mt-md border-t border-outline-variant/20 gap-sm flex-wrap">
        <div className="flex items-center gap-sm flex-wrap">
          <DangerButton icon={<Trash2 className="w-3.5 h-3.5" />} onClick={onDelete} disabled={busy}>Delete</DangerButton>
          <SecondaryButton icon={<Printer className="w-3.5 h-3.5" />} onClick={openPrint}>Print</SecondaryButton>
          {onCreateDispatch && (
            <>
              <SecondaryButton icon={<Truck className="w-3.5 h-3.5" />} onClick={() => onCreateDispatch('DELIVERY')}>Create Delivery Note</SecondaryButton>
              <SecondaryButton icon={<Truck className="w-3.5 h-3.5" />} onClick={() => onCreateDispatch('COLLECTION')}>Create Collection Note</SecondaryButton>
            </>
          )}
        </div>
        <div className="w-56 space-y-1 text-xs">
          <div className="flex justify-between text-on-surface-variant"><span>Subtotal</span><span className="font-mono">{fmtMoney(order.subtotal, order.currency)}</span></div>
          <div className="flex justify-between text-on-surface-variant"><span>Tax</span><span className="font-mono">{fmtMoney(order.tax, order.currency)}</span></div>
          <div className="flex justify-between font-bold text-sm border-t border-outline-variant/40 pt-1"><span>Total</span><span className="font-mono text-primary">{fmtMoney(order.total, order.currency)}</span></div>
        </div>
      </div>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Printable HTML — self-contained document with the TRACKLAB header + order
// summary + line items. window.open + document.write lets the user print or
// save-as-PDF via the browser's own dialog with no library dependency.
// ---------------------------------------------------------------------------
function renderPrintableSalesOrder(order: any, clientName: string): string {
  const money = (n: number) => fmtMoney(n, order.currency);
  const rows = (order.items || []).map((it: any) => `
    <tr>
      <td>${it.partNumber ? `<span class="pn">${escapeHtml(it.partNumber)}</span> ` : ''}${escapeHtml(it.description)}</td>
      <td class="num">${it.quantity}</td>
      <td class="num">${escapeHtml(money(it.unitPrice))}</td>
      <td class="num strong">${escapeHtml(money(it.lineTotal))}</td>
    </tr>
  `).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(order.orderNumber)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111; margin: 0; padding: 40px; }
  .brand { border-bottom: 3px solid #f7912b; padding-bottom: 16px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: flex-end; }
  .brand h1 { margin: 0; font-size: 28px; letter-spacing: -0.5px; color: #f7912b; font-weight: 900; }
  .brand .tagline { font-size: 11px; color: #666; letter-spacing: 1px; text-transform: uppercase; }
  .brand .doc-type { text-align: right; }
  .brand .doc-type h2 { margin: 0; font-size: 20px; font-weight: 700; }
  .brand .doc-type .num { font-family: ui-monospace, monospace; font-size: 14px; color: #f7912b; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px; }
  .grid .label { font-size: 10px; text-transform: uppercase; color: #666; letter-spacing: 1px; margin-bottom: 4px; }
  .grid .val { font-size: 13px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; color: #666; padding: 8px 6px; border-bottom: 2px solid #333; }
  td { padding: 10px 6px; border-bottom: 1px solid #ddd; font-size: 12px; vertical-align: top; }
  td.num { text-align: right; font-family: ui-monospace, monospace; }
  td.strong { font-weight: 700; }
  .pn { font-family: ui-monospace, monospace; font-size: 10px; color: #f7912b; }
  .totals { margin-top: 16px; display: flex; justify-content: flex-end; }
  .totals table { width: 260px; }
  .totals td { padding: 6px 4px; border: 0; font-size: 12px; }
  .totals tr.total td { font-size: 15px; font-weight: 800; border-top: 2px solid #333; padding-top: 10px; }
  .verify { margin-top: 40px; padding: 12px 16px; border: 2px solid ${order.verified ? '#4ade80' : '#ccc'}; border-radius: 6px; background: ${order.verified ? '#f0fdf4' : '#fafafa'}; font-size: 12px; }
  .verify .stamp { font-size: 14px; font-weight: 800; color: ${order.verified ? '#16a34a' : '#666'}; text-transform: uppercase; letter-spacing: 1px; }
  .notes { margin-top: 16px; padding: 12px; background: #fafafa; border-left: 3px solid #f7912b; font-size: 12px; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 10px; color: #999; text-align: center; }
  @media print { body { padding: 20px; } }
</style></head><body>
  ${renderBrandHeader({ title: 'Sales Order', number: order.orderNumber })}

  <div class="grid">
    <div>
      <div class="label">Client</div>
      <div class="val">${escapeHtml(clientName)}</div>
    </div>
    <div>
      <div class="label">Status</div>
      <div class="val">${escapeHtml(order.status)}</div>
    </div>
    <div>
      <div class="label">Order Date</div>
      <div class="val">${escapeHtml(fmtDate(order.orderDate))}</div>
    </div>
    <div>
      <div class="label">Required</div>
      <div class="val">${escapeHtml(order.requiredDate ? fmtDate(order.requiredDate) : '—')}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th style="text-align:right">Qty</th>
        <th style="text-align:right">Unit Price</th>
        <th style="text-align:right">Total</th>
      </tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="4" style="text-align:center;color:#999;padding:20px">No line items</td></tr>'}</tbody>
  </table>

  <div class="totals">
    <table>
      <tr><td>Subtotal</td><td class="num">${escapeHtml(money(order.subtotal))}</td></tr>
      <tr><td>Tax</td><td class="num">${escapeHtml(money(order.tax))}</td></tr>
      <tr class="total"><td>Total</td><td class="num">${escapeHtml(money(order.total))}</td></tr>
    </table>
  </div>

  ${order.notes ? `<div class="notes"><strong>Notes:</strong> ${escapeHtml(order.notes)}</div>` : ''}

  <div class="verify">
    <div class="stamp">${order.verified ? '✓ Verified against POP/PO' : 'Pending POP/PO verification'}</div>
    ${order.verified && order.verifiedAt ? `<div style="margin-top:4px;color:#666">Verified ${escapeHtml(fmtDate(order.verifiedAt))}${order.verifiedBy ? ` by ${escapeHtml(order.verifiedBy)}` : ''}</div>` : ''}
    ${order.hasVerificationDoc ? `<div style="margin-top:4px;color:#666">Document on file: ${escapeHtml(order.verificationDocFilename || '')}</div>` : ''}
  </div>

  <div class="footer">TRACKLAB IM · Generated ${escapeHtml(new Date().toLocaleString())}</div>
</body></html>`;
}

function escapeHtml(s: any): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}
