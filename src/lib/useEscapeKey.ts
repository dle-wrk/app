import { useEffect } from 'react';

// Escape-to-close hook. Registers a window-level keydown listener that
// fires the supplied callback on Escape and cleans it up on unmount.
//
// The shared bookkeeping Modal wrapper already bakes this in. Use this
// hook from inline modals in App.tsx, ProjectsView, ItemDetailModal,
// etc. that don't route through the shared wrapper, so keyboard users
// can dismiss them without reaching for the mouse.
//
// Nesting note: all listeners live on window, so opening a modal-over-
// a-modal would fire both onClose handlers on one Escape press. The
// current app doesn't stack modals like that (link-components opens
// alone, delete-confirm opens alone), so a single listener per modal
// is fine. If nesting becomes a thing, promote to a stack registry
// that only fires the top listener.
export function useEscapeKey(onClose: () => void, enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, enabled]);
}
