import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Eye, Send, CheckCircle2, Ban, Trash2, Printer, X, Truck, PackageCheck } from 'lucide-react';
import { DispatchNote, DispatchNoteItem, DispatchNoteType } from '../../types';
import {
  ModuleDataProps, Modal, StatusPill, fmtDate, todayISO, apiGet, apiPost, apiPut, apiDelete,
  PrimaryButton, SecondaryButton, DangerButton, FieldLabel, inputClass, selectClass, EmptyState, SectionCard,
} from './shared';

// A dispatch note is a delivery note or a collection note for finished/final project products.
// It is a fulfillment document only — no ledger posting, no automatic stock movement.

const TYPE_META: Record<DispatchNoteType, { label: string; plural: string; prefix: string; verb: string; partyLabel: string; addressLabel: string; icon: React.ReactNode }> = {
  DELIVERY: { label: 'Delivery Note', plural: 'Delivery Notes', prefix: 'DN', verb: 'Delivered', partyLabel: 'Deliver to (contact)', addressLabel: 'Delivery address', icon: <Truck className="w-3.5 h-3.5" /> },
  COLLECTION: { label: 'Collection Note', plural: 'Collection Notes', prefix: 'CN', verb: 'Collected', partyLabel: 'Collected by (contact)', addressLabel: 'Collection address', icon: <PackageCheck className="w-3.5 h-3.5" /> },
};

interface EditableItem {
  key: string;
  partNumber?: string;
  description: string;
  quantity: number;
  serialNumbers?: string;
}

const newItem = (): EditableItem => ({ key: `I${Date.now()}${Math.random().toString(36).slice(2, 6)}`, partNumber: '', description: '', quantity: 1, serialNumbers: '' });

export const DispatchTab: React.FC<ModuleDataProps> = (props) => {
  const [type, setType] = useState<DispatchNoteType>('DELIVERY');
  return (
    <div className="space-y-4">
      <div className="flex gap-1 bg-surface-container-high/40 p-1 rounded-lg w-fit">
        {(['DELIVERY', 'COLLECTION'] as DispatchNoteType[]).map(t => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-bold transition-all ${type === t ? 'bg-primary text-white' : 'text-on-surface-variant hover:text-on-surface'}`}
          >
            {TYPE_META[t].icon}{TYPE_META[t].plural}
          </button>
        ))}
      </div>
      {/* Remount on type change so list + modals reset cleanly */}
      <DispatchNotesPanel key={type} type={type} {...props} />
    </div>
  );
};

const DispatchNotesPanel: React.FC<ModuleDataProps & { type: DispatchNoteType }> = (props) => {
  const { type, clients, triggerToast } = props;
  const meta = TYPE_META[type];
  const [rows, setRows] = useState<DispatchNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);
  const [editing, setEditing] = useState<DispatchNote | null>(null);
  const [viewing, setViewing] = useState<DispatchNote | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiGet(`/api/dispatch-notes?type=${type}`);
      setRows(Array.isArray(data) ? data : []);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load dispatch notes', 'ERROR');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [type]);

  const clientName = (id?: number) => clients.find(c => c.id === id)?.clientName || 'Unassigned';

  const openView = async (note: DispatchNote) => {
    try {
      const full = await apiGet(`/api/dispatch-notes/${note.id}`);
      setViewing(full);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load dispatch note', 'ERROR');
    }
  };

  const openEdit = async (note: DispatchNote) => {
    try {
      const full = await apiGet(`/api/dispatch-notes/${note.id}`);
      setEditing(full);
      setShowEditor(true);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load dispatch note', 'ERROR');
    }
  };

  const doAction = async (id: number, action: 'issue' | 'complete' | 'cancel', confirmMsg?: string) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(true);
    try {
      await apiPost(`/api/dispatch-notes/${id}/${action}`);
      triggerToast(`${meta.label} ${action === 'issue' ? 'issued' : action === 'complete' ? 'marked complete' : 'cancelled'}.`);
      setViewing(null);
      await load();
    } catch (err: any) {
      triggerToast(err.message || `Failed to ${action}`, 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (id: number) => {
    if (!confirm('Delete this draft note permanently?')) return;
    setBusy(true);
    try {
      await apiDelete(`/api/dispatch-notes/${id}`);
      triggerToast('Draft note deleted.');
      setViewing(null);
      await load();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to delete', 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <SectionCard
        title={meta.plural}
        badge={`${rows.length}`}
        actions={<PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => { setEditing(null); setShowEditor(true); }}>New {meta.label}</PrimaryButton>}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">Note #</th>
                <th className="px-lg py-sm">Client</th>
                <th className="px-lg py-sm">Order</th>
                <th className="px-lg py-sm">Date</th>
                <th className="px-lg py-sm">Scheduled</th>
                <th className="px-lg py-sm">Status</th>
                <th className="px-lg py-sm text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {rows.map(n => (
                <tr key={n.id} className="hover:bg-surface-variant/20 transition-all">
                  <td className="px-lg py-sm font-mono text-primary font-bold cursor-pointer" onClick={() => openView(n)}>{n.noteNumber}</td>
                  <td className="px-lg py-sm font-semibold">{clientName(n.clientId)}</td>
                  <td className="px-lg py-sm font-mono text-on-surface-variant">{n.orderNumber || '—'}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(n.noteDate)}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(n.scheduledDate)}</td>
                  <td className="px-lg py-sm"><StatusPill status={n.status} /></td>
                  <td className="px-lg py-sm text-right">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => openView(n)} className="p-1.5 rounded hover:bg-surface-container-high text-on-surface-variant" title="View"><Eye className="w-3.5 h-3.5" /></button>
                      {n.status === 'DRAFT' && (
                        <button onClick={() => doAction(n.id, 'issue')} className="p-1.5 rounded hover:bg-surface-container-high text-secondary" title="Issue"><Send className="w-3.5 h-3.5" /></button>
                      )}
                      {n.status === 'ISSUED' && (
                        <button onClick={() => doAction(n.id, 'complete')} className="p-1.5 rounded hover:bg-surface-container-high text-green-400" title={`Mark ${meta.verb.toLowerCase()}`}><CheckCircle2 className="w-3.5 h-3.5" /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && <EmptyState message={`No ${meta.plural.toLowerCase()} yet.`} colSpan={7} />}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {showEditor && (
        <DispatchEditorModal
          {...props}
          initial={editing}
          onClose={() => { setShowEditor(false); setEditing(null); }}
          onSaved={async () => { setShowEditor(false); setEditing(null); await load(); }}
        />
      )}

      {viewing && (
        <DispatchViewModal
          note={viewing}
          clientName={clientName(viewing.clientId)}
          onClose={() => setViewing(null)}
          onEdit={() => { openEdit(viewing); setViewing(null); }}
          onIssue={() => doAction(viewing.id, 'issue')}
          onComplete={() => doAction(viewing.id, 'complete')}
          onCancel={() => doAction(viewing.id, 'cancel', 'Cancel this dispatch note?')}
          onDelete={() => doDelete(viewing.id)}
          busy={busy}
        />
      )}
    </div>
  );
};

// ============================================================================
// EDITOR
// ============================================================================

const DispatchEditorModal: React.FC<ModuleDataProps & { type: DispatchNoteType; initial: DispatchNote | null; onClose: () => void; onSaved: () => void }> = ({ type, initial, onClose, onSaved, clients, clientOrders, items, triggerToast }) => {
  const meta = TYPE_META[type];
  const [clientId, setClientId] = useState<string>(initial?.clientId ? String(initial.clientId) : '');
  const [clientOrderId, setClientOrderId] = useState<string>(initial?.clientOrderId ? String(initial.clientOrderId) : '');
  const [noteDate, setNoteDate] = useState(initial?.noteDate?.slice(0, 10) || todayISO());
  const [scheduledDate, setScheduledDate] = useState(initial?.scheduledDate?.slice(0, 10) || '');
  const [contactPerson, setContactPerson] = useState(initial?.contactPerson || '');
  const [address, setAddress] = useState(initial?.address || '');
  const [carrier, setCarrier] = useState(initial?.carrier || '');
  const [reference, setReference] = useState(initial?.reference || '');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [lines, setLines] = useState<EditableItem[]>(
    initial?.items?.length
      ? initial.items.map(it => ({ key: `L${it.id}`, partNumber: it.partNumber, description: it.description, quantity: it.quantity, serialNumbers: it.serialNumbers }))
      : [newItem()]
  );
  const [saving, setSaving] = useState<'DRAFT' | 'ISSUED' | null>(null);
  const [productionProducts, setProductionProducts] = useState<{ modelNumber: string; description: string }[]>([]);

  useEffect(() => {
    apiGet('/api/production-products').then((pp: any[]) => setProductionProducts(pp.map(p => ({ modelNumber: p.model_number || p.modelNumber, description: p.description })))).catch(() => {});
  }, []);

  const relevantOrders = useMemo(() => clientOrders.filter(o => !clientId || String(o.clientId) === clientId), [clientOrders, clientId]);

  const prefillFromOrder = async (orderId: string) => {
    setClientOrderId(orderId);
    if (!orderId) return;
    try {
      const allItems = await apiGet('/api/client-order-items');
      const orderItems = Array.isArray(allItems) ? allItems.filter((it: any) => String(it.clientOrderId) === orderId) : [];
      if (orderItems.length) {
        setLines(orderItems.map((it: any) => ({ key: `O${it.id}`, partNumber: it.partNumber || '', description: it.description, quantity: it.quantity, serialNumbers: '' })));
        triggerToast(`Prefilled ${orderItems.length} item(s) from the order.`, 'INFO');
      }
    } catch {
      // prefill is best-effort
    }
  };

  const updateLine = (key: string, patch: Partial<EditableItem>) => setLines(ls => ls.map(l => l.key === key ? { ...l, ...patch } : l));
  const addLine = () => setLines(ls => [...ls, newItem()]);
  const removeLine = (key: string) => setLines(ls => ls.length > 1 ? ls.filter(l => l.key !== key) : ls);

  const onPickPart = (key: string, partNumber: string) => {
    const item = items.find(i => i.partNumber === partNumber);
    const pp = productionProducts.find(p => p.modelNumber === partNumber);
    updateLine(key, { partNumber, description: item ? item.name : pp ? pp.description : '' });
  };

  const submit = async (status: 'DRAFT' | 'ISSUED') => {
    const validLines = lines.filter(l => l.description.trim() && l.quantity > 0);
    if (!validLines.length) { triggerToast('Add at least one item.', 'ERROR'); return; }
    setSaving(status);
    try {
      const payload = {
        noteType: type,
        clientId: clientId ? Number(clientId) : null,
        clientOrderId: clientOrderId ? Number(clientOrderId) : null,
        noteDate, scheduledDate: scheduledDate || null,
        contactPerson, address, carrier, reference, notes, status,
        items: validLines.map(l => ({ partNumber: l.partNumber || undefined, description: l.description, quantity: l.quantity, serialNumbers: l.serialNumbers || undefined })),
      };
      if (initial) await apiPut(`/api/dispatch-notes/${initial.id}`, payload);
      else await apiPost('/api/dispatch-notes', payload);
      triggerToast(status === 'ISSUED' ? `${meta.label} issued.` : `${meta.label} saved as draft.`);
      onSaved();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to save', 'ERROR');
    } finally {
      setSaving(null);
    }
  };

  return (
    <Modal title={initial ? `Edit ${initial.noteNumber}` : `New ${meta.label}`} subtitle={`Fulfillment document for final project products — no ledger or stock impact.`} onClose={onClose} maxWidth="max-w-4xl">
      <div className="grid md:grid-cols-4 gap-3 mb-md">
        <div className="md:col-span-2">
          <FieldLabel>Client</FieldLabel>
          <select className={selectClass} value={clientId} onChange={(e) => { setClientId(e.target.value); setClientOrderId(''); }}>
            <option value="">Unassigned</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.clientName}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Note Date</FieldLabel>
          <input type="date" className={inputClass} value={noteDate} onChange={(e) => setNoteDate(e.target.value)} />
        </div>
        <div>
          <FieldLabel>{type === 'DELIVERY' ? 'Delivery date' : 'Collection date'}</FieldLabel>
          <input type="date" className={inputClass} value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <FieldLabel hint="Prefills line items from the order's products">Linked Sales Order</FieldLabel>
          <select className={selectClass} value={clientOrderId} onChange={(e) => prefillFromOrder(e.target.value)}>
            <option value="">None</option>
            {relevantOrders.map(o => <option key={o.id} value={o.id}>{o.orderNumber}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>{meta.partyLabel}</FieldLabel>
          <input className={inputClass} value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} placeholder="Name" />
        </div>
        <div>
          <FieldLabel>{type === 'DELIVERY' ? 'Carrier / courier' : 'Collected via'}</FieldLabel>
          <input className={inputClass} value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder={type === 'DELIVERY' ? 'e.g. Courier Guy' : 'e.g. Client vehicle'} />
        </div>
        <div className="md:col-span-3">
          <FieldLabel>{meta.addressLabel}</FieldLabel>
          <input className={inputClass} value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div>
          <FieldLabel hint="Waybill / order ref">Reference</FieldLabel>
          <input className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
      </div>

      <div className="rounded-lg border border-outline-variant overflow-hidden mb-md">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="bg-surface-container-high/50 text-outline text-[10px] uppercase">
              <th className="py-2 px-3">Part #</th>
              <th className="py-2 px-3">Description</th>
              <th className="py-2 px-3 w-20 text-right">Qty</th>
              <th className="py-2 px-3">Serial number(s)</th>
              <th className="py-2 px-3 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map(l => (
              <tr key={l.key} className="border-t border-outline-variant/20">
                <td className="py-1.5 px-2">
                  <select className={`${inputClass} !py-1`} value={l.partNumber || ''} onChange={(e) => onPickPart(l.key, e.target.value)}>
                    <option value="">— free text —</option>
                    {productionProducts.length > 0 && <optgroup label="Production Products">
                      {productionProducts.map(p => <option key={p.modelNumber} value={p.modelNumber}>{p.modelNumber}</option>)}
                    </optgroup>}
                    <optgroup label="Inventory Items">
                      {items.map(i => <option key={i.partNumber} value={i.partNumber}>{i.partNumber}</option>)}
                    </optgroup>
                  </select>
                </td>
                <td className="py-1.5 px-2"><input className={`${inputClass} !py-1`} value={l.description} onChange={(e) => updateLine(l.key, { description: e.target.value })} placeholder="Item description" /></td>
                <td className="py-1.5 px-2"><input type="number" min={0} step="1" className={`${inputClass} !py-1 text-right`} value={l.quantity} onChange={(e) => updateLine(l.key, { quantity: parseFloat(e.target.value) || 0 })} /></td>
                <td className="py-1.5 px-2"><input className={`${inputClass} !py-1`} value={l.serialNumbers || ''} onChange={(e) => updateLine(l.key, { serialNumbers: e.target.value })} placeholder="Optional" /></td>
                <td className="py-1.5 px-2 text-center">
                  <button type="button" onClick={() => removeLine(l.key)} className="text-outline hover:text-error p-1" title="Remove"><X className="w-3.5 h-3.5" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="p-2 border-t border-outline-variant/20">
          <SecondaryButton icon={<Plus className="w-3 h-3" />} onClick={addLine}>Add item</SecondaryButton>
        </div>
      </div>

      <div>
        <FieldLabel>Notes</FieldLabel>
        <textarea className={inputClass} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="flex justify-end gap-2 pt-md mt-md border-t border-outline-variant/20">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <SecondaryButton onClick={() => submit('DRAFT')} disabled={!!saving}>{saving === 'DRAFT' ? 'Saving...' : 'Save Draft'}</SecondaryButton>
        <PrimaryButton icon={<Send className="w-3.5 h-3.5" />} onClick={() => submit('ISSUED')} disabled={!!saving}>{saving === 'ISSUED' ? 'Issuing...' : 'Issue'}</PrimaryButton>
      </div>
    </Modal>
  );
};

// ============================================================================
// VIEW + PRINT
// ============================================================================

const DispatchViewModal: React.FC<{
  note: DispatchNote; clientName: string; onClose: () => void; onEdit: () => void;
  onIssue: () => void; onComplete: () => void; onCancel: () => void; onDelete: () => void; busy: boolean;
}> = ({ note, clientName, onClose, onEdit, onIssue, onComplete, onCancel, onDelete, busy }) => {
  const meta = TYPE_META[note.noteType];

  const printNote = () => {
    const rowsHtml = (note.items || []).map((it: DispatchNoteItem) => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #ddd;font-family:monospace">${it.partNumber || ''}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #ddd">${escapeHtml(it.description)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #ddd;text-align:right">${it.quantity}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #ddd;font-family:monospace">${escapeHtml(it.serialNumbers || '')}</td>
      </tr>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${note.noteNumber}</title></head>
      <body style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:760px;margin:24px auto;padding:0 16px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:12px;margin-bottom:16px">
          <div><h1 style="margin:0;font-size:22px">${meta.label.toUpperCase()}</h1>
          <div style="font-family:monospace;font-size:14px;margin-top:4px">${note.noteNumber}</div></div>
          <div style="text-align:right;font-size:12px">
            <div><strong>Date:</strong> ${fmtDate(note.noteDate)}</div>
            ${note.scheduledDate ? `<div><strong>${note.noteType === 'DELIVERY' ? 'Delivery' : 'Collection'} date:</strong> ${fmtDate(note.scheduledDate)}</div>` : ''}
            <div><strong>Status:</strong> ${note.status}</div>
          </div>
        </div>
        <div style="display:flex;gap:32px;font-size:12px;margin-bottom:16px">
          <div><div style="color:#666;text-transform:uppercase;font-size:10px">Client</div><div>${escapeHtml(clientName)}</div>
          ${note.orderNumber ? `<div style="color:#666;margin-top:6px;text-transform:uppercase;font-size:10px">Order</div><div>${escapeHtml(note.orderNumber)}</div>` : ''}</div>
          <div>
          ${note.contactPerson ? `<div style="color:#666;text-transform:uppercase;font-size:10px">${meta.partyLabel}</div><div>${escapeHtml(note.contactPerson)}</div>` : ''}
          ${note.address ? `<div style="color:#666;margin-top:6px;text-transform:uppercase;font-size:10px">${meta.addressLabel}</div><div>${escapeHtml(note.address)}</div>` : ''}
          ${note.carrier ? `<div style="color:#666;margin-top:6px;text-transform:uppercase;font-size:10px">${note.noteType === 'DELIVERY' ? 'Carrier' : 'Collected via'}</div><div>${escapeHtml(note.carrier)}</div>` : ''}
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:#f3f3f3">
            <th style="padding:6px 8px;text-align:left">Part #</th>
            <th style="padding:6px 8px;text-align:left">Description</th>
            <th style="padding:6px 8px;text-align:right">Qty</th>
            <th style="padding:6px 8px;text-align:left">Serial #</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        ${note.notes ? `<p style="font-size:11px;color:#444;margin-top:16px;font-style:italic">${escapeHtml(note.notes)}</p>` : ''}
        <div style="display:flex;gap:48px;margin-top:56px;font-size:11px">
          <div style="flex:1;border-top:1px solid #111;padding-top:6px">Issued by (signature &amp; date)</div>
          <div style="flex:1;border-top:1px solid #111;padding-top:6px">Received by (signature &amp; date)</div>
        </div>
      </body></html>`;
    const w = window.open('', '_blank', 'width=820,height=900');
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <Modal title={note.noteNumber} subtitle={`${meta.label} · ${clientName}`} onClose={onClose} maxWidth="max-w-2xl">
      <div className="flex items-center gap-2 mb-md flex-wrap">
        <StatusPill status={note.status} />
        <span className="text-xs text-on-surface-variant">{fmtDate(note.noteDate)}</span>
        {note.orderNumber && <span className="text-[10px] text-outline font-mono">Order {note.orderNumber}</span>}
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs mb-md">
        {note.contactPerson && <div><span className="block text-[10px] text-outline uppercase">{meta.partyLabel}</span>{note.contactPerson}</div>}
        {note.scheduledDate && <div><span className="block text-[10px] text-outline uppercase">{note.noteType === 'DELIVERY' ? 'Delivery date' : 'Collection date'}</span>{fmtDate(note.scheduledDate)}</div>}
        {note.address && <div className="col-span-2"><span className="block text-[10px] text-outline uppercase">{meta.addressLabel}</span>{note.address}</div>}
        {note.carrier && <div><span className="block text-[10px] text-outline uppercase">{note.noteType === 'DELIVERY' ? 'Carrier' : 'Collected via'}</span>{note.carrier}</div>}
        {note.reference && <div><span className="block text-[10px] text-outline uppercase">Reference</span>{note.reference}</div>}
      </div>

      <div className="overflow-x-auto rounded-lg border border-outline-variant/40 mb-md">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="bg-surface-container-high/50 text-outline text-[10px] uppercase">
              <th className="py-2 px-3">Part #</th>
              <th className="py-2 px-3">Description</th>
              <th className="py-2 px-3 text-right">Qty</th>
              <th className="py-2 px-3">Serial #</th>
            </tr>
          </thead>
          <tbody>
            {(note.items || []).map((it) => (
              <tr key={it.id} className="border-t border-outline-variant/20">
                <td className="py-2 px-3 font-mono text-on-surface-variant">{it.partNumber || '—'}</td>
                <td className="py-2 px-3">{it.description}</td>
                <td className="py-2 px-3 text-right font-mono">{it.quantity}</td>
                <td className="py-2 px-3 font-mono text-on-surface-variant">{it.serialNumbers || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note.notes && <p className="text-xs text-on-surface-variant mb-md italic">{note.notes}</p>}

      <div className="flex flex-wrap gap-2 justify-end pt-2 border-t border-outline-variant/20">
        <SecondaryButton icon={<Printer className="w-3.5 h-3.5" />} onClick={printNote}>Print</SecondaryButton>
        {note.status === 'DRAFT' && (
          <>
            <SecondaryButton onClick={onEdit}>Edit</SecondaryButton>
            <DangerButton icon={<Trash2 className="w-3.5 h-3.5" />} onClick={onDelete} disabled={busy}>Delete</DangerButton>
            <PrimaryButton icon={<Send className="w-3.5 h-3.5" />} onClick={onIssue} disabled={busy}>Issue</PrimaryButton>
          </>
        )}
        {note.status === 'ISSUED' && (
          <>
            <DangerButton icon={<Ban className="w-3.5 h-3.5" />} onClick={onCancel} disabled={busy}>Cancel</DangerButton>
            <PrimaryButton icon={<CheckCircle2 className="w-3.5 h-3.5" />} onClick={onComplete} disabled={busy}>Mark {meta.verb}</PrimaryButton>
          </>
        )}
      </div>
    </Modal>
  );
};

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
