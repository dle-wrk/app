// Error messages shown to someone (the app's red notifications) go to the
// activity log as SHOWN_ERROR, with the screen they were on. This records
// forms that fail before reaching the server ("Choose the client", "Add at
// least one line"), alongside the server's own record of failed changes
// (./auditLog). The same message on the same screen is logged once a minute
// at most, so a repeated click doesn't flood the log.

let screen = 'unknown';
const recent = new Map<string, number>();
const REPEAT_MS = 60_000;

/** The screen the person is on, for the log entry. */
export function setShownErrorScreen(name: string): void { screen = name || 'unknown'; }

/** The signed-in person's email, from the saved session. */
function currentEmail(): string {
  try { return JSON.parse(localStorage.getItem('currentUser') || '{}')?.email || 'anonymous'; } catch { return 'anonymous'; }
}

/** Whether this message should be logged now (not already logged in the last minute). */
export function shouldLogShownError(message: string, now = Date.now()): boolean {
  const key = `${screen}|${message}`;
  const last = recent.get(key);
  if (last !== undefined && now - last < REPEAT_MS) return false;
  recent.set(key, now);
  if (recent.size > 200) for (const [k, t] of recent) if (now - t > REPEAT_MS) recent.delete(k);
  return true;
}

export function logShownError(message: string): void {
  const text = String(message ?? '').trim();
  if (!text || !shouldLogShownError(text)) return;
  try {
    void fetch('/api/activity-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        userEmail: currentEmail(),
        action: 'SHOWN_ERROR',
        entityType: screen,
        details: { source: 'screen', message: text.slice(0, 500), screen, page: typeof location !== 'undefined' ? location.pathname : null },
        status: 'ERROR',
      }),
    }).catch(() => { /* logging must never get in the way */ });
  } catch { /* ignore */ }
}
