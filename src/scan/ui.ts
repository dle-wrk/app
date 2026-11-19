// Shared looks for the phone scan page's screens.

export const field = 'w-full rounded-xl border border-white/10 bg-surface-container-low px-3.5 py-3 text-base text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
export const label = 'block text-[11px] font-bold uppercase tracking-wide text-on-surface-variant mb-1.5';
export const card = 'rounded-2xl border border-white/10 bg-surface-container shadow-lg shadow-black/20';
export const big = 'w-full flex items-center justify-center gap-2 py-4 rounded-2xl font-black text-base disabled:opacity-40 transition-transform active:scale-[0.98]';

export const TONE = {
  IN: { solid: 'bg-green-600 text-white', soft: 'bg-green-500/10 text-green-400 border-green-500/25', text: 'text-green-400', ring: 'border-green-500/40' },
  OUT: { solid: 'bg-amber-500 text-black', soft: 'bg-amber-500/10 text-amber-400 border-amber-500/25', text: 'text-amber-400', ring: 'border-amber-500/40' },
} as const;
