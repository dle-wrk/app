import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, Clock, FileText, Loader2, Plus, Receipt, Send, Trash2, X, XCircle } from 'lucide-react';
import { api, newClientRef } from './api';
import { big, card, field, label } from './ui';

// Scan a bill: photograph a supplier's invoice page by page and send it to
// the website, where it waits under Purchases > Bills > From the scanner and
// is read for its supplier, invoice number, dates and lines. Nothing becomes
// a bill until someone creates it there (server: src/lib/billScans.ts).

export interface MyBillScan {
  id: number; status: 'INBOX' | 'USED' | 'DISCARDED'; pageCount: number; thumb: string | null; note: string | null; createdAt: string; capturedAt: string | null;
  read: { status: 'WAITING' | 'READ' | 'FAILED' | 'OFF' };
  ocr: { supplier: string | null; invoiceNumber: string | null; total: number | null; currency: string | null } | null;
  billNumber: string | null;
}

/** A photo, made small enough to send: the longest side at most `max` pixels, as JPEG. */
export async function shrinkPhoto(file: Blob, max = 1800, quality = 0.82): Promise<string> {
  let src: CanvasImageSource & { width: number; height: number };
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' } as any);
  } catch {
    // Older browsers: through an <img>, which applies the photo's rotation itself.
    src = await new Promise<HTMLImageElement>((ok, bad) => {
      const img = new Image();
      img.onload = () => ok(img); img.onerror = () => bad(new Error('That photo could not be opened.'));
      img.src = URL.createObjectURL(file);
    });
  }
  const scale = Math.min(1, max / Math.max(src.width, src.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(src.width * scale); canvas.height = Math.round(src.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This phone could not prepare the photo.');
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

const when = (v: string | null) => {
  const d = new Date(v || '');
  return isNaN(d.getTime()) ? '' : d.toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export const BillScanJob: React.FC<{ onClose: () => void; onError: (e: unknown) => void }> = ({ onClose, onError }) => {
  const [pages, setPages] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [mine, setMine] = useState<MyBillScan[]>([]);
  const camRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ref = useRef(newClientRef());

  const loadMine = useCallback(() => {
    api<{ items: MyBillScan[] }>('/api/bill-scans?status=ALL&mine=1').then(r => setMine((r.items || []).slice(0, 20))).catch(() => {});
  }, []);
  useEffect(() => {
    loadMine();
    const t = window.setInterval(() => { if (!document.hidden) loadMine(); }, 10_000);
    return () => window.clearInterval(t);
  }, [loadMine]);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true); setMsg(null);
    try {
      const room = 8 - pages.length;
      const next: string[] = [];
      for (const f of Array.from(files).slice(0, room)) next.push(await shrinkPhoto(f));
      setPages(p => [...p, ...next]);
      if (files.length > room) setMsg({ text: 'A bill can have up to 8 pages.', bad: true });
    } catch (e: any) { setMsg({ text: e?.message || 'That photo could not be used.', bad: true }); } finally { setBusy(false); }
  };

  const send = async () => {
    if (!pages.length) return;
    setBusy(true); setMsg(null);
    try {
      await api('/api/bill-scans', { method: 'POST', body: { pages, note: note.trim(), clientRef: ref.current, capturedAt: new Date().toISOString() } });
      setMsg({ text: `Sent (${pages.length} page${pages.length === 1 ? '' : 's'}). It's being read, and waits under Purchases > Bills on the website.` });
      setPages([]); setNote(''); ref.current = newClientRef();
      loadMine();
    } catch (e: any) { if (e?.status) setMsg({ text: e.message, bad: true }); else onError(e); } finally { setBusy(false); }
  };

  return (
    <>
      <section className={`${card} overflow-hidden`} aria-label="Scan a bill">
        <div className="px-4 py-3 border-b border-white/[0.07] bg-primary/10 flex items-center gap-2" data-no-mobile-stack>
          <Receipt className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-black">Scan a bill</p>
            <p className="text-xs text-on-surface-variant">Photograph each page of the supplier's invoice</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 p-1 text-on-surface-variant"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-4">
          {msg && <p role={msg.bad ? 'alert' : 'status'} className={`rounded-xl border text-sm font-semibold px-3.5 py-3 ${msg.bad ? 'border-error/25 bg-error/10 text-error' : 'border-green-500/25 bg-green-500/10 text-green-400'}`}>{msg.text}</p>}

          {pages.length > 0 && (
            <div>
              <p className={label}>Pages ({pages.length})</p>
              <div className="grid grid-cols-3 gap-2">
                {pages.map((p, i) => (
                  <div key={i} className="relative rounded-xl overflow-hidden border border-white/10 aspect-[3/4] bg-surface-container-low">
                    <img src={p} alt={`Page ${i + 1}`} className="w-full h-full object-cover" />
                    <span className="absolute left-1 top-1 rounded-md bg-black/70 px-1.5 text-[11px] font-bold">{i + 1}</span>
                    <button type="button" onClick={() => setPages(ps => ps.filter((_, j) => j !== i))} aria-label={`Remove page ${i + 1}`} className="absolute right-1 top-1 rounded-md bg-black/70 p-1 text-error"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <button type="button" disabled={busy || pages.length >= 8} onClick={() => camRef.current?.click()}
            className="w-full flex flex-col items-center justify-center gap-2 py-6 rounded-2xl border-2 border-dashed border-primary/40 bg-primary/5 active:scale-[0.98] disabled:opacity-40">
            <span className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary text-black shadow-lg">{busy ? <Loader2 className="w-7 h-7 animate-spin" aria-hidden="true" /> : pages.length ? <Plus className="w-7 h-7" aria-hidden="true" /> : <Camera className="w-7 h-7" aria-hidden="true" />}</span>
            <span className="text-base font-black">{pages.length ? 'Photograph the next page' : 'Photograph the bill'}</span>
            <span className="text-xs text-on-surface-variant">Flat, well lit, the whole page in view</span>
          </button>
          <button type="button" disabled={busy || pages.length >= 8} onClick={() => fileRef.current?.click()} className="w-full text-sm font-bold text-on-surface-variant py-1">or choose photos already taken</button>
          <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { void add(e.target.files); e.target.value = ''; }} aria-label="Take a photo of a page" />
          <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={e => { void add(e.target.files); e.target.value = ''; }} aria-label="Choose photos of the pages" />

          {pages.length > 0 && (
            <>
              <div><label className={label} htmlFor="bill-note">Note <span className="normal-case font-semibold">(optional)</span></label><input id="bill-note" className={field} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. delivery for PO-2026-0031" /></div>
              <button type="button" disabled={busy} onClick={() => void send()} className={`${big} bg-primary text-black shadow-lg`}>
                {busy ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> : <Send className="w-5 h-5" aria-hidden="true" />}Send {pages.length} page{pages.length === 1 ? '' : 's'}
              </button>
              <p className="text-xs text-on-surface-variant text-center -mt-1">The pages are read on the website and wait there; a bill is only made when someone creates it.</p>
            </>
          )}
        </div>
      </section>

      <section className="pt-2">
        <h2 className="text-sm font-black mb-2.5">Bills I've sent</h2>
        {!mine.length && <p className="text-sm text-on-surface-variant">None yet.</p>}
        <ul className="space-y-2">
          {mine.map(m => (
            <li key={m.id} className="rounded-xl border border-white/10 bg-surface-container p-3 flex items-center gap-3" data-no-mobile-stack>
              <span className="w-11 h-14 rounded-lg overflow-hidden bg-surface-container-high shrink-0 inline-flex items-center justify-center">{m.thumb ? <img src={m.thumb} alt="" className="w-full h-full object-cover" /> : <FileText className="w-5 h-5 text-on-surface-variant" />}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold truncate">{m.ocr?.supplier || (m.read.status === 'WAITING' ? 'Reading…' : 'Bill')}{m.ocr?.invoiceNumber ? <span className="font-normal text-on-surface-variant"> · {m.ocr.invoiceNumber}</span> : null}</p>
                <p className="text-xs text-on-surface-variant truncate">{[m.ocr?.total != null ? `${m.ocr.currency || 'ZAR'} ${m.ocr.total.toFixed(2)}` : null, `${m.pageCount} page${m.pageCount === 1 ? '' : 's'}`, when(m.capturedAt || m.createdAt), m.note].filter(Boolean).join(' · ')}</p>
                <p className="mt-1">
                  {m.status === 'INBOX' && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border bg-primary/10 text-primary border-primary/30"><Clock className="w-3 h-3" />Waiting on the website</span>}
                  {m.status === 'USED' && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border bg-green-500/10 text-green-400 border-green-500/25"><CheckCircle2 className="w-3 h-3" />{m.billNumber ? `Bill ${m.billNumber}` : 'Used'}</span>}
                  {m.status === 'DISCARDED' && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border bg-error/10 text-error border-error/25"><XCircle className="w-3 h-3" />Discarded</span>}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
};
