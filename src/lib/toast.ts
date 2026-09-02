// Global toast singleton.
//
// App.tsx owns the actual toast state (message, type, visible, timer) and
// registers its trigger function here on mount. Any component — including
// ones deep in the tree that never received the callback as a prop — can
// import `showToast` and surface a notification through the same UI.
//
// This exists so `optimisticUpdate` can trigger a rollback toast from any
// component without every write path prop-drilling triggerToast down.
// The alternative (React context) would work too, but requires threading
// a Provider and useContext hook through non-render code paths (utility
// modules, service functions) that don't sit inside the React tree.

export type ToastType = 'SUCCESS' | 'ERROR' | 'INFO';

type ToastHandler = (message: string, type?: string) => void;

let handler: ToastHandler | null = null;
// Buffer toasts fired before App.tsx mounts (e.g. from a top-level bootstrap
// error). Once the handler registers, we drain the buffer in order.
const pending: Array<{ message: string; type: string }> = [];

export function setToastHandler(fn: ToastHandler | null): void {
  handler = fn;
  if (fn && pending.length) {
    const drained = pending.splice(0, pending.length);
    for (const { message, type } of drained) fn(message, type);
  }
}

export function showToast(message: string, type: ToastType | string = 'SUCCESS'): void {
  if (handler) {
    handler(message, type);
    return;
  }
  // Fall back to console + buffer if the UI isn't mounted yet. The buffer
  // is capped so a runaway loop can't blow memory before the handler lands.
  if (pending.length < 20) pending.push({ message, type });
  console.warn('[toast:pending]', type, message);
}
