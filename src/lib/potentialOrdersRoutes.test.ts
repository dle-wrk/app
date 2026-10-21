import { beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in database: each SQL statement is matched to a canned answer and recorded.
const state: { sql: string[]; invoice: any; items: any[]; credits: any[]; order: any; orderItems: any[]; refs: boolean; potential: any; parked: any } = {} as any;
const answer = (sql: string, params: any[] = []): any => {
  state.sql.push(sql.replace(/\s+/g, ' ').trim());
  if (/^SELECT \* FROM invoices WHERE id/.test(sql)) return { rows: state.invoice ? [state.invoice] : [] };
  if (/FROM credit_notes WHERE invoice_id/.test(sql)) return { rows: state.credits };
  if (/FROM invoice_items WHERE invoice_id/.test(sql)) return { rows: state.items };
  if (/status = 'POTENTIAL' FOR UPDATE/.test(sql)) return { rows: state.parked ? [state.parked] : [] };
  if (/^SELECT \* FROM client_orders WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: state.order ? [state.order] : [] };
  if (/FROM client_order_items WHERE client_order_id/.test(sql)) return { rows: state.orderItems };
  if (/FROM (invoices|dispatch_notes) WHERE client_order_id/.test(sql)) return { rows: state.refs ? [{ '?column?': 1 }] : [] };
  if (/^INSERT INTO potential_orders/.test(sql)) return { rows: [{ id: 1, number: params[0], client_id: params[1], currency: params[2], lines: JSON.parse(params[3]), subtotal: params[4], tax_total: params[5], total: params[6], status: 'OPEN', source_type: params[11], source_number: params[13] }] };
  if (/^SELECT \* FROM potential_orders WHERE id/.test(sql)) return { rows: state.potential ? [state.potential] : [] };
  if (/^UPDATE potential_orders SET status = 'WON'/.test(sql)) return { rows: [{ ...state.potential, status: 'WON', outcome_doc_type: params[0], outcome_doc_id: params[1], outcome_doc_number: params[2] }] };
  if (/^INSERT INTO invoices/.test(sql)) return { rows: [{ id: 99 }] };
  if (/^INSERT INTO client_orders/.test(sql)) return { rows: [{ id: 55 }] };
  return { rows: [], rowCount: 1 };
};
vi.mock('./db', () => ({
  pool: { connect: async () => ({ query: async (sql: string, params?: any[]) => answer(sql, params), release: () => {} }) },
  query: async (sql: string, params?: any[]) => answer(sql, params),
  queryOne: async () => null,
  exec: async () => {},
}));
const reversed: any[] = [];
const stock: any[] = [];
const reserved: any[] = [];
vi.mock('./bookkeeping-db', async () => {
  const real = await vi.importActual<any>('./bookkeeping-db');
  return {
    ...real,
    nextDocNumber: async (_db: any, prefix: string) => `${prefix}-2026-0001`,
    reverseJournalEntry: async (_db: any, id: number, opts: any) => { reversed.push({ id, memo: opts.memo }); return 1; },
    rewriteReservations: async (_db: any, id: number, lines: any[]) => { reserved.push({ id, lines }); },
  };
});
vi.mock('./bookkeeping-routes', () => ({
  returnInvoiceStock: async (_db: any, invoiceNumber: string, why: string) => { stock.push({ invoiceNumber, why }); return []; },
  resolveTaxPercent: async (id: number | null) => (id === 1 ? 15 : 0),
}));

import { registerPotentialOrdersRoutes } from './potentialOrdersRoutes';

const routes = new Map<string, Function>();
registerPotentialOrdersRoutes({
  get: (p: string, h: Function) => routes.set(`GET ${p}`, h), post: (p: string, h: Function) => routes.set(`POST ${p}`, h),
  put: (p: string, h: Function) => routes.set(`PUT ${p}`, h),
} as any);
async function call(key: string, params: Record<string, string>, body: any = {}) {
  const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
  await routes.get(key)!({ params, body, query: {}, user: { email: 'dylan@lumaxenergy.com' } }, res);
  return res;
}

beforeEach(() => {
  Object.assign(state, { sql: [], credits: [], refs: false, potential: null, order: null, orderItems: [], parked: null });
  state.invoice = { id: 7, invoice_number: 'INV-2026-0005', client_id: 3, status: 'OVERDUE', amount_paid: '0.00', currency: 'ZAR', notes: null, journal_entry_id: 41 };
  state.items = [
    { part_number: 'NCU-SYS-001', description: 'NCU cabinet', quantity: '1', unit_price: '33392.26', tax_rate_id: 1, tax_inclusive: false, deduct_stock: true },
    { part_number: 'SOFT-001', description: 'Software', quantity: '1', unit_price: '7000', tax_rate_id: 1, tax_inclusive: false, deduct_stock: false },
  ];
  reversed.length = 0; stock.length = 0; reserved.length = 0;
});

describe('moving an invoice to Potential Orders', () => {
  it('takes it out of the books: journal reversed, stock it took returned, voided with a note', async () => {
    const r = await call('POST /api/potential-orders/from-invoice/:id', { id: '7' }, { likelihoodPct: 50, reason: 'Waiting on budget' });
    expect(r.statusCode).toBe(201);
    expect(r.body).toMatchObject({ number: 'POT-2026-0001', sourceType: 'invoice', sourceNumber: 'INV-2026-0005', total: 46451.1 }); // R40 392.26 + 15% VAT
    expect(reversed).toEqual([{ id: 41, memo: 'Invoice INV-2026-0005 moved to Potential Order POT-2026-0001' }]);
    expect(stock).toEqual([{ invoiceNumber: 'INV-2026-0005', why: 'moved to Potential Order POT-2026-0001' }]); // what the stock ledger says it took
    expect(state.sql.some((s) => s.startsWith("UPDATE invoices SET status = 'VOID'"))).toBe(true);
    expect(state.sql.some((s) => s.startsWith("INSERT INTO client_events") )).toBe(true);
    expect(state.sql.at(-1)).toBe('COMMIT');
  });

  it('refuses an invoice with payments or a credit note, changing nothing', async () => {
    state.invoice.amount_paid = '100.00';
    let r = await call('POST /api/potential-orders/from-invoice/:id', { id: '7' });
    expect([r.statusCode, r.body.error]).toEqual([400, 'It has payments against it: void or reallocate the payments first, or issue a credit note instead.']);
    state.invoice.amount_paid = '0'; state.credits = [{ credit_note_number: 'CN-2026-0002' }];
    r = await call('POST /api/potential-orders/from-invoice/:id', { id: '7' });
    expect(r.body.error).toContain('CN-2026-0002');
    expect(reversed).toEqual([]);
    expect(state.sql.at(-1)).toBe('ROLLBACK');
  });

  it('a draft invoice has nothing to reverse', async () => {
    state.invoice.status = 'DRAFT';
    await call('POST /api/potential-orders/from-invoice/:id', { id: '7' });
    expect(reversed).toEqual([]);
    expect(stock).toEqual([]);
  });
});

describe('parking a sales order', () => {
  it('releases its reservations and sets it POTENTIAL; one with an invoice or delivery is refused', async () => {
    state.order = { id: 12, order_number: 'SO-2026-0003', client_id: 3, status: 'APPROVED', currency: 'ZAR', notes: null };
    state.orderItems = [{ part_number: 'BAT-5K', description: 'Battery', quantity: '2', unit_price: '22000', tax_rate_id: 1 }];
    const r = await call('POST /api/potential-orders/from-order/:id', { id: '12' });
    expect(r.body).toMatchObject({ sourceType: 'sales_order', sourceNumber: 'SO-2026-0003' });
    expect(state.sql).toContain('DELETE FROM client_order_reservations WHERE client_order_id = $1');
    expect(state.sql).toContain("UPDATE client_orders SET status = 'POTENTIAL' WHERE id = $1");
    state.sql = []; state.refs = true;
    expect((await call('POST /api/potential-orders/from-order/:id', { id: '12' })).body.error).toBe("It already has an invoice: it can't be parked.");
  });
});

describe('winning', () => {
  it('becomes a draft invoice (nothing posted), or brings a parked sales order back with its reservations', async () => {
    state.potential = { id: 1, number: 'POT-2026-0001', client_id: 3, status: 'OPEN', currency: 'ZAR', notes: null, source_type: 'invoice', source_id: 7,
      lines: [{ partNumber: 'SOFT-001', description: 'Software', quantity: 1, unitPrice: 7000, taxRateId: 1, taxInclusive: false }] };
    let r = await call('POST /api/potential-orders/:id/won', { id: '1' }, { as: 'invoice' });
    expect(r.body).toMatchObject({ status: 'WON', outcomeDocType: 'invoice', outcomeDocNumber: 'INV-2026-0001' });
    expect(state.sql.find((s) => s.startsWith('INSERT INTO invoices'))).toContain("'DRAFT'");
    expect(reversed).toEqual([]);

    state.sql = [];
    Object.assign(state.potential, { status: 'OPEN', source_type: 'sales_order', source_id: 12 });
    state.parked = { id: 12, order_number: 'SO-2026-0003', status: 'POTENTIAL' };
    r = await call('POST /api/potential-orders/:id/won', { id: '1' }, { as: 'sales_order' });
    expect(r.body).toMatchObject({ outcomeDocType: 'sales_order', outcomeDocId: 12, outcomeDocNumber: 'SO-2026-0003' }); // the same order, same number
    expect(state.sql.find((s) => s.startsWith('UPDATE client_orders SET status'))).toBeTruthy();
    expect(reserved).toEqual([{ id: 12, lines: [{ partNumber: 'SOFT-001', quantity: 1 }] }]);

    expect((await call('POST /api/potential-orders/:id/won', { id: '1' }, { as: 'nonsense' })).statusCode).toBe(400);
  });
});
