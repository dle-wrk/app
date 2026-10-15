// Potential Orders: work a client may still go ahead with, kept out of the
// books and off the overdue / outstanding lists until it is confirmed. They
// come from an invoice (taken out of the books: its journal entry reversed,
// its stock returned, the invoice voided), a sales order or quote (parked:
// reservations released), or are made from scratch. Each has an expected
// decision date, a likelihood and a reason; it ends Won (becoming a quote,
// sales order or draft invoice) or Lost. Routes: ./potentialOrdersRoutes.

export const POTENTIAL_STATUSES = ['OPEN', 'WON', 'LOST'] as const;
export type PotentialStatus = typeof POTENTIAL_STATUSES[number];
export const LIKELIHOODS = [10, 25, 50, 75, 90] as const;
export const WIN_TARGETS = ['quotation', 'sales_order', 'invoice'] as const;
export type WinTarget = typeof WIN_TARGETS[number];

export interface PotentialLine {
  partNumber: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRateId: number | null;
  taxInclusive: boolean;
}

export interface PotentialSummary {
  status: PotentialStatus;
  total: number;
  likelihoodPct: number | null;
  expectedDate: string | null;
}

/** Open total, and weighted by likelihood (unknown likelihood counts at 50%). */
export function pipelineTotals(rows: PotentialSummary[], today = new Date().toISOString().slice(0, 10)) {
  const open = rows.filter((r) => r.status === 'OPEN');
  const total = open.reduce((s, r) => s + (Number(r.total) || 0), 0);
  const weighted = open.reduce((s, r) => s + (Number(r.total) || 0) * ((r.likelihoodPct ?? 50) / 100), 0);
  return {
    count: open.length,
    total: Math.round(total * 100) / 100,
    weighted: Math.round(weighted * 100) / 100,
    decisionDue: open.filter((r) => r.expectedDate && r.expectedDate <= today).length,
  };
}

/** One entry in a client's history. */
export interface HistoryEntry {
  at: string;                 // ISO date or timestamp
  kind: 'quotation' | 'sales_order' | 'invoice' | 'payment' | 'credit_note' | 'delivery' | 'potential' | 'note' | 'call' | 'meeting' | 'email' | 'system';
  title: string;
  detail: string | null;
  docNumber: string | null;
  amount: number | null;
  currency: string | null;
  by: string | null;
  eventId: number | null;     // a note or system event (can carry a follow-up)
  followUpDate: string | null;
  followUpDone: boolean;
}

/** Newest first; on the same day, events (notes, moves) before documents. */
export function sortHistory(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => {
    const t = String(b.at).localeCompare(String(a.at));
    if (t) return t;
    return Number(b.eventId !== null) - Number(a.eventId !== null);
  });
}

export const NOTE_KINDS = ['note', 'call', 'meeting', 'email'] as const;
