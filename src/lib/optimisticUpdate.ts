import { showToast } from './toast';

// Optimistic-mutation helper for write paths.
//
// The old pattern was: POST/PATCH -> await response -> refetch the full list
// -> re-setState. Two round-trips per edit, one of which was a ~30KB list
// pull, plus a hard freeze on the UI while the network was in flight. On a
// 300ms mobile RTT that's ~600ms of "did anything happen?" per save.
//
// This helper collapses the pattern to: snapshot -> apply immediately ->
// fire request in the background -> rollback + error toast if it fails.
// Users see the result the instant they click; the network becomes a
// silent background writer.
//
// A note on when NOT to use this: server-generated fields (auto-increment
// IDs, computed timestamps, server-side defaults) can't be applied
// optimistically because the client doesn't know them yet. For those,
// either wait for the response or apply optimistically with a temporary
// client-side id and reconcile in onSuccess.

export type OptimisticOptions<TSnapshot> = {
  // Take a snapshot of whatever state you're about to touch — the return
  // value is passed back to rollback() if the request fails.
  snapshot: () => TSnapshot;

  // Apply the change to state immediately, before the network call. Runs
  // synchronously; any error here surfaces to the caller unchanged (it's
  // treated as a programmer bug, not a network failure).
  applyOptimistic: () => void;

  // Restore state to the snapshot on request failure. Called with the
  // exact value snapshot() returned. Also runs synchronously.
  rollback: (snapshot: TSnapshot) => void;

  // The mutation itself. Must return the raw Response so the helper can
  // check res.ok and pull an error body out of a non-2xx.
  request: () => Promise<Response>;

  // Optional override for the toast primitive. Defaults to the global
  // singleton in ./toast, which App.tsx registers on mount — most callers
  // can omit this and let the singleton handle it. The signature accepts
  // either the loose (msg, type?: string) shape from App.tsx or the
  // narrower typed variants used by some components — both work because
  // the helper only ever passes 'SUCCESS' or 'ERROR'.
  triggerToast?: (message: string, type?: any) => void;

  // Human-readable messages. Success is fire-and-forget; error is shown
  // when we rollback so the user knows their action didn't stick.
  successMsg?: string;
  errorMsg: string;

  // Runs after a 2xx response, before the success toast. Use for
  // reconciling any server-assigned fields (e.g. autoincrement id).
  onSuccess?: (res: Response) => void | Promise<void>;

  // Runs after rollback, before the error toast. Use it to log to
  // Sentry or to activity logs.
  onError?: (err: Error, snapshot: TSnapshot) => void | Promise<void>;
};

export async function optimisticUpdate<TSnapshot>(opts: OptimisticOptions<TSnapshot>): Promise<boolean> {
  const toast = opts.triggerToast ?? showToast;
  const snap = opts.snapshot();
  opts.applyOptimistic();

  try {
    const res = await opts.request();
    if (!res.ok) {
      // Pull a message out of the response body for the log — the user
      // gets the caller-supplied errorMsg (which is usually more helpful
      // than a raw "duplicate key" from Postgres).
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    if (opts.onSuccess) await opts.onSuccess(res);
    if (opts.successMsg) toast(opts.successMsg, 'SUCCESS');
    return true;
  } catch (err) {
    opts.rollback(snap);
    const wrapped = err instanceof Error ? err : new Error(String(err));
    if (opts.onError) {
      try { await opts.onError(wrapped, snap); } catch { /* onError must not mask the toast */ }
    }
    console.error(opts.errorMsg, wrapped);
    toast(opts.errorMsg, 'ERROR');
    return false;
  }
}
