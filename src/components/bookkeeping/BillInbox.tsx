// Purchases > Bills: bills sent from the scanner (From the scanner), and
// filling in what existing bills and their suppliers are missing from their
// attached photos. Server: src/lib/billScans.ts; reading: src/lib/billOcr.ts.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileText, Loader2, Paperclip, RefreshCw, ScanLine, Sparkles, Trash2, Wand2 } from 'lucide-react';
import type { Bill } from '../../types';
import { Modal, PrimaryButton, SecondaryButton, DangerButton, SectionCard, apiGet, apiPost, fmtMoney, fmtDate, selectClass } from './shared';
import { canChange } from '../../lib/changeAccess';
import { confirmDialog } from '../../lib/confirmDialog';
import { openReceiptPage, receiptPages } from '../../lib/receiptPages';

export interface BillOcr {
  supplier: string | null; supplierVatNumber: string | null; supplierAddress: string | null; supplierPhone: string | null;
  supplierEmail: string | null; supplierWebsite: string | null; invoiceNumber: string | null; date: string | null; dueDate: string | null;
  poNumber: string | null; currency: string | null; subtotal: number | null; taxTotal: number | null; total: number | null;
  lineItems: { description: string; partNumber: string | null; quantity: number; unitPrice: number; lineTotal: number }[];
}
export interface BillScan {
  id: number; status: 'INBOX' | 'USED' | 'DISCARDED'; pageCount: number; thumb: string | null; pages?: string[]; note: string | null;
  user: { id: number | null; name: string }; capturedAt: string | null; createdAt: string;
  read: { status: 'WAITING' | 'READ' | 'FAILED' | 'OFF'; error: string | null; at: string | null };
  ocr: BillOcr | null; warnings: string[];
  match: ReadMatch | null;
  billId: number | null; billNumber: string | null;
}

/** What a read invoice matched in Tracklab, with what its supplier's earlier bills taught (src/lib/billScans matchesFor). */
export interface ReadMatch {
  supplier: { id: string; name: string; by: 'vat' | 'name' | 'web' } | null;
  po: { id: number; number: string; supplierId: string | null; status: string } | null;
  dueDate: string | null;
  invoiceNumber?: string | null;
  /** How many of this supplier's bills the reading learned from. */
  learnedFrom?: number;
  lines: { partNumber: string | null; item: string | null; description?: string | null; accountId?: number | null; taxRateId?: number | null; learned?: boolean }[];
}

/** What the bill form is filled with from a scan (BillsTab's BillEditorModal). */
export interface ScanPrefill {
  supplierName: string | null; supplierId?: string | null; supplierInvoiceNumber?: string | null;
  date: string | null; dueDate?: string | null; currency?: string | null; total: number | null;
  /** Before VAT, and the VAT, as read off the invoice. */
  subtotal?: number | null; taxTotal?: number | null;
  purchaseOrderId?: number | null; receiptImage: string | null;
  lineItems: { description: string; quantity: number; unitPrice: number; partNumber?: string | null; accountId?: number | null; taxRateId?: number | null }[];
  billScanId?: number; warnings?: string[];
  /** What was read, kept with the saved bill so the supplier's invoices are learned (src/lib/billLearning). */
  ocr?: BillOcr | null;
  /** How many of this supplier's earlier bills filled it in. */
  learnedFrom?: number;
  /** The supplier's details the invoice shows, offered for filling where the supplier has none. */
  supplierDetails?: { vatNumber: string | null; address: string | null; phone: string | null; email: string | null; website: string | null };
}

/** The bill form's starting point from a scanned bill: what was read, with what it matched in Tracklab. */
export function prefillFromBillScan(s: BillScan, pages: string[]): ScanPrefill {
  return { ...prefillFromRead(s.ocr, s.match, pages, s.warnings), billScanId: s.id };
}

/** The bill form's starting point from any read invoice (a scanned bill, or Scan Receipt). */
export function prefillFromRead(o: BillOcr | null, match: ReadMatch | null | undefined, pages: string[], warnings: string[] = []): ScanPrefill {
  const m = match ?? null;
  return {
    ocr: o,
    learnedFrom: m?.learnedFrom ?? 0,
    supplierName: o?.supplier ?? null,
    supplierId: m?.supplier?.id ?? null,
    supplierInvoiceNumber: m?.invoiceNumber ?? o?.invoiceNumber ?? null,
    date: o?.date ?? null,
    dueDate: m?.dueDate ?? o?.dueDate ?? null,
    currency: o?.currency ?? null,
    total: o?.total ?? null,
    subtotal: o?.subtotal ?? null,
    taxTotal: o?.taxTotal ?? null,
    purchaseOrderId: m?.po && ['DRAFT', 'SENT', 'PARTIAL', 'RECEIVED'].includes(m.po.status) ? m.po.id : null,
    receiptImage: pages.length ? (pages.length === 1 ? pages[0] : JSON.stringify(pages)) : null,
    // The SKU / part number: the stock item it matched (or was learned to be), else the supplier's code as read.
    // A learned line also gets its saved description, account and VAT rate.
    lineItems: (o?.lineItems ?? []).map((l, i) => {
      const hint = m?.lines[i];
      const sku = hint?.item ?? l.partNumber ?? null;
      return { description: hint?.description || l.description, quantity: l.quantity, unitPrice: l.unitPrice, partNumber: sku, accountId: hint?.accountId ?? null, taxRateId: hint?.taxRateId ?? null };
    }),
    warnings,
    supplierDetails: o ? { vatNumber: o.supplierVatNumber, address: o.supplierAddress, phone: o.supplierPhone, email: o.supplierEmail, website: o.supplierWebsite } : undefined,
  };
}

const when = (v: string | null) => {
  const d = new Date(v || '');
  return isNaN(d.getTime()) ? '' : d.toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const ReadState: React.FC<{ s: BillScan }> = ({ s }) => {
  if (s.read.status === 'WAITING') return <span className="inline-flex items-center gap-1 text-[10px] font-bold text-primary"><Loader2 className="w-3 h-3 animate-spin" />Reading…</span>;
  if (s.read.status === 'READ') return <span className="inline-flex items-center gap-1 text-[10px] font-bold text-green-400"><CheckCircle2 className="w-3 h-3" />Read</span>;
  if (s.read.status === 'OFF') return <span className="text-[10px] font-bold text-outline" title={s.read.error || ''}>Not read (reading isn't set up)</span>;
  return <span className="text-[10px] font-bold text-error" title={s.read.error || ''}>Couldn't read it</span>;
};

export const BillInbox: React.FC<{
  bills: Bill[];
  triggerToast: (m: string, t?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
  onCreateBill: (p: ScanPrefill) => void;
  onChanged: () => void | Promise<void>;
}> = ({ bills, triggerToast, onCreateBill, onChanged }) => {
  const [items, setItems] = useState<BillScan[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [attachTo, setAttachTo] = useState<Record<number, string>>({});
  const [pagesOf, setPagesOf] = useState<BillScan | null>(null);
  const may = canChange('/api/bills/inbox/1/discard', 'POST');

  const load = useCallback(async () => {
    try { const r = await apiGet('/api/bill-scans?status=INBOX'); setItems(r.items || []); } catch { setItems(i => i ?? []); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Scans arrive from phones, and their reading finishes on its own: look again now and then.
  const reading = (items || []).some(s => s.read.status === 'WAITING');
  useEffect(() => {
    const t = window.setInterval(() => { if (!document.hidden) void load(); }, reading ? 5000 : 30000);
    return () => window.clearInterval(t);
  }, [reading, load]);

  const act = async (s: BillScan, fn: () => Promise<void>) => {
    setBusy(s.id);
    try { await fn(); } catch (e: any) { triggerToast(e.message || 'Something went wrong', 'ERROR'); } finally { setBusy(null); }
  };
  const create = (s: BillScan) => act(s, async () => {
    const full: BillScan = await apiGet(`/api/bill-scans/${s.id}`);
    onCreateBill(prefillFromBillScan(full, full.pages || []));
  });
  const read = (s: BillScan) => act(s, async () => {
    const r: BillScan = await apiPost(`/api/bills/inbox/${s.id}/read`, {});
    setItems(xs => (xs || []).map(x => (x.id === s.id ? r : x)));
    triggerToast(r.read.status === 'READ' ? 'Read.' : r.read.error || 'Could not read it.', r.read.status === 'READ' ? 'SUCCESS' : 'ERROR');
  });
  const discard = (s: BillScan) => act(s, async () => {
    if (!(await confirmDialog({ title: 'Discard scanned bill', message: `Discard the bill ${s.user.name} scanned ${when(s.capturedAt || s.createdAt)}? Its photos are kept with the record of the discard, but it leaves this list.`, confirmLabel: 'Discard', destructive: true }))) return;
    await apiPost(`/api/bills/inbox/${s.id}/discard`, {});
    setItems(xs => (xs || []).filter(x => x.id !== s.id));
  });
  const attach = (s: BillScan) => act(s, async () => {
    const billId = Number(attachTo[s.id]);
    if (!billId) { triggerToast('Choose the bill to attach it to.', 'ERROR'); return; }
    const r = await apiPost(`/api/bills/inbox/${s.id}/attach`, { billId });
    setItems(xs => (xs || []).filter(x => x.id !== s.id));
    triggerToast(`Attached to ${r.billNumber} (${r.pages} page${r.pages === 1 ? '' : 's'})${r.invoiceNumber ? `, supplier invoice ${r.invoiceNumber} filled in` : ''}.`);
    await onChanged();
  });
  const showPages = (s: BillScan) => act(s, async () => { setPagesOf(await apiGet(`/api/bill-scans/${s.id}`)); });

  const recent = useMemo(() => [...bills].filter(b => b.status !== 'VOID').sort((a, b) => b.id - a.id).slice(0, 60), [bills]);
  if (!items || !items.length) return null;

  return (
    <SectionCard title={`From the scanner (${items.length})`}>
      {pagesOf && (
        <Modal title={`Scanned bill: ${pagesOf.ocr?.supplier || pagesOf.user.name}`} subtitle="Click a page to open it full size in a new tab" onClose={() => setPagesOf(null)} maxWidth="max-w-3xl">
          <div className="flex flex-wrap gap-2">
            {(pagesOf.pages || []).map((p, i) => (
              <button key={i} type="button" onClick={() => { if (!openReceiptPage(p)) triggerToast('The new tab was blocked: allow pop-ups for this site.', 'ERROR'); }} className="border border-outline-variant rounded overflow-hidden w-40" aria-label={`Open page ${i + 1}`}>
                <img src={p} alt={`Page ${i + 1}`} className="w-full block" />
              </button>
            ))}
          </div>
        </Modal>
      )}
      <ul className="divide-y divide-outline-variant/30" data-testid="bill-inbox">
        {items.map(s => {
          const o = s.ocr;
          return (
            <li key={s.id} className="py-sm flex flex-wrap items-start gap-md text-xs">
              <button type="button" onClick={() => void showPages(s)} className="shrink-0 rounded border border-outline-variant overflow-hidden w-14 h-16 bg-surface-container-high" title="Open the pages">
                {s.thumb ? <img src={s.thumb} alt={`Scanned bill ${s.id}`} className="w-full h-full object-cover" /> : <FileText className="w-6 h-6 m-auto text-outline" />}
              </button>
              <div className="flex-1 min-w-[260px] space-y-0.5">
                <p className="font-bold text-on-surface flex flex-wrap items-center gap-2">
                  {o?.supplier || 'Supplier not read yet'}
                  {s.match?.supplier ? <span className="text-[10px] font-bold text-green-400" title={s.match.supplier.by === 'vat' ? 'Matched by VAT number' : s.match.supplier.by === 'web' ? 'Matched by the web address on the invoice' : 'Matched by name'}>→ {s.match.supplier.name}</span>
                    : o?.supplier ? <span className="text-[10px] font-bold text-amber-400">not a supplier in Tracklab</span> : null}
                  <ReadState s={s} />
                </p>
                <p className="text-on-surface-variant">
                  {[o?.invoiceNumber && `Invoice ${o.invoiceNumber}`, o?.date && fmtDate(o.date), o?.total != null && fmtMoney(o.total, o.currency || 'ZAR'), o?.supplierVatNumber && `VAT ${o.supplierVatNumber}`, s.match?.po && `PO ${s.match.po.number}`].filter(Boolean).join(' · ') || '—'}
                </p>
                <p className="text-outline">{s.pageCount} page{s.pageCount === 1 ? '' : 's'} · {s.user.name} · {when(s.capturedAt || s.createdAt)}{s.note ? ` · "${s.note}"` : ''}</p>
                {s.warnings.map(w => <p key={w} className="text-amber-400 flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{w}</p>)}
              </div>
              {may && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <PrimaryButton icon={<Sparkles className="w-3.5 h-3.5" />} disabled={busy === s.id || s.read.status === 'WAITING'} onClick={() => void create(s)}>Create bill</PrimaryButton>
                  <select className={`${selectClass} w-40 py-1 text-xs`} value={attachTo[s.id] ?? ''} onChange={e => setAttachTo(a => ({ ...a, [s.id]: e.target.value }))} aria-label="Bill to attach it to">
                    <option value="">Attach to bill…</option>
                    {recent.map(b => <option key={b.id} value={b.id}>{b.billNumber} · {b.supplierName || b.supplierId || '—'}</option>)}
                  </select>
                  <SecondaryButton icon={<Paperclip className="w-3.5 h-3.5" />} disabled={busy === s.id || !attachTo[s.id]} onClick={() => void attach(s)}>Attach</SecondaryButton>
                  {s.read.status !== 'WAITING' && <SecondaryButton icon={<RefreshCw className="w-3.5 h-3.5" />} disabled={busy === s.id} onClick={() => void read(s)}>{s.read.status === 'READ' ? 'Read again' : 'Read'}</SecondaryButton>}
                  <DangerButton icon={<Trash2 className="w-3.5 h-3.5" />} disabled={busy === s.id} onClick={() => void discard(s)} aria-label={`Discard scanned bill ${s.id}`}>Discard</DangerButton>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
};

// ---------------------------------------------------------------------------
// Fill in what existing bills and their suppliers are missing.

interface Proposal { key: string; target: 'bill' | 'supplier'; label: string; current: string | null; value: string }
interface BillResult { billId: number; billNumber: string; supplier: { id: string; name: string | null } | null; proposals: Proposal[]; warnings: string[]; ocr?: BillOcr; error?: string }

/** What was read off an invoice, in a line: who, their VAT number, the invoice number, date and total. */
export const readSummary = (o: BillOcr | undefined) => !o ? '' : [
  o.supplier, o.supplierVatNumber && `VAT ${o.supplierVatNumber}`, o.invoiceNumber && `invoice ${o.invoiceNumber}`, o.date && fmtDate(o.date),
  o.total != null && fmtMoney(o.total, o.currency || 'ZAR'), o.taxTotal != null && `VAT ${fmtMoney(o.taxTotal, o.currency || 'ZAR')}`,
].filter(Boolean).join(' · ');

export const FillMissingModal: React.FC<{
  bills: Bill[];
  supplierName: (id: string) => string;
  onClose: () => void;
  onDone: () => void | Promise<void>;
  triggerToast: (m: string, t?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
  /** Start reading at once (one bill's Read button), rather than after a click. */
  autoStart?: boolean;
}> = ({ bills, supplierName, onClose, onDone, triggerToast, autoStart = false }) => {
  const withPhotos = useMemo(() => bills.filter(b => receiptPages(b.receiptImage).length > 0 && b.status !== 'VOID'), [bills]);
  const [results, setResults] = useState<BillResult[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const pkey = (billId: number, key: string) => `${billId}:${key}`;

  const readAll = async () => {
    setRunning(true); setResults([]); setDone(0);
    const out: BillResult[] = [];
    const chosen = new Set<string>();
    for (const b of withPhotos) {
      try {
        const r: BillResult = await apiPost(`/api/bills/${b.id}/read-missing`, {});
        out.push(r);
        // The same supplier field offered by several bills: tick it once, on the first.
        for (const p of r.proposals) {
          const dup = p.target === 'supplier' && out.slice(0, -1).some(x => x.supplier?.id === r.supplier?.id && x.proposals.some(q => q.key === p.key && chosen.has(pkey(x.billId, q.key))));
          if (!dup) chosen.add(pkey(r.billId, p.key));
        }
      } catch (e: any) {
        out.push({ billId: b.id, billNumber: b.billNumber, supplier: null, proposals: [], warnings: [], error: e.message || 'Could not read it' });
        if (/not set up/i.test(e.message || '')) { setResults([...out]); setRunning(false); triggerToast(e.message, 'ERROR'); return; }
      }
      setResults([...out]); setDone(out.length); setPicked(new Set(chosen));
    }
    setRunning(false);
  };

  // Read one bill's invoice again (a blurry or misread page): its row is replaced, its ticks reset.
  const [rereading, setRereading] = useState<number | null>(null);
  const readAgain = async (billId: number) => {
    setRereading(billId);
    try {
      const r: BillResult = await apiPost(`/api/bills/${billId}/read-missing`, {});
      setResults(rs => rs.map(x => (x.billId === billId ? r : x)));
      setPicked(s => { const n = new Set([...s].filter(k => !k.startsWith(`${billId}:`))); r.proposals.forEach(p => n.add(pkey(billId, p.key))); return n; });
    } catch (e: any) {
      setResults(rs => rs.map(x => (x.billId === billId ? { ...x, error: e.message || 'Could not read it' } : x)));
    } finally { setRereading(null); }
  };

  const apply = async () => {
    setApplying(true);
    let n = 0;
    try {
      for (const r of results) {
        const values: Record<string, string> = {};
        for (const p of r.proposals) if (picked.has(pkey(r.billId, p.key))) values[p.key] = p.value;
        if (!Object.keys(values).length) continue;
        const res = await apiPost(`/api/bills/${r.billId}/fill-missing`, { values });
        n += (res.filled || []).length;
      }
      triggerToast(n ? `${n} detail${n === 1 ? '' : 's'} filled in.` : 'Nothing needed filling in.');
      await onDone();
      onClose();
    } catch (e: any) { triggerToast(e.message || 'Could not fill them in', 'ERROR'); } finally { setApplying(false); }
  };

  const started = React.useRef(false);
  useEffect(() => { if (autoStart && !started.current && withPhotos.length) { started.current = true; void readAll(); } }, [autoStart, withPhotos.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const offered = results.reduce((s, r) => s + r.proposals.length, 0);
  const show = (p: Proposal) => (p.key === 'supplierId' ? supplierName(p.value) : p.value);
  return (
    <Modal title={autoStart && bills.length === 1 ? `Read ${bills[0].billNumber}` : 'Fill missing details from photos'} subtitle="Reads each bill's attached photos and offers what the bill and its supplier are missing. Only empty fields are filled; nothing is changed until you apply it." onClose={onClose} maxWidth="max-w-4xl">
      <div className="space-y-md text-xs">
        {!results.length && !running && (
          <div className="space-y-sm">
            <p>{withPhotos.length} bill{withPhotos.length === 1 ? ' has' : 's have'} photos attached. Each is read for the supplier's VAT number, address, phone, email and website, and the supplier's invoice number. The photos are sent to the reading service (Mindee, or OpenAI) to be read, the same as Scan Receipt. Bank details are never taken from an invoice.</p>
            <PrimaryButton icon={<Wand2 className="w-3.5 h-3.5" />} disabled={!withPhotos.length} onClick={() => void readAll()}>Read {withPhotos.length} bill{withPhotos.length === 1 ? '' : 's'}</PrimaryButton>
          </div>
        )}
        {running && <p className="flex items-center gap-2 text-primary font-bold"><Loader2 className="w-4 h-4 animate-spin" />Reading {Math.min(done + 1, withPhotos.length)} of {withPhotos.length}…</p>}
        {results.length > 0 && (
          <ul className="divide-y divide-outline-variant/30 border border-outline-variant/40 rounded-lg" data-testid="fill-missing-results">
            {results.map(r => (
              <li key={r.billId} className="p-sm space-y-1">
                <div className="flex items-center gap-2" data-no-mobile-stack>
                  <p className="font-bold flex-1"><span className="font-mono text-primary">{r.billNumber}</span>{r.supplier ? <span className="text-on-surface-variant font-normal"> · {r.supplier.name || r.supplier.id}</span> : null}</p>
                  {!running && results.length > 1 && (
                    <button type="button" onClick={() => void readAgain(r.billId)} disabled={rereading !== null} aria-label={`Read ${r.billNumber} again`}
                      className="inline-flex items-center gap-1 text-[11px] font-bold text-on-surface-variant hover:text-primary disabled:opacity-40">
                      {rereading === r.billId ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}Read again
                    </button>
                  )}
                </div>
                {rereading === r.billId && <p className="text-primary">Reading again…</p>}
                {r.error && <p className="text-error">{r.error}</p>}
                {r.ocr && <p className="text-on-surface-variant" data-testid="read-summary">Read: {readSummary(r.ocr) || 'nothing clear'}</p>}
                {!r.error && !r.proposals.length && <p className="text-outline">Nothing missing that the photos show.</p>}
                {r.proposals.map(p => (
                  <label key={p.key} className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={picked.has(pkey(r.billId, p.key))} onChange={e => setPicked(s => { const n = new Set(s); if (e.target.checked) n.add(pkey(r.billId, p.key)); else n.delete(pkey(r.billId, p.key)); return n; })} />
                    <span className="text-outline w-44 shrink-0">{p.target === 'supplier' ? `Supplier ${p.label.toLowerCase()}` : p.label}</span>
                    <span className="font-mono text-on-surface break-all">{show(p)}</span>
                  </label>
                ))}
                {r.warnings.map(w => <p key={w} className="text-amber-400 flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{w}</p>)}
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2 pt-sm border-t border-outline-variant/20">
          <SecondaryButton onClick={onClose}>Close</SecondaryButton>
          {results.length > 0 && !running && (
            <SecondaryButton icon={<RefreshCw className="w-3.5 h-3.5" />} disabled={rereading !== null || applying}
              onClick={() => (results.length === 1 ? void readAgain(results[0].billId) : void readAll())}>
              {rereading !== null ? 'Reading…' : results.length === 1 ? 'Read again' : 'Read all again'}
            </SecondaryButton>
          )}
          {results.length > 0 && !running && <PrimaryButton icon={<CheckCircle2 className="w-3.5 h-3.5" />} disabled={applying || !picked.size} onClick={() => void apply()}>{applying ? 'Filling in…' : `Fill in ${picked.size} of ${offered}`}</PrimaryButton>}
        </div>
      </div>
    </Modal>
  );
};

export const ScanInboxIcon = ScanLine;

// ---------------------------------------------------------------------------
// What reading a supplier's invoices has learned (src/lib/billLearning), on the vendor's page.

interface LearnedProfile { bills: number; examples: { billNumber: string | null; at: string }[]; lines: { label: string; item: string | null; description: string; seen: number }[]; invoiceShape: { prefix: string; digits: number } | null; dueDays: number | null }

export const LearnedReading: React.FC<{ supplierId: string; supplierName: string }> = ({ supplierId, supplierName }) => {
  const [p, setP] = useState<LearnedProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const may = canChange('/api/bills/read-profiles/1/clear', 'POST');
  useEffect(() => { apiGet(`/api/bill-read-profiles/${encodeURIComponent(supplierId)}`).then(setP).catch(() => setP(null)); }, [supplierId]);
  const clear = async () => {
    if (!(await confirmDialog({ title: 'Forget what was learned', message: `Forget how ${supplierName}'s invoices read (${p?.bills} bill${p?.bills === 1 ? '' : 's'})? Their next invoice is read from scratch and learning starts again. Bills already saved don't change.`, confirmLabel: 'Forget it', destructive: true }))) return;
    setBusy(true);
    try { await apiPost(`/api/bills/read-profiles/${encodeURIComponent(supplierId)}/clear`, {}); setP({ bills: 0, examples: [], lines: [], invoiceShape: null, dueDays: null }); } finally { setBusy(false); }
  };
  if (!p) return null;
  return (
    <div className="text-xs space-y-2" data-testid="learned-reading">
      {!p.bills ? (
        <p className="text-outline">Nothing learned yet. Each bill saved from a read invoice (a scanned bill or Scan Receipt) teaches how {supplierName}'s invoices read.</p>
      ) : (
        <>
          <p className="text-on-surface-variant">Learned from {p.bills} bill{p.bills === 1 ? '' : 's'}{p.examples[0]?.billNumber ? `, latest ${p.examples[0].billNumber}` : ''}.
            {p.invoiceShape ? ` Invoice numbers look like ${p.invoiceShape.prefix}${'0'.repeat(p.invoiceShape.digits)}.` : ''}
            {p.dueDays != null ? ` Due ${p.dueDays} days after the invoice date.` : ''}</p>
          {p.lines.length > 0 && (
            <table className="w-full text-left">
              <thead><tr className="text-[10px] uppercase text-outline"><th className="py-1">On their invoice</th><th>Becomes</th><th className="text-right">Seen</th></tr></thead>
              <tbody className="divide-y divide-outline-variant/20">
                {p.lines.slice(0, 30).map(l => (
                  <tr key={l.label}>
                    <td className="py-1 font-mono">{l.label}</td>
                    <td>{l.item ? <span className="font-mono text-primary">{l.item}</span> : null}{l.item ? ' · ' : ''}<span className="text-on-surface-variant">{l.description}</span></td>
                    <td className="text-right font-mono">{l.seen}×</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {may && <DangerButton icon={<Trash2 className="w-3.5 h-3.5" />} disabled={busy} onClick={() => void clear()}>Forget what was learned</DangerButton>}
        </>
      )}
    </div>
  );
};
