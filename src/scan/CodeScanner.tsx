import React, { useEffect, useRef, useState } from 'react';

// The camera barcode scanner. Uses the browser's own barcode reader where it
// has one (Chrome on Android), and the ZXing library otherwise (Safari on
// iPhone), loaded only then. Reads the 2D codes on supplier reel labels
// (Data Matrix, QR) and ordinary barcodes (Code 128, Code 39, EAN). The
// scanned text is passed on untouched: reel labels separate their fields
// with control characters the server needs.

const FORMATS = ['data_matrix', 'qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'itf', 'pdf417'];

export const CodeScanner: React.FC<{ onCode: (code: string) => void; onClose: () => void; hint?: string }> = ({ onCode, onClose, hint }) => {
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

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col" role="dialog" aria-label="Scan a code">
      <div className="relative flex-1 overflow-hidden">
        <video ref={video} className="absolute inset-0 w-full h-full object-cover" playsInline muted autoPlay />
        {!problem && <div className="absolute inset-x-8 top-1/2 -translate-y-1/2 h-48 border-2 border-white/80 rounded-xl pointer-events-none" aria-hidden="true" />}
        {problem && <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-white text-sm">{problem}</div>}
      </div>
      <div className="p-4 bg-black text-white" style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
        <p className="text-center text-sm opacity-80 mb-3">{hint || 'Hold the label inside the frame'}</p>
        <button onClick={onClose} className="w-full py-3 rounded-xl bg-white/15 font-bold text-base">Close camera</button>
      </div>
    </div>
  );
};
