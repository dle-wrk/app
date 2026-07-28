import { Transaction } from '../types';

// The transactions table was created with unquoted mixed-case identifiers
// (trxId, itemPartNumber, qtyChange, performedBy, dateTime, ...). PostgreSQL
// folds unquoted identifiers to lower case, so SELECT * hands back
// trxid / itempartnumber / qtychange / performedby / datetime.
// Dropping those raw rows into state left the ledger's Item Specifications,
// Adjustment Qty, Performed By and Date & Time columns blank — only id, type
// and reference happened to survive, being single lower-case words.
//
// Rows created locally in the frontend are already camelCase, so accept either
// spelling and normalize to the Transaction shape.
export function mapDbRowToTransaction(row: any): Transaction {
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = row?.[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };

  const qtyRaw = pick('qtyChange', 'qtychange', 'qty_change');
  const qtyChange = typeof qtyRaw === 'number' ? qtyRaw : parseInt(String(qtyRaw ?? '0'), 10) || 0;

  const costRaw = pick('newCost', 'newcost', 'new_cost');
  const newCost = costRaw === undefined ? undefined : (parseFloat(String(costRaw)) || undefined);

  return {
    // Prefer the human-readable trx reference; fall back to the numeric row id.
    id: String(pick('trxId', 'trxid', 'trx_id') ?? pick('id') ?? ''),
    itemPartNumber: String(pick('itemPartNumber', 'itempartnumber', 'item_part_number') ?? ''),
    itemName: String(pick('itemName', 'itemname', 'item_name') ?? ''),
    type: (pick('type') ?? 'BOOK-IN') as Transaction['type'],
    qtyChange,
    reference: String(pick('reference') ?? ''),
    performedBy: String(pick('performedBy', 'performedby', 'performed_by') ?? 'System'),
    performedByAvatar: pick('performedByAvatar', 'performedbyavatar', 'performed_by_avatar'),
    dateTime: String(pick('dateTime', 'datetime', 'date_time') ?? ''),
    newCost,
  };
}

export function mapDbRowsToTransactions(payload: any): Transaction[] {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return rows.filter(Boolean).map(mapDbRowToTransaction);
}

// Ledger timestamps arrive either as ISO strings (rows written by the server)
// or as pre-formatted display strings like "Jul 24, 10:17" (legacy seed data).
// Render both without turning the latter into "Invalid Date".
export function formatTrxDateTime(value: string): string {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// 'INBOUND'/'OUTBOUND' are the ledger's filter buckets, but stored rows use
// 'BOOK-IN'/'BOOK-OUT'. Matching on equality alone made both filters empty.
export function isInboundType(type: string): boolean {
  return type === 'INBOUND' || type === 'BOOK-IN';
}

export function isOutboundType(type: string): boolean {
  return type === 'OUTBOUND' || type === 'BOOK-OUT';
}
