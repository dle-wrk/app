import React, { useMemo, useState } from 'react';
import { Plus, Printer, Ban, Eye, Wallet, FileText } from 'lucide-react';
import { Invoice, InvoiceItem } from '../../types';
import { ModuleDataProps, Modal, StatusPill, fmtMoney, fmtDate, todayISO, addDaysISO, apiPost, apiPut, apiDelete, apiGet, PrimaryButton, SecondaryButton, DangerButton, FieldLabel, inputClass, selectClass, EmptyState, SectionCard } from './shared';
import { LineItemsEditor, EditableLine, newEditableLine, lineTotals } from './LineItemsEditor';
import { ErrorBoundary } from '../ErrorBoundary';
import { confirmDialog } from '../../lib/confirmDialog';
import { renderBrandHeader, waitForBrandImage } from '../../lib/printBrand';

const STATUS_FILTERS = ['ALL', 'DRAFT', 'SENT', 'PARTIAL', 'PAID', 'OVERDUE', 'VOID'];

export const InvoicesTab: React.FC<ModuleDataProps> = (props) => {
  const { invoices, setInvoices, clients, items, taxRates, triggerToast, refresh } = props;
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [showEditor, setShowEditor] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<Invoice | null>(null);
  const [viewingInvoice, setViewingInvoice] = useState<Invoice | null>(null);
  const [payingInvoice, setPayingInvoice] = useState<Invoice | null>(null);
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => invoices.filter(i => statusFilter === 'ALL' || i.status === statusFilter), [invoices, statusFilter]);

  const totals = useMemo(() => ({
    outstanding: invoices.filter(i => ['SENT', 'PARTIAL', 'OVERDUE'].includes(i.status)).reduce((s, i) => s + i.balanceDue, 0),
    overdue: invoices.filter(i => i.status === 'OVERDUE').reduce((s, i) => s + i.balanceDue, 0),
    draftCount: invoices.filter(i => i.status === 'DRAFT').length,
  }), [invoices]);

  const openView = async (inv: Invoice) => {
    try {
      const full = await apiGet(`/api/invoices/${inv.id}`);
      setViewingInvoice(full);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load invoice', 'ERROR');
    }
  };

  const openEdit = async (inv: Invoice) => {
    try {
      const full = await apiGet(`/api/invoices/${inv.id}`);
      setEditingInvoice(full);
      setShowEditor(true);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load invoice', 'ERROR');
    }
  };

  const handleFinalize = async (id: number) => {
    setBusy(true);
    try {
      await apiPost(`/api/invoices/${id}/finalize`);
      triggerToast('Invoice sent and posted to the ledger.');
      // Grab the refreshed invoice (which now has status=SENT + finalized
      // journal id) so we can hand it straight into the printable window.
      // Failing to fetch just skips the print — status change already happened.
      try {
        const fresh = await apiGet(`/api/invoices/${id}`);
        if (fresh) printInvoice(fresh, clientName(fresh.clientId));
      } catch { /* swallow — finalize succeeded, print is bonus */ }
      await refresh();
      setViewingInvoice(null);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to finalize invoice', 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  const clientName = (id?: number) => clients.find(c => c.id === id)?.clientName || 'Unassigned';

  // Optimistic void: flip the row's status to VOID immediately + zero the
  // balance_due so the "outstanding" tile stops counting it. Trigger a
  // background refresh() to reconcile the aggregate totals (which include
  // the reversing journal entry the server posts). If the void fails, the
  // snapshot restores the row and an error toast surfaces.
  const handleVoid = async (id: number) => {
    if (!(await confirmDialog({ title: 'Void invoice', message: 'Void this invoice? This posts a reversing journal entry and cannot be undone.', confirmLabel: 'Void', destructive: true }))) return;
    const snap = invoices;
    setInvoices?.(prev => prev.map(i => i.id === id ? { ...i, status: 'VOID', balanceDue: 0 } : i));
    setViewingInvoice(null);
    try {
      await apiPost(`/api/invoices/${id}/void`);
      triggerToast('Invoice voided.');
      // Fire and forget — refresh reconciles totals but we already gave the
      // user their visual feedback.
      void refresh();
    } catch (err: any) {
      setInvoices?.(snap);
      triggerToast(err.message || 'Failed to void invoice', 'ERROR');
    }
  };

  const handleDeleteDraft = async (id: number) => {
    if (!(await confirmDialog({ title: 'Delete draft invoice', message: 'Delete this draft invoice permanently?', confirmLabel: 'Delete', destructive: true }))) return;
    const snap = invoices;
    setInvoices?.(prev => prev.filter(i => i.id !== id));
    setViewingInvoice(null);
    try {
      await apiDelete(`/api/invoices/${id}`);
      triggerToast('Draft invoice deleted.');
      void refresh();
    } catch (err: any) {
      setInvoices?.(snap);
      triggerToast(err.message || 'Failed to delete invoice', 'ERROR');
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-md">
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
          <span className="text-[11px] text-on-surface-variant font-bold block mb-1">Outstanding (AR)</span>
          <span className="text-xl font-black text-primary">{fmtMoney(totals.outstanding)}</span>
        </div>
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
          <span className="text-[11px] text-on-surface-variant font-bold block mb-1">Overdue</span>
          <span className="text-xl font-black text-error">{fmtMoney(totals.overdue)}</span>
        </div>
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
          <span className="text-[11px] text-on-surface-variant font-bold block mb-1">Drafts pending</span>
          <span className="text-xl font-black text-on-surface">{totals.draftCount}</span>
        </div>
      </div>

      <SectionCard
        title="Invoices"
        actions={
          <>
            <div className="hidden md:flex gap-1">
              {STATUS_FILTERS.map(s => (
                <button key={s} onClick={() => setStatusFilter(s)} className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-colors ${statusFilter === s ? 'bg-primary text-white border-primary' : 'bg-surface-container-high text-on-surface-variant border-outline-variant'}`}>{s}</button>
              ))}
            </div>
            <PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => { setEditingInvoice(null); setShowEditor(true); }}>New Invoice</PrimaryButton>
          </>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">Invoice #</th>
                <th className="px-lg py-sm">Client</th>
                <th className="px-lg py-sm">Date</th>
                <th className="px-lg py-sm">Due</th>
                <th className="px-lg py-sm text-right">Total</th>
                <th className="px-lg py-sm text-right">Balance Due</th>
                <th className="px-lg py-sm">Status</th>
                <th className="px-lg py-sm text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {filtered.map(inv => (
                <tr key={inv.id} className="hover:bg-surface-variant/20 transition-all">
                  <td className="px-lg py-sm font-mono text-primary font-bold cursor-pointer" onClick={() => openView(inv)}>
                    {inv.invoiceNumber}
                    {inv.isWarrantyClaim && <span className="ml-1.5 inline-block px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wide bg-tertiary/15 text-tertiary align-middle">Warranty</span>}
                  </td>
                  <td className="px-lg py-sm font-semibold">{inv.clientName || 'Unassigned'}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(inv.invoiceDate)}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(inv.dueDate)}</td>
                  <td className="px-lg py-sm text-right font-mono">{fmtMoney(inv.total, inv.currency)}</td>
                  <td className="px-lg py-sm text-right font-mono font-bold">{fmtMoney(inv.balanceDue, inv.currency)}</td>
                  <td className="px-lg py-sm"><StatusPill status={inv.status} /></td>
                  <td className="px-lg py-sm text-right">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => openView(inv)} className="p-1.5 rounded hover:bg-surface-container-high text-on-surface-variant" title="View"><Eye className="w-3.5 h-3.5" /></button>
                      {['SENT', 'PARTIAL', 'OVERDUE'].includes(inv.status) && (
                        <button onClick={() => setPayingInvoice(inv)} className="p-1.5 rounded hover:bg-surface-container-high text-green-400" title="Record payment"><Wallet className="w-3.5 h-3.5" /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && <EmptyState message="No invoices match this filter yet." colSpan={8} />}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {showEditor && (
        <InvoiceEditorModal
          {...props}
          initial={editingInvoice}
          onClose={() => { setShowEditor(false); setEditingInvoice(null); }}
          onSaved={async () => { setShowEditor(false); setEditingInvoice(null); await refresh(); }}
        />
      )}

      {viewingInvoice && (
        <Modal title={viewingInvoice.invoiceNumber} subtitle={`${viewingInvoice.clientName || 'Unassigned client'} · ${fmtDate(viewingInvoice.invoiceDate)}`} onClose={() => setViewingInvoice(null)} maxWidth="max-w-2xl">
          <div className="flex items-center gap-2 mb-md">
            <StatusPill status={viewingInvoice.status} />
            {viewingInvoice.isWarrantyClaim && <span className="inline-block px-2 py-0.5 rounded-full text-[9px] font-bold border bg-tertiary/10 text-tertiary border-tertiary/20">WARRANTY CLAIM</span>}
            <span className="text-xs text-on-surface-variant">Due {fmtDate(viewingInvoice.dueDate)}</span>
          </div>
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
                {(viewingInvoice.items || []).map((it: InvoiceItem) => (
                  <tr key={it.id} className="border-t border-outline-variant/20">
                    <td className="py-2 px-3">{it.description}{it.partNumber && <span className="block text-[10px] text-outline font-mono">{it.partNumber}</span>}</td>
                    <td className="py-2 px-3 text-right font-mono">{it.quantity}</td>
                    <td className="py-2 px-3 text-right font-mono">{fmtMoney(it.unitPrice, viewingInvoice.currency)}</td>
                    <td className="py-2 px-3 text-right font-mono font-bold">{fmtMoney(it.lineTotal, viewingInvoice.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end mb-md">
            <div className="w-56 space-y-1 text-xs">
              <div className="flex justify-between"><span className="text-on-surface-variant">Subtotal</span><span className="font-mono">{fmtMoney(viewingInvoice.subtotal, viewingInvoice.currency)}</span></div>
              <div className="flex justify-between"><span className="text-on-surface-variant">Tax</span><span className="font-mono">{fmtMoney(viewingInvoice.taxTotal, viewingInvoice.currency)}</span></div>
              <div className="flex justify-between font-bold"><span>Total</span><span className="font-mono text-primary">{fmtMoney(viewingInvoice.total, viewingInvoice.currency)}</span></div>
              <div className="flex justify-between text-green-400"><span>Paid</span><span className="font-mono">{fmtMoney(viewingInvoice.amountPaid, viewingInvoice.currency)}</span></div>
              <div className="flex justify-between font-bold border-t border-outline-variant/30 pt-1"><span>Balance Due</span><span className="font-mono">{fmtMoney(viewingInvoice.balanceDue, viewingInvoice.currency)}</span></div>
            </div>
          </div>
          {viewingInvoice.notes && <p className="text-xs text-on-surface-variant mb-md italic">{viewingInvoice.notes}</p>}
          <div className="flex flex-wrap gap-2 justify-end pt-2 border-t border-outline-variant/20">
            {/* Print is available on any status so the user can pull a hard copy
                after payment / warranty claims / reprint requests. Draft prints
                are watermarked implicitly by the DRAFT status pill in the header. */}
            <SecondaryButton
              icon={<Printer className="w-3.5 h-3.5" />}
              onClick={() => printInvoice(viewingInvoice, clientName(viewingInvoice.clientId))}
            >
              Print
            </SecondaryButton>
            {viewingInvoice.status === 'DRAFT' && (
              <>
                <SecondaryButton onClick={() => { openEdit(viewingInvoice); setViewingInvoice(null); }}>Edit</SecondaryButton>
                <DangerButton onClick={() => handleDeleteDraft(viewingInvoice.id)} disabled={busy}>Delete</DangerButton>
                {/* Renamed from "Finalize & Print" — it changes DRAFT → SENT and
                    posts to the ledger. The auto-print piggybacks on that
                    transition for the client-facing hard copy. */}
                <PrimaryButton icon={<Printer className="w-3.5 h-3.5" />} onClick={() => handleFinalize(viewingInvoice.id)} disabled={busy}>Finalize &amp; Send</PrimaryButton>
              </>
            )}
            {['SENT', 'PARTIAL', 'OVERDUE'].includes(viewingInvoice.status) && (
              <>
                <PrimaryButton icon={<Wallet className="w-3.5 h-3.5" />} onClick={() => { setPayingInvoice(viewingInvoice); setViewingInvoice(null); }}>Record Payment</PrimaryButton>
                <DangerButton icon={<Ban className="w-3.5 h-3.5" />} onClick={() => handleVoid(viewingInvoice.id)} disabled={busy}>Void</DangerButton>
              </>
            )}
          </div>
        </Modal>
      )}

      {payingInvoice && (
        <QuickPaymentModal
          invoice={payingInvoice}
          accounts={props.accounts}
          triggerToast={triggerToast}
          onClose={() => setPayingInvoice(null)}
          onSaved={async () => { setPayingInvoice(null); await refresh(); }}
        />
      )}
    </div>
  );
};

// ============================================================================
// EDITOR MODAL
// ============================================================================

const InvoiceEditorModal: React.FC<ModuleDataProps & { initial: Invoice | null; onClose: () => void; onSaved: () => void }> = ({ initial, onClose, onSaved, clients, items, taxRates, clientOrders, triggerToast }) => {
  const [clientId, setClientId] = useState<string>(initial?.clientId ? String(initial.clientId) : '');
  const [invoiceDate, setInvoiceDate] = useState(initial?.invoiceDate?.slice(0, 10) || todayISO());
  const [dueDate, setDueDate] = useState(initial?.dueDate?.slice(0, 10) || addDaysISO(30));
  const [currency, setCurrency] = useState(initial?.currency || 'ZAR');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [terms, setTerms] = useState(initial?.terms || 'Payment due within 30 days.');
  const [isWarrantyClaim, setIsWarrantyClaim] = useState<boolean>(initial?.isWarrantyClaim ?? false);
  const [lines, setLines] = useState<EditableLine[]>(
    initial?.items?.length
      ? initial.items.map(it => ({ key: `L${it.id}`, partNumber: it.partNumber, description: it.description, quantity: it.quantity, unitPrice: it.unitPrice, taxRateId: it.taxRateId ?? null, deductStock: it.deductStock }))
      : [newEditableLine()]
  );
  const [saving, setSaving] = useState<'DRAFT' | 'SENT' | null>(null);

  const relevantOrders = clientOrders.filter(o => !clientId || String(o.clientId) === clientId);

  const submit = async (status: 'DRAFT' | 'SENT') => {
    const validLines = lines.filter(l => l.description.trim() && l.quantity > 0);
    if (!validLines.length) { triggerToast('Add at least one line item.', 'ERROR'); return; }
    setSaving(status);
    try {
      const payload = {
        clientId: clientId ? Number(clientId) : null,
        invoiceDate, dueDate, currency, notes, terms, status, isWarrantyClaim,
        items: validLines.map(l => ({ partNumber: l.partNumber || undefined, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRateId: l.taxRateId || undefined, deductStock: !!l.deductStock })),
      };
      if (initial) {
        await apiPut(`/api/invoices/${initial.id}`, payload);
      } else {
        await apiPost('/api/invoices', payload);
      }
      triggerToast(status === 'SENT' ? 'Invoice finalized and posted to the ledger.' : 'Invoice saved as draft.');
      onSaved();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to save invoice', 'ERROR');
    } finally {
      setSaving(null);
    }
  };

  // Ensure required data exists
  const safeItems = Array.isArray(items) ? items : [];
  const safeTaxRates = Array.isArray(taxRates) ? taxRates : [];

  return (
    <Modal title={initial ? `Edit ${initial.invoiceNumber}` : 'New Invoice'} subtitle="Draft first, then finalize to post to the ledger and (optionally) deduct stock." onClose={onClose} maxWidth="max-w-4xl">
      <div className="grid md:grid-cols-4 gap-3 mb-md">
        <div className="md:col-span-2">
          <FieldLabel>Customer</FieldLabel>
          <select className={selectClass} value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">Unassigned / Cash sale</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.clientName}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Invoice Date</FieldLabel>
          <input type="date" className={inputClass} value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </div>
        <div>
          <FieldLabel>Due Date</FieldLabel>
          <input type="date" className={inputClass} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
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
        {relevantOrders.length > 0 && (
          <div className="md:col-span-3">
            <FieldLabel hint="Optional — links this invoice back to a sales order for traceability">Related Sales Order</FieldLabel>
            <select className={selectClass} defaultValue="">
              <option value="">None</option>
              {relevantOrders.map(o => <option key={o.id} value={o.id}>{o.orderNumber}</option>)}
            </select>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 mb-md rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2.5">
        <div>
          <span className="block text-xs font-bold text-on-surface">Warranty claim</span>
          <span className="block text-[10px] text-outline">On by default. Turn off to record this as a normal sale.</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isWarrantyClaim}
          onClick={() => setIsWarrantyClaim(v => !v)}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${isWarrantyClaim ? 'bg-primary' : 'bg-outline-variant'}`}
        >
          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${isWarrantyClaim ? 'translate-x-4.5' : 'translate-x-1'}`} />
        </button>
      </div>

      <ErrorBoundary>
        <LineItemsEditor lines={lines} onChange={setLines} items={safeItems} taxRates={safeTaxRates} mode="SALES" currency={currency} isWarrantyClaim={isWarrantyClaim} />
      </ErrorBoundary>

      <div className="grid md:grid-cols-2 gap-3 mt-md">
        <div>
          <FieldLabel>Notes (visible to customer)</FieldLabel>
          <textarea className={inputClass} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div>
          <FieldLabel>Terms</FieldLabel>
          <textarea className={inputClass} rows={2} value={terms} onChange={(e) => setTerms(e.target.value)} />
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-md mt-md border-t border-outline-variant/20">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <SecondaryButton onClick={() => submit('DRAFT')} disabled={!!saving}>{saving === 'DRAFT' ? 'Saving...' : 'Save Draft'}</SecondaryButton>
        <PrimaryButton icon={<Printer className="w-3.5 h-3.5" />} onClick={() => submit('SENT')} disabled={!!saving}>{saving === 'SENT' ? 'Printing...' : 'Finalize & Print'}</PrimaryButton>
      </div>
    </Modal>
  );
};

// ============================================================================
// QUICK PAYMENT MODAL (single-invoice shortcut)
// ============================================================================

const QuickPaymentModal: React.FC<{ invoice: Invoice; accounts: ModuleDataProps['accounts']; onClose: () => void; onSaved: () => void; triggerToast: ModuleDataProps['triggerToast'] }> = ({ invoice, accounts, onClose, onSaved, triggerToast }) => {
  const bankAccounts = accounts.filter(a => a.subtype === 'BANK' || a.subtype === 'CASH');
  const [amount, setAmount] = useState(invoice.balanceDue);
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [method, setMethod] = useState('EFT');
  const [depositAccountId, setDepositAccountId] = useState<string>(String(bankAccounts[0]?.id || ''));
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!depositAccountId) { triggerToast('Choose which account received the funds.', 'ERROR'); return; }
    if (amount <= 0) { triggerToast('Amount must be greater than zero.', 'ERROR'); return; }
    setSaving(true);
    try {
      await apiPost('/api/payments-received', {
        clientId: invoice.clientId || null,
        paymentDate, amount, method, depositAccountId: Number(depositAccountId), reference,
        allocations: [{ invoiceId: invoice.id, amountApplied: Math.min(amount, invoice.balanceDue) }],
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
    <Modal title={`Record payment — ${invoice.invoiceNumber}`} subtitle={`Balance due: ${fmtMoney(invoice.balanceDue, invoice.currency)}`} onClose={onClose} maxWidth="max-w-md">
      <div className="space-y-3">
        <div>
          <FieldLabel>Amount received</FieldLabel>
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
              <option value="EFT">EFT</option>
              <option value="CARD">Card</option>
              <option value="CASH">Cash</option>
              <option value="CHEQUE">Cheque</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
        </div>
        <div>
          <FieldLabel hint={bankAccounts.length === 0 ? 'No bank/cash accounts found — add one in Chart of Accounts.' : undefined}>Deposited to</FieldLabel>
          <select className={selectClass} value={depositAccountId} onChange={(e) => setDepositAccountId(e.target.value)}>
            <option value="">Select account</option>
            {bankAccounts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Reference</FieldLabel>
          <input className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. EFT ref, cheque #" />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-md mt-md border-t border-outline-variant/20">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton icon={<Wallet className="w-3.5 h-3.5" />} onClick={submit} disabled={saving}>{saving ? 'Saving...' : 'Record Payment'}</PrimaryButton>
      </div>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Printable invoice — TRACKLAB-branded HTML opened in a new tab.
// Same pattern as the sales-order and dispatch-note prints: inline HTML +
// window.print(), no library dependency. Draft invoices print with a big
// "DRAFT" watermark so a print-and-send accident on a non-finalised invoice
// is obvious rather than hidden.
// ---------------------------------------------------------------------------
async function printInvoice(inv: any, clientName: string): Promise<void> {
  const money = (n: number) => fmtMoney(n, inv.currency);
  const items = (inv.items || []) as InvoiceItem[];
  const rows = items.map((it) => `
    <tr>
      <td>${it.partNumber ? `<span class="pn">${escapeHtml(it.partNumber)}</span> ` : ''}${escapeHtml(it.description)}</td>
      <td class="num">${it.quantity}</td>
      <td class="num">${escapeHtml(money(it.unitPrice))}</td>
      <td class="num strong">${escapeHtml(money(it.lineTotal))}</td>
    </tr>
  `).join('');

  const balanceDue = Number(inv.balanceDue ?? 0);
  const amountPaid = Number(inv.amountPaid ?? 0);

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(inv.invoiceNumber)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111; margin: 0; padding: 40px; position: relative; }
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
  .totals table { width: 280px; }
  .totals td { padding: 6px 4px; border: 0; font-size: 12px; }
  .totals tr.total td { font-size: 15px; font-weight: 800; border-top: 2px solid #333; padding-top: 10px; }
  .totals tr.balance td { color: ${balanceDue > 0 ? '#c2410c' : '#166534'}; font-weight: 700; padding-top: 6px; }
  .notes { margin-top: 16px; padding: 12px; background: #fafafa; border-left: 3px solid #f7912b; font-size: 12px; }
  .paystub { margin-top: 24px; padding: 12px 16px; border: 1px dashed #999; border-radius: 6px; font-size: 11px; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 10px; color: #999; text-align: center; }
  .draft-watermark { position: fixed; top: 40%; left: 50%; transform: translate(-50%, -50%) rotate(-30deg); font-size: 140px; font-weight: 900; color: rgba(200,50,50,0.08); letter-spacing: 8px; pointer-events: none; z-index: 0; }
  .content { position: relative; z-index: 1; }
  @media print { body { padding: 20px; } }
</style></head><body>
  ${inv.status === 'DRAFT' ? '<div class="draft-watermark">DRAFT</div>' : ''}
  <div class="content">
    ${renderBrandHeader({ title: inv.isWarrantyClaim ? 'Warranty Invoice' : 'Tax Invoice', number: inv.invoiceNumber })}

    <div class="grid">
      <div>
        <div class="label">Bill To</div>
        <div class="val">${escapeHtml(clientName)}</div>
      </div>
      <div>
        <div class="label">Status</div>
        <div class="val">${escapeHtml(inv.status)}</div>
      </div>
      <div>
        <div class="label">Invoice Date</div>
        <div class="val">${escapeHtml(fmtDate(inv.invoiceDate))}</div>
      </div>
      <div>
        <div class="label">Due Date</div>
        <div class="val">${escapeHtml(inv.dueDate ? fmtDate(inv.dueDate) : '—')}</div>
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
        <tr><td>Subtotal</td><td class="num">${escapeHtml(money(inv.subtotal))}</td></tr>
        <tr><td>Tax</td><td class="num">${escapeHtml(money(inv.taxTotal))}</td></tr>
        <tr class="total"><td>Total</td><td class="num">${escapeHtml(money(inv.total))}</td></tr>
        ${amountPaid > 0 ? `<tr><td>Paid</td><td class="num" style="color:#166534">${escapeHtml(money(amountPaid))}</td></tr>` : ''}
        <tr class="balance"><td>Balance Due</td><td class="num">${escapeHtml(money(balanceDue))}</td></tr>
      </table>
    </div>

    ${inv.notes ? `<div class="notes"><strong>Notes:</strong> ${escapeHtml(inv.notes)}</div>` : ''}

    ${balanceDue > 0 ? `<div class="paystub">
      <strong>Payment reference:</strong> ${escapeHtml(inv.invoiceNumber)}<br>
      Please quote this reference when making payment so we can allocate it correctly.
    </div>` : ''}

    <div class="footer">TRACKLAB IM · ${escapeHtml(fmtDate(inv.invoiceDate))} · Generated ${escapeHtml(new Date().toLocaleString())}</div>
  </div>
</body></html>`;

  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  // Wait for the logo before firing print. See printBrand.ts header for why.
  await waitForBrandImage(w);
  w.print();
}

function escapeHtml(s: any): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}
