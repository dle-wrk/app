// A "?" next to a page title: hovering shows a short how-to, clicking keeps it
// open until clicked again, Escape or a click elsewhere.

import React, { useEffect, useId, useRef, useState } from 'react';
import { HelpCircle, X } from 'lucide-react';

export default function HowToTip({ title, children, label = 'How to use this page' }: { title: string; children: React.ReactNode; label?: string }) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const open = hover || pinned;
  useEffect(() => {
    if (!pinned) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setPinned(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPinned(false); setHover(false); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [pinned]);
  return (
    <div ref={box} className="relative inline-flex align-middle" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button type="button" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setPinned((p) => !p)}
        className={`p-1 rounded-full transition-colors ${open ? 'text-primary' : 'text-outline hover:text-primary'}`}>
        <HelpCircle className="w-4 h-4" />
      </button>
      {open && (
        <div id={id} role="dialog" aria-label={title}
          className="absolute left-0 top-full z-50 mt-1 w-[min(420px,calc(100vw-32px))] rounded-xl border border-outline-variant bg-surface-container-high p-md shadow-xl text-left">
          <span className="flex items-start justify-between gap-sm mb-1">
            <span className="text-xs font-bold text-on-surface">{title}</span>
            {pinned && <button type="button" aria-label="Close the guide" className="text-outline hover:text-on-surface" onClick={() => { setPinned(false); setHover(false); }}><X className="w-3.5 h-3.5" /></button>}
          </span>
          <div className="text-[11px] leading-relaxed text-on-surface-variant font-normal">{children}</div>
        </div>
      )}
    </div>
  );
}
