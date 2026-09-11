// Shared brand header for every printable document (sales orders,
// delivery/collection notes, invoices). Used by three separate print
// helpers so future changes to the header live in one place — swap the
// logo file, tweak the tagline, adjust the divider colour — instead of
// having to keep three copies in sync.
//
// Rendering strategy: an <img> pointing at the static asset the app
// serves from public/. The <img alt="TRACKLAB"> falls back to showing
// the alt text if the file is missing or the browser blocks it, so the
// print flow never leaves a page with a completely empty header. We
// also expose a `waitForBrandImage(win)` helper so callers can hold off
// on window.print() until the image has decoded — otherwise a fast
// print() call can fire before the logo has painted and the printed
// page ends up without it.
//
// If we ever need to embed the logo directly (e.g. some browsers block
// same-origin image requests from window.open blank documents), swap
// the src for a data: URL. Keeping it as a static file for now because
// the payload is small enough that either works and static keeps the
// HTML strings shorter.

// Path relative to the app's public/ directory. The Express catch-all
// falls through to public/ for non-/api routes, so this URL resolves
// the same in dev (Vite) and prod (Fly).
const LOGO_URL = '/tracklab-logo.png';

// Right-aligned text panel shown to the right of the logo (e.g. document
// type + doc number). Kept small so it doesn't compete with the brand.
export interface DocTypeBlock {
  title: string;   // e.g. "Sales Order", "Delivery Note", "Tax Invoice"
  number: string;  // e.g. "SO-2026-0001"
}

// Renders the header HTML block. Height budget: ~72px so it doesn't
// eat too much of the printable page. maxWidth on the img is what
// caps the visible logo size — the source file can be any resolution.
export function renderBrandHeader(doc: DocTypeBlock): string {
  const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
  return `
  <div class="brand" style="border-bottom:3px solid #f7912b;padding-bottom:16px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:flex-end;gap:24px">
    <div style="flex:0 1 auto">
      <img
        src="${LOGO_URL}"
        alt="TRACKLAB"
        class="brand-logo"
        style="display:block;max-width:240px;max-height:60px;width:auto;height:auto;font-size:28px;font-weight:900;color:#f7912b;letter-spacing:-0.5px"
      />
      <div class="tagline" style="font-size:10px;color:#666;letter-spacing:1px;text-transform:uppercase;margin-top:4px">
        Inventory · Manufacturing · Compliance
      </div>
    </div>
    <div class="doc-type" style="text-align:right;flex:0 0 auto">
      <h2 style="margin:0;font-size:20px;font-weight:700">${esc(doc.title)}</h2>
      <div class="num" style="font-family:ui-monospace,monospace;font-size:14px;color:#f7912b;margin-top:4px">${esc(doc.number)}</div>
    </div>
  </div>`;
}

// Wait for the brand image inside a print window to finish loading (or
// error out — a broken image still counts as "done" because the alt
// text is visible). Falls through after 1500ms regardless so a genuinely
// dead network never blocks the print dialog forever.
//
// Usage: after w.document.write(...) + w.document.close(),
//   await waitForBrandImage(w);
//   w.print();
export function waitForBrandImage(win: Window): Promise<void> {
  return new Promise((resolve) => {
    const img = win.document.querySelector('img.brand-logo') as HTMLImageElement | null;
    if (!img) return resolve();
    if (img.complete) return resolve();
    const done = () => { img.removeEventListener('load', done); img.removeEventListener('error', done); resolve(); };
    img.addEventListener('load', done);
    img.addEventListener('error', done);
    setTimeout(done, 1500);
  });
}
