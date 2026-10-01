// Opens a file served by an /api endpoint.
//
// A plain <a href="/api/…"> can't be used for these: a browser navigation
// doesn't carry the X-Session-Id header, so the server answers 401. The
// file is fetched instead (the global fetch wrapper in main.tsx adds the
// header) and shown from a blob: URL.
//
// The tab is opened synchronously, inside the click, so popup blockers see
// it as user-initiated; it is pointed at the file once the download
// finishes. Anything a browser can't display inline — and HTML, which we
// never want to run from an upload — is saved to disk under its original
// name instead.
const INLINE_TYPES = /^(application\/pdf|image\/(png|jpe?g|gif|webp|bmp)|text\/plain)/i;

export async function openAuthedFile(url: string, fileName = 'download'): Promise<void> {
  const tab = window.open('', '_blank');
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error || `Could not open the file (${res.status})`);
    }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    if (tab && !tab.closed && INLINE_TYPES.test(blob.type)) {
      tab.location.replace(blobUrl);
    } else {
      if (tab && !tab.closed) tab.close();
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    // Leave the blob alive long enough for the tab or download to read it.
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60_000);
  } catch (err) {
    if (tab && !tab.closed) tab.close();
    throw err;
  }
}
