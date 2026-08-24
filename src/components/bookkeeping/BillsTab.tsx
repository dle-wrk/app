import React, { useMemo, useRef, useState } from 'react';
import { Plus, Send, Ban, Eye, Wallet, Camera, Image as ImageIcon, X, Trash2, Sparkles } from 'lucide-react';
import { Bill, PurchaseOrder } from '../../types';
import { ModuleDataProps, Modal, StatusPill, fmtMoney, fmtDate, todayISO, addDaysISO, apiPost, apiGet, PrimaryButton, SecondaryButton, DangerButton, FieldLabel, inputClass, selectClass, EmptyState, SectionCard } from './shared';
import { runOcr, OcrResult } from '../../lib/receiptOcr';
import { LineItemsEditor, EditableLine, newEditableLine } from './LineItemsEditor';
import { ErrorBoundary } from '../ErrorBoundary';

const STATUS_FILTERS = ['ALL', 'DRAFT', 'AWAITING_PAYMENT', 'PARTIAL', 'PAID', 'OVERDUE', 'VOID'];

// Payload the scan modal hands the editor when the user chooses "Continue to
// bill". Any field may be null — the editor uses defaults where we couldn't
// extract cleanly.
interface PrefillFromScan {
  supplierName: string | null;
  date: string | null;
  total: number | null;
  receiptImage: string | null;
  lineItems: { description: string; quantity: number; unitPrice: number }[];
}

export const BillsTab: React.FC<ModuleDataProps & { prefillFromPO?: PurchaseOrder | null; onPrefillConsumed?: () => void }> = (props) => {
  const { bills, triggerToast, refresh, prefillFromPO, onPrefillConsumed } = props;
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [showEditor, setShowEditor] = useState(!!prefillFromPO);
  const [viewing, setViewing] = useState<any>(null);
  const [payingBill, setPayingBill] = useState<Bill | null>(null);
  const [scanningBill, setScanningBill] = useState<Bill | null>(null);
  const [scanningForNewBill, setScanningForNewBill] = useState(false);
  const [scanResultForEditor, setScanResultForEditor] = useState<PrefillFromScan | null>(null);
  const [busy, setBusy] = useState(false);

  React.useEffect(() => {
    if (prefillFromPO) setShowEditor(true);
  }, [prefillFromPO]);

  const filtered = useMemo(() => bills.filter(b => statusFilter === 'ALL' || b.status === statusFilter), [bills, statusFilter]);
  const totals = useMemo(() => ({
    outstanding: bills.filter(b => ['AWAITING_PAYMENT', 'PARTIAL', 'OVERDUE'].includes(b.status)).reduce((s, b) => s + b.balanceDue, 0),
    overdue: bills.filter(b => b.status === 'OVERDUE').reduce((s, b) => s + b.balanceDue, 0),
  }), [bills]);

  const openView = async (b: Bill) => {
    try {
      const full = await apiGet(`/api/bills/${b.id}`);
      setViewing(full);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load bill', 'ERROR');
    }
  };

  const handleFinalize = async (id: number) => {
    setBusy(true);
    try {
      await apiPost(`/api/bills/${id}/finalize`);
      triggerToast('Bill posted to the ledger.');
      await refresh();
      setViewing(null);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to finalize bill', 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  const handleVoid = async (id: number) => {
    if (!confirm('Void this bill? This posts a reversing journal entry.')) return;
    setBusy(true);
    try {
      await apiPost(`/api/bills/${id}/void`);
      triggerToast('Bill voided.');
      await refresh();
      setViewing(null);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to void bill', 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this bill? This action cannot be undone.')) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/bills/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to delete');
      triggerToast('Bill deleted.');
      await refresh();
      setViewing(null);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to delete bill', 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
          <span className="text-[11px] text-on-surface-variant font-bold block mb-1">Outstanding (AP)</span>
          <span className="text-xl font-black text-primary">{fmtMoney(totals.outstanding)}</span>
        </div>
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
          <span className="text-[11px] text-on-surface-variant font-bold block mb-1">Overdue</span>
          <span className="text-xl font-black text-error">{fmtMoney(totals.overdue)}</span>
        </div>
      </div>

      <SectionCard
        title="Bills"
        actions={
          <>
            <div className="hidden md:flex gap-1">
              {STATUS_FILTERS.map(s => (
                <button key={s} onClick={() => setStatusFilter(s)} className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-colors ${statusFilter === s ? 'bg-primary text-white border-primary' : 'bg-surface-container-high text-on-surface-variant border-outline-variant'}`}>{s.replace('_', ' ')}</button>
              ))}
            </div>
            <SecondaryButton icon={<Camera className="w-3.5 h-3.5" />} onClick={() => setScanningForNewBill(true)}>Scan Receipt</SecondaryButton>
            <PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setShowEditor(true)}>New Bill</PrimaryButton>
          </>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">Bill #</th>
                <th className="px-lg py-sm">Supplier</th>
                <th className="px-lg py-sm">Date</th>
                <th className="px-lg py-sm">Due</th>
                <th className="px-lg py-sm text-right">Total</th>
                <th className="px-lg py-sm text-right">Balance Due</th>
                <th className="px-lg py-sm">Status</th>
                <th className="px-lg py-sm">Receipt</th>
                <th className="px-lg py-sm text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {filtered.map(b => (
                <tr key={b.id} className="hover:bg-surface-variant/20 transition-all">
                  <td className="px-lg py-sm font-mono text-primary font-bold cursor-pointer" onClick={() => openView(b)}>{b.billNumber}</td>
                  <td className="px-lg py-sm font-semibold">{b.supplierName || b.supplierId || '—'}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(b.billDate)}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(b.dueDate)}</td>
                  <td className="px-lg py-sm text-right font-mono">{fmtMoney(b.total, b.currency)}</td>
                  <td className="px-lg py-sm text-right font-mono font-bold">{fmtMoney(b.balanceDue, b.currency)}</td>
                  <td className="px-lg py-sm"><StatusPill status={b.status} /></td>
                  <td className="px-lg py-sm">
                    {b.receiptImage ? (
                      <button
                        onClick={() => setScanningBill(b)}
                        title="View / replace scanned receipt"
                        className="inline-flex items-center gap-1.5 text-[11px] text-green-400 hover:text-green-300"
                      >
                        <img src={b.receiptImage} alt="receipt" className="w-6 h-6 object-cover rounded border border-outline-variant" />
                        Attached
                      </button>
                    ) : (
                      <button
                        onClick={() => setScanningBill(b)}
                        title="Scan / upload receipt"
                        className="inline-flex items-center gap-1 text-[11px] text-on-surface-variant hover:text-primary p-1.5 rounded hover:bg-surface-container-high"
                      >
                        <Camera className="w-3.5 h-3.5" /> Scan
                      </button>
                    )}
                  </td>
                  <td className="px-lg py-sm text-right">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => openView(b)} className="p-1.5 rounded hover:bg-surface-container-high text-on-surface-variant" title="View"><Eye className="w-3.5 h-3.5" /></button>
                      {['AWAITING_PAYMENT', 'PARTIAL', 'OVERDUE'].includes(b.status) && (
                        <button onClick={() => setPayingBill(b)} className="p-1.5 rounded hover:bg-surface-container-high text-green-400" title="Pay"><Wallet className="w-3.5 h-3.5" /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && <EmptyState message="No bills match this filter yet." colSpan={9} />}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {showEditor && (
        <BillEditorModal
          {...props}
          prefillFromPO={prefillFromPO}
          prefillFromScan={scanResultForEditor}
          onClose={() => { setShowEditor(false); setScanResultForEditor(null); onPrefillConsumed?.(); }}
          onSaved={async () => { setShowEditor(false); setScanResultForEditor(null); onPrefillConsumed?.(); await refresh(); }}
        />
      )}

      {viewing && (
        <Modal title={viewing.billNumber} subtitle={`${viewing.supplierName || viewing.supplierId || 'No supplier'} · ${fmtDate(viewing.billDate)}`} onClose={() => setViewing(null)} maxWidth="max-w-2xl">
          <div className="flex items-center gap-2 mb-md"><StatusPill status={viewing.status} /><span className="text-xs text-on-surface-variant">Due {fmtDate(viewing.dueDate)}</span></div>
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
          {viewing.receiptImage && (
            <div className="mb-md">
              <div className="text-[10px] uppercase font-bold text-outline mb-1">Attached receipt</div>
              <a href={viewing.receiptImage} target="_blank" rel="noopener noreferrer" title="Open full size">
                <img src={viewing.receiptImage} alt="Scanned receipt" className="max-h-64 object-contain rounded border border-outline-variant bg-black/20 p-1" />
              </a>
            </div>
          )}
          <div className="flex justify-end mb-md">
            <div className="w-56 space-y-1 text-xs">
              <div className="flex justify-between"><span className="text-on-surface-variant">Subtotal</span><span className="font-mono">{fmtMoney(viewing.subtotal, viewing.currency)}</span></div>
              <div className="flex justify-between"><span className="text-on-surface-variant">Tax</span><span className="font-mono">{fmtMoney(viewing.taxTotal, viewing.currency)}</span></div>
              <div className="flex justify-between font-bold"><span>Total</span><span className="font-mono text-primary">{fmtMoney(viewing.total, viewing.currency)}</span></div>
              <div className="flex justify-between text-green-400"><span>Paid</span><span className="font-mono">{fmtMoney(viewing.amountPaid, viewing.currency)}</span></div>
              <div className="flex justify-between font-bold border-t border-outline-variant/30 pt-1"><span>Balance Due</span><span className="font-mono">{fmtMoney(viewing.balanceDue, viewing.currency)}</span></div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 justify-end pt-2 border-t border-outline-variant/20">
            {viewing.status === 'DRAFT' && (
              <>
                <PrimaryButton icon={<Send className="w-3.5 h-3.5" />} onClick={() => handleFinalize(viewing.id)} disabled={busy}>Finalize</PrimaryButton>
                <DangerButton icon={<Ban className="w-3.5 h-3.5" />} onClick={() => handleDelete(viewing.id)} disabled={busy}>Delete</DangerButton>
              </>
            )}
            {['AWAITING_PAYMENT', 'PARTIAL', 'OVERDUE'].includes(viewing.status) && (
              <>
                <PrimaryButton icon={<Wallet className="w-3.5 h-3.5" />} onClick={() => { setPayingBill(viewing); setViewing(null); }}>Pay Bill</PrimaryButton>
                <DangerButton icon={<Ban className="w-3.5 h-3.5" />} onClick={() => handleVoid(viewing.id)} disabled={busy}>Void</DangerButton>
              </>
            )}
          </div>
        </Modal>
      )}

      {payingBill && (
        <QuickBillPaymentModal bill={payingBill} accounts={props.accounts} triggerToast={triggerToast} onClose={() => setPayingBill(null)} onSaved={async () => { setPayingBill(null); await refresh(); }} />
      )}

      {scanningBill && (
        <ReceiptScanModal
          bill={scanningBill}
          onClose={() => setScanningBill(null)}
          onSaved={async () => { setScanningBill(null); await refresh(); }}
          triggerToast={triggerToast}
        />
      )}

      {scanningForNewBill && (
        <ReceiptScanModal
          bill={null}
          mode="new-bill"
          onClose={() => setScanningForNewBill(false)}
          onContinueToBill={(payload) => {
            setScanningForNewBill(false);
            setScanResultForEditor(payload);
            setShowEditor(true);
          }}
          onSaved={async () => { setScanningForNewBill(false); await refresh(); }}
          triggerToast={triggerToast}
        />
      )}
    </div>
  );
};

// Attach a scanned till slip / vendor invoice to a bill. "Take photo" opens
// a live camera stream inside the modal via getUserMedia — works on phones
// (rear camera via facingMode: environment) AND on desktop laptops with a
// webcam. If the browser can't grant camera access, we fall back to a hidden
// file input with `capture="environment"` so the flow still completes.
const ReceiptScanModal: React.FC<{
  bill: Bill | null;
  mode?: 'attach' | 'new-bill';
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  onContinueToBill?: (payload: PrefillFromScan) => void;
  triggerToast: (m: string, t?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
}> = ({ bill, mode = 'attach', onClose, onSaved, onContinueToBill, triggerToast }) => {
  const [preview, setPreview] = useState<string | null>(bill?.receiptImage || null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [ocr, setOcr] = useState<OcrResult | null>(null);
  const [ocrRunning, setOcrRunning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setCameraOn(false);
  };

  // Always release the camera when the modal closes.
  React.useEffect(() => () => stopCamera(), []);

  const startCamera = async () => {
    // No secure context (HTTP over LAN, file://) → getUserMedia is unavailable.
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraInputRef.current?.click();
      return;
    }
    setCameraStarting(true);
    try {
      // facingMode as a hint (not exact) so laptops with only a front camera
      // still work — an "exact: environment" would reject on those.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOn(true);
      // srcObject must be set after the <video> renders — the effect below picks it up.
    } catch (err: any) {
      // Permission denied, no camera, in-use elsewhere — fall through to file input.
      triggerToast('Camera unavailable — falling back to file picker', 'INFO');
      cameraInputRef.current?.click();
    } finally {
      setCameraStarting(false);
    }
  };

  // Bind the live stream to the video element once both exist.
  React.useEffect(() => {
    if (cameraOn && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => { /* autoplay might need a user gesture — the button click was one */ });
    }
  }, [cameraOn]);

  // Kick off OCR after any new capture. Runs in the background — the user
  // can save the raw image immediately without waiting for OCR to finish.
  const startOcr = async (image: string) => {
    setOcr(null);
    setOcrRunning(true);
    try {
      const result = await runOcr(image);
      setOcr(result);
    } catch (err: any) {
      // OCR is a nice-to-have — don't block the save flow on its failure.
      console.warn('OCR failed:', err);
      triggerToast('OCR unavailable — receipt saved as image only', 'INFO');
    } finally {
      setOcrRunning(false);
    }
  };

  const capture = async () => {
    const video = videoRef.current;
    if (!video) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) {
      triggerToast('Camera not ready yet — hold on a moment', 'ERROR');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const raw = canvas.toDataURL('image/jpeg', 0.92);
    stopCamera();
    const compressed = await compressImage(raw);
    setPreview(compressed);
    setDirty(true);
    startOcr(compressed);
  };

  const readFile = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  // Downscale to at most 1600px on the long edge and re-encode as JPEG q0.85.
  // A raw 12MP phone photo is 4-6MB; this brings it to ~200-400KB while still
  // being readable enough to double-check line items later.
  const compressImage = (dataUrl: string, maxDim = 1600, quality = 0.85) => new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(dataUrl);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      triggerToast('Please choose an image file', 'ERROR');
      return;
    }
    try {
      const raw = await readFile(file);
      const compressed = await compressImage(raw);
      setPreview(compressed);
      setDirty(true);
      startOcr(compressed);
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to read image', 'ERROR');
    }
  };

  const save = async () => {
    if (!preview || !bill) return;
    setSaving(true);
    try {
      await apiPost(`/api/bills/${bill.id}/receipt`, { image: preview });
      triggerToast('Receipt saved.');
      await onSaved();
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to save receipt', 'ERROR');
    } finally {
      setSaving(false);
    }
  };

  // "new-bill" mode: hand the OCR result + image to the parent so it can
  // open the BillEditor with everything prefilled. If OCR is still running
  // when the user clicks, we ship what we have (image only) — worst case the
  // editor just opens blank like the old "New Bill" button.
  const continueToBill = () => {
    if (!onContinueToBill || !preview) return;
    onContinueToBill({
      supplierName: ocr?.supplier ?? null,
      date: ocr?.date ?? null,
      total: ocr?.total ?? null,
      receiptImage: preview,
      lineItems: (ocr?.lineItems || []).map(li => ({
        description: li.description,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
      })),
    });
  };

  const remove = async () => {
    if (!bill || !confirm('Remove the attached receipt?')) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/bills/${bill.id}/receipt`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to remove');
      triggerToast('Receipt removed.');
      await onSaved();
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to remove receipt', 'ERROR');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => { stopCamera(); onClose(); };

  return (
    <Modal
      title={bill ? `Receipt for ${bill.billNumber}` : 'Scan receipt → new bill'}
      subtitle={bill ? (bill.supplierName || bill.supplierId || 'No supplier') : 'We\'ll pre-fill the bill from what OCR reads'}
      onClose={handleClose}
      maxWidth="max-w-lg"
    >
      <div className="space-y-md">
        {cameraOn ? (
          <div className="rounded-lg border border-outline-variant bg-black overflow-hidden">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="w-full max-h-[60vh] object-contain bg-black"
            />
          </div>
        ) : preview ? (
          <div className="rounded-lg border border-outline-variant bg-black/20 flex items-center justify-center p-2">
            <img src={preview} alt="Scanned receipt" className="max-h-[60vh] object-contain rounded" />
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-outline-variant/60 p-8 text-center text-xs text-on-surface-variant">
            No receipt attached yet. Take a photo of the till slip or choose an existing image.
          </div>
        )}

        {!cameraOn && preview && (ocrRunning || ocr) && (
          <div className="rounded-lg border border-outline-variant/60 bg-surface-container-high/40 p-3">
            <div className="flex items-center gap-2 mb-2 text-[10px] uppercase font-bold text-outline">
              <Sparkles className="w-3.5 h-3.5 text-primary" />
              OCR — extracted fields
              {ocrRunning && <span className="text-primary normal-case font-normal">running…</span>}
            </div>
            {ocr && (
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <div className="text-[10px] uppercase text-outline">Supplier</div>
                  <div className="font-mono truncate" title={ocr.supplier || ''}>{ocr.supplier || '—'}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-outline">Date</div>
                  <div className="font-mono">{ocr.date || '—'}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-outline">Total</div>
                  <div className="font-mono font-bold text-primary">{ocr.total !== null ? ocr.total.toFixed(2) : '—'}</div>
                </div>
              </div>
            )}
            {ocr && ocr.lineItems && ocr.lineItems.length > 0 && (
              <div className="mt-3 border-t border-outline-variant/40 pt-2">
                <div className="text-[10px] uppercase text-outline mb-1">
                  Line items ({ocr.lineItems.length}) — will prefill the bill editor
                </div>
                <div className="max-h-32 overflow-y-auto space-y-0.5">
                  {ocr.lineItems.slice(0, 8).map((li, idx) => (
                    <div key={idx} className="flex items-baseline gap-2 text-[11px]">
                      <span className="font-mono text-outline w-8 text-right">{li.quantity}×</span>
                      <span className="font-medium truncate flex-1" title={li.description}>{li.description}</span>
                      <span className="font-mono text-primary">{li.lineTotal.toFixed(2)}</span>
                    </div>
                  ))}
                  {ocr.lineItems.length > 8 && (
                    <div className="text-[10px] text-outline italic pl-10">+ {ocr.lineItems.length - 8} more…</div>
                  )}
                </div>
              </div>
            )}
            {ocr && !ocr.supplier && !ocr.date && ocr.total === null && ocr.lineItems.length === 0 && (
              <div className="text-[11px] text-on-surface-variant italic">
                Couldn't extract clean fields — the image is still saved as-is.
              </div>
            )}
          </div>
        )}

        {/* Hidden inputs are the fallback path when getUserMedia is unavailable
            or the user picks "Choose image". */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />

        <div className="flex flex-wrap gap-2 justify-between">
          <div className="flex flex-wrap gap-2">
            {cameraOn ? (
              <>
                <PrimaryButton icon={<Camera className="w-3.5 h-3.5" />} onClick={capture}>
                  Capture
                </PrimaryButton>
                <SecondaryButton onClick={stopCamera}>Cancel</SecondaryButton>
              </>
            ) : (
              <>
                <PrimaryButton icon={<Camera className="w-3.5 h-3.5" />} onClick={startCamera} disabled={cameraStarting}>
                  {cameraStarting ? 'Opening…' : preview ? 'Retake' : 'Take photo'}
                </PrimaryButton>
                <SecondaryButton icon={<ImageIcon className="w-3.5 h-3.5" />} onClick={() => fileInputRef.current?.click()}>
                  Choose image
                </SecondaryButton>
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {!cameraOn && mode === 'attach' && bill?.receiptImage && !dirty && (
              <DangerButton icon={<Trash2 className="w-3.5 h-3.5" />} onClick={remove} disabled={saving}>
                Remove
              </DangerButton>
            )}
            {!cameraOn && mode === 'attach' && dirty && (
              <PrimaryButton onClick={save} disabled={saving || !preview}>
                {saving ? 'Saving…' : 'Save receipt'}
              </PrimaryButton>
            )}
            {!cameraOn && mode === 'new-bill' && preview && (
              <PrimaryButton onClick={continueToBill} disabled={saving}>
                {ocrRunning ? 'Continue anyway →' : 'Continue to bill →'}
              </PrimaryButton>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
};

const BillEditorModal: React.FC<ModuleDataProps & { prefillFromPO?: PurchaseOrder | null; prefillFromScan?: PrefillFromScan | null; onClose: () => void; onSaved: () => void }> = ({ suppliers, items, taxRates, accounts, prefillFromPO, prefillFromScan, onClose, onSaved, triggerToast }) => {
  // Fuzzy-match the OCR'd supplier name to a known supplier ID. Anything
  // shorter than 3 chars or with too many false positives is left blank so
  // the user picks manually.
  const scanSupplierId = React.useMemo(() => {
    const name = prefillFromScan?.supplierName?.toLowerCase().trim();
    if (!name || name.length < 3) return '';
    const hit = suppliers.find(s => {
      const cand = String(s.name || '').toLowerCase();
      return cand === name || cand.includes(name) || name.includes(cand);
    });
    return hit ? String(hit.id) : '';
  }, [prefillFromScan?.supplierName, suppliers]);

  const [supplierId, setSupplierId] = useState(prefillFromPO?.supplierId || scanSupplierId || '');
  const [billDate, setBillDate] = useState(prefillFromScan?.date || todayISO());
  const [dueDate, setDueDate] = useState(addDaysISO(30));
  const [currency, setCurrency] = useState(prefillFromPO?.currency || 'ZAR');
  const [notes, setNotes] = useState(
    prefillFromScan && !prefillFromScan.supplierName && !prefillFromScan.date && !prefillFromScan.total
      ? 'From receipt scan (OCR extracted no fields cleanly)'
      : prefillFromScan ? 'From receipt scan' : ''
  );
  const poItems = (prefillFromPO as any)?.items as any[] | undefined;
  const [lines, setLines] = useState<EditableLine[]>(() => {
    if (poItems?.length) {
      return poItems.map((it: any) => ({ key: `L${it.id}`, partNumber: it.partNumber, description: it.description, quantity: it.quantity, unitPrice: it.unitPrice, taxRateId: it.taxRateId ?? null, receiveStock: !!it.partNumber }));
    }
    // OCR extracted per-line items — prefer these over the single-line
    // fallback so the user starts with a structured bill they only need
    // to check, not retype.
    if (prefillFromScan?.lineItems?.length) {
      return prefillFromScan.lineItems.map((li, idx) => {
        const line = newEditableLine();
        line.key = `OCR${idx}`;
        line.description = li.description;
        line.quantity = li.quantity;
        line.unitPrice = li.unitPrice;
        return line;
      });
    }
    if (prefillFromScan?.total && prefillFromScan.total > 0) {
      const line = newEditableLine();
      line.description = 'Receipt total (edit to break down)';
      line.quantity = 1;
      line.unitPrice = prefillFromScan.total;
      return [line];
    }
    return [newEditableLine()];
  });
  const [saving, setSaving] = useState<'DRAFT' | 'AWAITING_PAYMENT' | null>(null);

  const submit = async (status: 'DRAFT' | 'AWAITING_PAYMENT') => {
    const validLines = lines.filter(l => l.description.trim() && l.quantity > 0);
    if (!validLines.length) { triggerToast('Add at least one line item.', 'ERROR'); return; }
    setSaving(status);
    try {
      const created = await apiPost('/api/bills', {
        supplierId: supplierId || null,
        purchaseOrderId: prefillFromPO?.id || null,
        billDate, dueDate, currency, notes, status,
        items: validLines.map(l => ({ partNumber: l.partNumber || undefined, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRateId: l.taxRateId || undefined, accountId: l.accountId || undefined, receiveStock: !!l.receiveStock })),
      });
      // If the user reached this modal from the scan flow, attach the image
      // to the fresh bill so line items and the source slip live together.
      if (prefillFromScan?.receiptImage && created?.id) {
        try {
          await apiPost(`/api/bills/${created.id}/receipt`, { image: prefillFromScan.receiptImage });
        } catch (err: any) {
          triggerToast('Bill saved but receipt attach failed — retry from the row', 'ERROR');
        }
      }
      triggerToast(status === 'AWAITING_PAYMENT' ? 'Bill finalized and posted to the ledger.' : 'Bill saved as draft.');
      onSaved();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to save bill', 'ERROR');
    } finally {
      setSaving(null);
    }
  };

  return (
    <Modal title={prefillFromPO ? `Bill from ${prefillFromPO.poNumber}` : 'New Bill'} subtitle="Draft first, then finalize to post to the ledger and (optionally) receive stock." onClose={onClose} maxWidth="max-w-4xl">
      <div className="grid md:grid-cols-4 gap-3 mb-md">
        <div className="md:col-span-2">
          <FieldLabel>Supplier</FieldLabel>
          <select className={selectClass} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">Select supplier</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Bill Date</FieldLabel>
          <input type="date" className={inputClass} value={billDate} onChange={(e) => setBillDate(e.target.value)} />
        </div>
        <div>
          <FieldLabel>Due Date</FieldLabel>
          <input type="date" className={inputClass} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
      </div>

      <ErrorBoundary>
        <LineItemsEditor lines={lines} onChange={setLines} items={items} taxRates={taxRates} accounts={accounts} mode="PURCHASE" currency={currency} />
      </ErrorBoundary>

      <div className="mt-md">
        <FieldLabel>Notes</FieldLabel>
        <textarea className={inputClass} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="flex justify-end gap-2 pt-md mt-md border-t border-outline-variant/20">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <SecondaryButton onClick={() => submit('DRAFT')} disabled={!!saving}>{saving === 'DRAFT' ? 'Saving...' : 'Save Draft'}</SecondaryButton>
        <PrimaryButton icon={<Send className="w-3.5 h-3.5" />} onClick={() => submit('AWAITING_PAYMENT')} disabled={!!saving}>{saving === 'AWAITING_PAYMENT' ? 'Posting...' : 'Finalize'}</PrimaryButton>
      </div>
    </Modal>
  );
};

const QuickBillPaymentModal: React.FC<{ bill: Bill; accounts: ModuleDataProps['accounts']; onClose: () => void; onSaved: () => void; triggerToast: ModuleDataProps['triggerToast'] }> = ({ bill, accounts, onClose, onSaved, triggerToast }) => {
  const bankAccounts = accounts.filter(a => a.subtype === 'BANK' || a.subtype === 'CASH');
  const [amount, setAmount] = useState(bill.balanceDue);
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [method, setMethod] = useState('EFT');
  const [paidFromAccountId, setPaidFromAccountId] = useState(String(bankAccounts[0]?.id || ''));
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!paidFromAccountId) { triggerToast('Choose which account to pay from.', 'ERROR'); return; }
    if (amount <= 0) { triggerToast('Amount must be greater than zero.', 'ERROR'); return; }
    setSaving(true);
    try {
      await apiPost('/api/payments-made', {
        supplierId: bill.supplierId || null,
        paymentDate, amount, method, paidFromAccountId: Number(paidFromAccountId), reference,
        allocations: [{ billId: bill.id, amountApplied: Math.min(amount, bill.balanceDue) }],
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
    <Modal title={`Pay ${bill.billNumber}`} subtitle={`Balance due: ${fmtMoney(bill.balanceDue, bill.currency)}`} onClose={onClose} maxWidth="max-w-md">
      <div className="space-y-3">
        <div>
          <FieldLabel>Amount to pay</FieldLabel>
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
              <option value="EFT">EFT</option><option value="CARD">Card</option><option value="CASH">Cash</option><option value="CHEQUE">Cheque</option><option value="OTHER">Other</option>
            </select>
          </div>
        </div>
        <div>
          <FieldLabel>Paid from</FieldLabel>
          <select className={selectClass} value={paidFromAccountId} onChange={(e) => setPaidFromAccountId(e.target.value)}>
            <option value="">Select account</option>
            {bankAccounts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Reference</FieldLabel>
          <input className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-md mt-md border-t border-outline-variant/20">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton icon={<Wallet className="w-3.5 h-3.5" />} onClick={submit} disabled={saving}>{saving ? 'Saving...' : 'Pay Bill'}</PrimaryButton>
      </div>
    </Modal>
  );
};
