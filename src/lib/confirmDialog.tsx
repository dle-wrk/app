// Themed confirm-dialog singleton. Same pattern as ./toast — a handler
// registers on mount, callers get a Promise<boolean> from anywhere in
// the tree. Replaces window.confirm(), which was jarring, browser-
// styled, and impossible to fit into the app's dark theme.
//
// Usage:
//   import { confirmDialog } from '../lib/confirmDialog';
//   if (!(await confirmDialog('Delete this customer?'))) return;
//   // or with options:
//   const ok = await confirmDialog({
//     title: 'Void bill',
//     message: 'This posts a reversing journal entry and cannot be undone.',
//     confirmLabel: 'Void',
//     destructive: true,
//   });
//
// Every caller must be async (unlike window.confirm which was
// synchronous) — every existing call site was already inside an async
// handler so this isn't a burden in practice.

import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useEscapeKey } from './useEscapeKey';

export type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type PendingConfirm = { opts: ConfirmOptions; resolve: (value: boolean) => void };
type ConfirmHandler = (opts: ConfirmOptions) => Promise<boolean>;

let handler: ConfirmHandler | null = null;
// Pre-mount buffer for the rare case that a confirm fires before the
// host component has registered. Kept tiny — if we hit the cap it means
// something is looping and eating memory would only make it worse.
const pending: PendingConfirm[] = [];

export function setConfirmHandler(fn: ConfirmHandler | null): void {
  handler = fn;
  if (fn && pending.length) {
    const drained = pending.splice(0, pending.length);
    for (const p of drained) fn(p.opts).then(p.resolve);
  }
}

export function confirmDialog(input: ConfirmOptions | string): Promise<boolean> {
  const opts: ConfirmOptions = typeof input === 'string' ? { message: input } : input;
  if (handler) return handler(opts);
  // Fall back to a queued promise; drained when the host mounts.
  return new Promise<boolean>((resolve) => {
    if (pending.length < 20) {
      pending.push({ opts, resolve });
    } else {
      console.warn('[confirmDialog] queue full — auto-cancelling');
      resolve(false);
    }
  });
}

// The visible component. Mount once at the App root (App.tsx renders
// <ConfirmDialogHost /> alongside its toast host). Registers the
// singleton handler on mount and clears it on unmount, so nothing else
// in the tree needs to know about it.
export const ConfirmDialogHost: React.FC = () => {
  const [state, setState] = useState<PendingConfirm | null>(null);

  useEffect(() => {
    setConfirmHandler((opts) => new Promise<boolean>((resolve) => {
      setState({ opts, resolve });
    }));
    return () => setConfirmHandler(null);
  }, []);

  const close = (value: boolean) => {
    if (!state) return;
    state.resolve(value);
    setState(null);
  };

  useEscapeKey(() => close(false), state !== null);

  if (!state) return null;
  const { opts } = state;
  const confirmLabel = opts.confirmLabel ?? 'Confirm';
  const cancelLabel = opts.cancelLabel ?? 'Cancel';
  const confirmClass = opts.destructive
    ? 'bg-red-500 text-white hover:brightness-110'
    : 'bg-primary text-on-primary hover:brightness-110';

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-background/80 backdrop-blur-xs p-md"
      onClick={() => close(false)}
    >
      <div
        className="bg-surface-container border border-outline-variant rounded-xl shadow-2xl max-w-[448px] w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-lg py-md border-b border-outline-variant flex items-center gap-xs">
          {opts.destructive && <AlertTriangle className="w-4 h-4 text-red-400" />}
          <h4 className="font-bold text-sm text-on-surface">{opts.title ?? (opts.destructive ? 'Confirm delete' : 'Confirm')}</h4>
        </div>
        <div className="px-lg py-md text-xs text-on-surface-variant whitespace-pre-wrap">
          {opts.message}
        </div>
        <div className="px-lg py-md border-t border-outline-variant flex justify-end gap-sm">
          <button
            onClick={() => close(false)}
            className="px-md py-1.5 rounded-lg text-xs font-bold border border-outline-variant text-on-surface hover:bg-surface-variant/40 transition-all"
          >
            {cancelLabel}
          </button>
          <button
            onClick={() => close(true)}
            autoFocus
            className={`px-md py-1.5 rounded-lg text-xs font-bold active:scale-95 transition-all ${confirmClass}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
