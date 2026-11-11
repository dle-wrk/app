// A bill's receipt_image holds either one page as a bare data: URL (the
// original shape) or several pages as a JSON array of data: URLs. Everything
// that shows a receipt goes through receiptPages() so a multi-page receipt is
// never used as if it were one image address.

export function receiptPages(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const s = raw.trim();
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr.filter((v: unknown): v is string => typeof v === 'string' && v.startsWith('data:image/')) : [];
    } catch {
      return [];
    }
  }
  return s.startsWith('data:image/') ? [s] : [];
}

/** A data: URL as a Blob, so it can open in its own tab (browsers block opening data: URLs directly). */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(5, comma); // e.g. "image/jpeg;base64"
  const type = meta.split(';')[0] || 'application/octet-stream';
  const body = dataUrl.slice(comma + 1);
  if (meta.endsWith(';base64')) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }
  return new Blob([decodeURIComponent(body)], { type });
}

/**
 * Opens one receipt page full size in a new tab. Call it straight from a
 * click so it isn't blocked as a pop-up. Returns false if a pop-up blocker
 * stopped it.
 */
export function openReceiptPage(dataUrl: string): boolean {
  const url = URL.createObjectURL(dataUrlToBlob(dataUrl));
  // Not 'noopener' in the features: with it window.open always returns null,
  // and we need the handle to know whether a pop-up blocker stopped it.
  const tab = window.open(url, '_blank');
  if (tab) tab.opener = null;
  // The new tab has loaded the image by then; free the memory afterwards.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return !!tab;
}
