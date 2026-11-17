import React, { useEffect, useRef, useState } from 'react';
import { CameraOff, ScanLine, X } from 'lucide-react';

// The camera barcode scanner. Uses the browser's own barcode reader where it
// has one (Chrome on Android), and the ZXing library otherwise (Safari on
// iPhone), loaded only then. Reads the 2D codes on supplier reel labels
// (Data Matrix, QR) and ordinary barcodes (Code 128, Code 39, EAN). The
// scanned text is passed on untouched: reel labels separate their fields
// with control characters the server needs.

const FORMATS = ['data_matrix', 'qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'itf', 'pdf417'];

export const CodeScanner: React.FC<{ onCode: (code: string) => void; onClose: () => void; hint?: string; title?: string }> = ({ onCode, onClose, hint, title }) => {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const done = useRef(false);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopZxing: (() => void) | null = null;
    let live = true;
    const found = (text: string) => {
      if (done.current || !text) return;
      done.current = true;
      try { navigator.vibrate?.(60); } catch { /* not every phone */ }
      onCodeRef.current(text);
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setProblem('This browser cannot use the camera. Type the code instead.'); return; }
      try {
        const Native = (window as any).BarcodeDetector;
        let formats: string[] = [];
        if (Native) { try { formats = (await Native.getSupportedFormats()).filter((f: string) => FORMATS.includes(f)); } catch { formats = []; } }
        if (Native && formats.includes('data_matrix') && formats.includes('qr_code')) {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } }, audio: false });
          if (!live || !video.current) { stream.getTracks().forEach(t => t.stop()); return; }
          video.current.srcObject = stream;
          await video.current.play().catch(() => {});
          const detector = new Native({ formats });
          let last = 0;
          const tick = async (t: number) => {
            if (!live || done.current) return;
            if (t - last > 150 && video.current && video.current.readyState >= 2) {
              last = t;
              try { const codes = await detector.detect(video.current); if (codes[0]?.rawValue) found(String(codes[0].rawValue)); } catch { /* a frame that couldn't be read */ }
            }
            raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
        } else {
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          if (!live || !video.current) return;
          const reader = new BrowserMultiFormatReader();
          const controls = await reader.decodeFromConstraints(
            { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } }, audio: false },
            video.current,
            (result) => { if (result) found(result.getText()); },
          );
          stopZxing = () => controls.stop();
          if (!live) controls.stop();
        }
      } catch (e: any) {
        const name = String(e?.name || '');
        setProblem(name === 'NotAllowedError' ? 'Camera access was refused. Allow the camera for this site in the browser settings, or type the code instead.'
          : name === 'NotFoundError' ? 'No camera found on this device. Type the code instead.'
          : 'The camera could not be started. Type the code instead.');
      }
    })();

    return () => {
      live = false;
      cancelAnimationFrame(raf);
      stopZxing?.();
      stream?.getTracks().forEach(t => t.stop());
    };
  }, []);

  // Escape closes it (a desk computer with a webcam).
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const corner = 'absolute w-9 h-9 border-primary';
  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col text-white" role="dialog" aria-label={title || 'Scan a code'}>
      <div className="relative flex-1 overflow-hidden">
        <video ref={video} className="absolute inset-0 w-full h-full object-cover" playsInline muted autoPlay />
        <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-3 px-4 pb-6 bg-gradient-to-b from-black/80 to-transparent" style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }} data-no-mobile-stack>
          <ScanLine className="w-5 h-5 text-primary" aria-hidden="true" />
          <p className="flex-1 font-black">{title || 'Scan a code'}</p>
          <button onClick={onClose} aria-label="Close camera" className="w-10 h-10 rounded-full bg-white/15 inline-flex items-center justify-center"><X className="w-5 h-5" /></button>
        </div>
        {!problem && (
          // A dimmed surround with a clear window, its corners marked, and a line sweeping it.
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[78%] max-w-[22rem] aspect-[4/3] rounded-2xl shadow-[0_0_0_9999px_rgba(0,0,0,0.5)] pointer-events-none" aria-hidden="true">
            <span className={`${corner} left-0 top-0 border-l-4 border-t-4 rounded-tl-2xl`} />
            <span className={`${corner} right-0 top-0 border-r-4 border-t-4 rounded-tr-2xl`} />
            <span className={`${corner} left-0 bottom-0 border-l-4 border-b-4 rounded-bl-2xl`} />
            <span className={`${corner} right-0 bottom-0 border-r-4 border-b-4 rounded-br-2xl`} />
            <span className="scan-sweep absolute inset-x-4 h-0.5 rounded-full bg-primary shadow-[0_0_12px_2px_rgba(255,140,0,0.7)]" />
          </div>
        )}
        {problem && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center">
            <CameraOff className="w-10 h-10 text-white/60" aria-hidden="true" />
            <p className="text-sm text-white/90">{problem}</p>
          </div>
        )}
      </div>
      <div className="p-4 bg-black" style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
        <p className="text-center text-sm text-white/75 mb-3">{problem ? 'Close the camera to type the code.' : (hint || 'Hold the label inside the frame')}</p>
        <button onClick={onClose} className="w-full py-3.5 rounded-2xl bg-white/15 font-bold text-base active:bg-white/25">{problem ? 'Type the code instead' : 'Close camera'}</button>
      </div>
    </div>
  );
};
