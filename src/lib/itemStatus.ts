// An item's status (Items & Inventory > Status Code): one list for the
// database rule, the server's checks, imports and the screens.
//
// DO NOT USE: the item is still in stock but must not go into builds or be
// suggested as an alternate (for example a faulty or quarantined batch).

export const ITEM_STATUSES = ['ACTIVE', 'INACTIVE', 'BOOKED OUT', 'DISCONTINUED', 'DO NOT USE'] as const;

export type ItemStatus = typeof ITEM_STATUSES[number];

/** The statuses as a SQL list: ('ACTIVE', 'INACTIVE', …). */
export const ITEM_STATUS_SQL = `(${ITEM_STATUSES.map((s) => `'${s}'`).join(', ')})`;

export function isItemStatus(value: unknown): value is ItemStatus {
  return (ITEM_STATUSES as readonly string[]).includes(String(value));
}
