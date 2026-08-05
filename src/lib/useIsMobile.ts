import { useEffect, useState } from 'react';

// Tailwind's md breakpoint. Kept in one place so the JS side and CSS side
// (which uses the md:/lg: prefixes) stay in agreement.
export const MOBILE_BREAKPOINT_PX = 768;

/**
 * True when the viewport is narrower than the mobile breakpoint. Reacts to
 * resize and to orientation changes on real devices.
 *
 * Use this for structural decisions React needs to make (mount a drawer vs
 * inline it, use a bottom sheet vs a modal, virtualise a table vs render a
 * card list). Cosmetic sizing should still be done with Tailwind's md:/lg:
 * prefixes — that avoids a client re-render just to change a padding value.
 *
 * SSR-safe: returns false during the initial synchronous render on the server
 * (there is no window), then the useEffect resolves to the real value.
 */
export function useIsMobile(breakpoint = MOBILE_BREAKPOINT_PX): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(`(max-width: ${breakpoint - 1}px)`).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // The initial state was set from matchMedia in useState, but if the caller
    // passes a different breakpoint we sync once here.
    setIsMobile(mq.matches);
    // matchMedia.addListener is deprecated but Safari <14 needs it. Modern
    // browsers get addEventListener; both are wired defensively.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mq as any).addListener(handler);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return () => (mq as any).removeListener(handler);
  }, [breakpoint]);

  return isMobile;
}
