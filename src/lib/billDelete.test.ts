// @vitest-environment node
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The real DELETE /api/bills/:id and GET /api/bills/:id/delete-impact
// handlers, registered on a real Express app, against a scripted stand-in
// for the database. Each test sets up the bill and what hangs off it
// (payments, bank matches, landed-cost batches, stock, ledger lines); every
// statement the handlers run is recorded so the tests can check what was
// and was not done, and in what order.

type Line = { account_id: number; debit: string; credit: string; description: string; entity_type: string | null; entity_id: number | null };

const db = vi.hoisted(() => ({
  bill: null as null | Record<string, unknown>,
  payments: [] as { id: number; payment_number: string; amount: string; journal_entry_id: number | null; other_bills: string[] | null }[],
  bankMatches: [] as { payment_id: number; statement_number: string }[],
  batches: [] as { batch_number: string; status: string }[],
  stock: [] as { part_number: string; quantity: string }[],
  journalLines: {} as Record<number, Line[]>,
  statements: [] as { text: string; params: unknown[] }[],
  released: 0,
  nextId: 100,
}));

vi.mock('./db', () => {
  const run = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    db.statements.push({ text: sql, params });
    const rows = (r: unknown[]) => ({ rows: r, rowCount: r.length });
    if (/^SELECT .* FROM bills WHERE id = \$1( FOR UPDATE)?$/.test(sql)) return rows(db.bill ? [db.bill] : []);
    if (/FROM payments_made p JOIN payment_made_allocations a/.test(sql)) return rows(db.payments);
    if (/FROM bank_statement_lines l JOIN bank_statements s/.test(sql)) {
      return rows(db.bankMatches.filter((m) => (params[0] as number[]).includes(m.payment_id)));
    }
    if (/^SELECT batch_number, status FROM landed_cost_batches/.test(sql)) return rows(db.batches);
    if (/FROM transactions WHERE reference = \$1/.test(sql)) return rows(db.stock);
    if (/^SELECT account_id, debit, credit, description, entity_type, entity_id FROM journal_lines WHERE journal_entry_id = \$1$/.test(sql)) {
      return rows(db.journalLines[params[0] as number] || []);
    }
    if (/^SELECT nextval\(\$1\) as n$/.test(sql)) return rows([{ n: db.nextId++ }]);
    if (/^INSERT INTO journal_entries/.test(sql)) return rows([{ id: db.nextId++ }]);
    return rows([]);
  };
  return {
    pool: { connect: async () => ({ query: run, release: () => { db.released += 1; } }) },
    query: run,
    queryOne: async (text: string, params: unknown[] = []) => (await run(text, params)).rows[0] ?? null,
    exec: async () => {},
  };
});

import { registerBookkeepingRoutes } from './bookkeeping-routes';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stand-in for attachSessionUser: the test names the caller's role.
  app.use('/api', (req: any, _res, next) => {
    const role = req.headers['x-test-role'];
    if (role) req.user = { id: 1, email: `${role}@example.com`, role: String(role) };
    next();
  });
  registerBookkeepingRoutes(app);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

beforeEach(() => {
  db.bill = null;
  db.payments = [];
  db.bankMatches = [];
  db.batches = [];
  db.stock = [];
  db.journalLines = {};
  db.statements = [];
  db.released = 0;
  db.nextId = 100;
});

// --- Fixtures: BILL-2026-0005 as it sits in the books ----------------------
// Posted as journal entry 19, paid in full by PMT-2026-0005 (journal entry 20).
const EXPENSE = 61, VAT = 22, AP = 20, BANK = 11;

const bill = (over: Record<string, unknown> = {}) => ({
  id: 5, bill_number: 'BILL-2026-0005', status: 'PAID', total: '3441.38', currency: 'ZAR',
  supplier_id: '6', purchase_order_id: 6, journal_entry_id: 19, has_receipt: true, ...over,
});
const payment = (over: Record<string, unknown> = {}) => ({
  id: 7, payment_number: 'PMT-2026-0005', amount: '3441.38', journal_entry_id: 20, other_bills: null as string[] | null, ...over,
});
const line = (account_id: number, debit: string, credit: string): Line =>
  ({ account_id, debit, credit, description: 'x', entity_type: null, entity_id: null });

function paidBill() {
  db.bill = bill();
  db.payments = [payment()];
  db.journalLines = {
    19: [line(EXPENSE, '2992.50', '0'), line(VAT, '448.88', '0'), line(AP, '0', '3441.38')],
    20: [line(AP, '3441.38', '0'), line(BANK, '0', '3441.38')],
  };
}

const call = async (method: 'DELETE' | 'GET', path: string, role?: string) => {
  const res = await fetch(`${base}${path}`, { method, headers: role ? { 'x-test-role': role } : {} });
  return { status: res.status, body: await res.json() };
};
const deleteBill = (role?: string) => call('DELETE', '/api/bills/5', role);
const impactOf = (role?: string) => call('GET', '/api/bills/5/delete-impact', role);

const ran = (pattern: RegExp) => db.statements.some((s) => pattern.test(s.text));
const at = (pattern: RegExp) => db.statements.findIndex((s) => pattern.test(s.text));
const writes = () => db.statements.filter((s) => /^(INSERT|UPDATE|DELETE)\b/.test(s.text));

// Journal entries the handler posted, each with its lines, in posting order.
// (An entry's lines are inserted straight after the entry itself.)
function posted() {
  const entries: { memo: unknown; sourceType: unknown; sourceId: unknown; lines: { accountId: unknown; debit: unknown; credit: unknown }[] }[] = [];
  for (const s of db.statements) {
    if (/^INSERT INTO journal_entries/.test(s.text)) {
      entries.push({ memo: s.params[2], sourceType: s.params[3], sourceId: s.params[4], lines: [] });
    }
    if (/^INSERT INTO journal_lines/.test(s.text)) {
      entries[entries.length - 1].lines.push({ accountId: s.params[1], debit: s.params[2], credit: s.params[3] });
    }
  }
  return entries;
}

describe('DELETE /api/bills/:id — a paid bill', () => {
  it('lets an admin delete it, voiding its payment and reversing its ledger entry', async () => {
    paidBill();

    const res = await deleteBill('admin');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ledgerReversed: true, voidedPayments: [{ paymentNumber: 'PMT-2026-0005', amount: 3441.38 }] });
    expect(posted()).toEqual([
      {
        memo: 'Void payment PMT-2026-0005 (bill BILL-2026-0005 deleted)', sourceType: 'REVERSAL', sourceId: 7,
        // Payment was DR Payables / CR Bank; the reversal is the mirror image.
        lines: [{ accountId: AP, debit: 0, credit: 3441.38 }, { accountId: BANK, debit: 3441.38, credit: 0 }],
      },
      {
        memo: 'Delete bill BILL-2026-0005', sourceType: 'REVERSAL', sourceId: 5,
        // Bill was DR Expense + DR VAT / CR Payables.
        lines: [
          { accountId: EXPENSE, debit: 0, credit: 2992.5 },
          { accountId: VAT, debit: 0, credit: 448.88 },
          { accountId: AP, debit: 3441.38, credit: 0 },
        ],
      },
    ]);
    expect(db.statements.find((s) => /^DELETE FROM payments_made WHERE id = \$1$/.test(s.text))!.params).toEqual([7]);
    expect(db.statements.find((s) => /^DELETE FROM bills WHERE id = \$1$/.test(s.text))!.params).toEqual([5]);
  });

  it('leaves the original ledger entries in place: it only ever adds reversals', async () => {
    paidBill();

    await deleteBill('admin');

    expect(ran(/^(DELETE FROM|UPDATE) journal_(entries|lines)/)).toBe(false);
  });

  it('removes the payment before the bill, and commits everything together', async () => {
    paidBill();

    await deleteBill('admin');

    // payment_made_allocations.bill_id references the bill, so the
    // allocation has to be gone before the bill can be.
    expect(at(/^DELETE FROM payment_made_allocations WHERE payment_id = \$1$/)).toBeGreaterThan(-1);
    expect(at(/^DELETE FROM payment_made_allocations/)).toBeLessThan(at(/^DELETE FROM payments_made/));
    expect(at(/^DELETE FROM payments_made/)).toBeLessThan(at(/^DELETE FROM bills/));
    expect(at(/^BEGIN$/)).toBe(0);
    expect(at(/^COMMIT$/)).toBe(db.statements.length - 1);
    expect(ran(/^ROLLBACK$/)).toBe(false);
    expect(db.released).toBe(1);
  });

  it('records who deleted what in the activity log, inside the same transaction', async () => {
    paidBill();
    db.stock = [{ part_number: 'XY-CC211-3P-I-1C', quantity: '30' }];

    await deleteBill('admin');

    const log = db.statements.find((s) => /^INSERT INTO user_activity_logs/.test(s.text))!;
    expect(log.text).toContain("'DELETE_BILL'");
    expect(log.params[0]).toBe('admin@example.com');
    expect(log.params[1]).toBe('BILL-2026-0005');
    expect(JSON.parse(String(log.params[2]))).toEqual({
      status: 'PAID', total: '3441.38', currency: 'ZAR', supplierId: '6', purchaseOrderId: 6,
      ledgerReversed: true,
      voidedPayments: [{ paymentNumber: 'PMT-2026-0005', amount: 3441.38 }],
      stockKept: [{ partNumber: 'XY-CC211-3P-I-1C', quantity: 30 }],
      hadReceipt: true,
    });
    expect(at(/^INSERT INTO user_activity_logs/)).toBeLessThan(at(/^COMMIT$/));
  });

  it('does not take stock back out', async () => {
    paidBill();
    db.stock = [{ part_number: 'XY-CC211-3P-I-1C', quantity: '30' }];

    await deleteBill('admin');

    expect(ran(/^UPDATE inventory/)).toBe(false);
    expect(ran(/^INSERT INTO transactions/)).toBe(false);
  });

  it('voids every payment recorded against it when it was paid in parts', async () => {
    db.bill = bill();
    db.payments = [
      payment({ id: 7, payment_number: 'PMT-2026-0005', amount: '3000.00', journal_entry_id: 20 }),
      payment({ id: 8, payment_number: 'PMT-2026-0006', amount: '441.38', journal_entry_id: 21 }),
    ];
    db.journalLines = {
      19: [line(EXPENSE, '2992.50', '0'), line(VAT, '448.88', '0'), line(AP, '0', '3441.38')],
      20: [line(AP, '3000.00', '0'), line(BANK, '0', '3000.00')],
      21: [line(AP, '441.38', '0'), line(BANK, '0', '441.38')],
    };

    const res = await deleteBill('admin');

    expect(res.body.voidedPayments).toEqual([
      { paymentNumber: 'PMT-2026-0005', amount: 3000 },
      { paymentNumber: 'PMT-2026-0006', amount: 441.38 },
    ]);
    expect(posted().map((e) => e.memo)).toEqual([
      'Void payment PMT-2026-0005 (bill BILL-2026-0005 deleted)',
      'Void payment PMT-2026-0006 (bill BILL-2026-0005 deleted)',
      'Delete bill BILL-2026-0005',
    ]);
    expect(db.statements.filter((s) => /^DELETE FROM payments_made/.test(s.text)).map((s) => s.params)).toEqual([[7], [8]]);
  });

  it('rolls everything back if a reversal cannot be posted', async () => {
    paidBill();
    delete db.journalLines[19]; // the bill's entry has no lines to reverse

    const res = await deleteBill('admin');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Cannot reverse: original journal entry has no lines.');
    expect(ran(/^DELETE FROM bills/)).toBe(false);
    expect(ran(/^COMMIT$/)).toBe(false);
    expect(db.statements[db.statements.length - 1].text).toBe('ROLLBACK');
    expect(db.released).toBe(1);
  });
});

describe('DELETE /api/bills/:id — other statuses', () => {
  it('reverses the ledger entry of an unpaid posted bill', async () => {
    for (const status of ['AWAITING_PAYMENT', 'OVERDUE']) {
      db.statements = [];
      db.bill = bill({ status });
      db.journalLines = { 19: [line(EXPENSE, '2992.50', '0'), line(VAT, '448.88', '0'), line(AP, '0', '3441.38')] };

      const res = await deleteBill('admin');

      expect(res.status, status).toBe(200);
      expect(res.body, status).toEqual({ ok: true, ledgerReversed: true, voidedPayments: [] });
      expect(posted().map((e) => e.memo), status).toEqual(['Delete bill BILL-2026-0005']);
      expect(ran(/^DELETE FROM payments_made/), status).toBe(false);
      expect(ran(/^DELETE FROM bills/), status).toBe(true);
    }
  });

  it('does not reverse a void bill a second time', async () => {
    db.bill = bill({ id: 5, bill_number: 'BILL-2026-0002', status: 'VOID', journal_entry_id: 7, has_receipt: false });
    db.journalLines = { 7: [line(EXPENSE, '1138.28', '0'), line(VAT, '170.74', '0'), line(AP, '0', '1309.02')] };

    const res = await deleteBill('admin');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ledgerReversed: false, voidedPayments: [] });
    expect(posted()).toEqual([]);
    expect(ran(/^DELETE FROM bills/)).toBe(true);
    expect(ran(/^COMMIT$/)).toBe(true);
  });

  it('still lets a non-admin delete a draft, which never posted', async () => {
    db.bill = bill({ status: 'DRAFT', journal_entry_id: null });

    const res = await deleteBill('user');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ledgerReversed: false, voidedPayments: [] });
    expect(posted()).toEqual([]);
    expect(ran(/^DELETE FROM bills/)).toBe(true);
    expect(ran(/^COMMIT$/)).toBe(true);
  });

  it('refuses a non-admin on anything past draft, and changes nothing', async () => {
    for (const status of ['AWAITING_PAYMENT', 'PARTIAL', 'PAID', 'OVERDUE', 'VOID']) {
      db.statements = [];
      paidBill();
      db.bill = bill({ status });

      const res = await deleteBill('user');

      expect(res.status, status).toBe(403);
      expect(res.body, status).toEqual({ error: `Only an admin can delete a bill that is ${status}.` });
      expect(writes(), status).toEqual([]);
      expect(ran(/^ROLLBACK$/), status).toBe(true);
    }
  });

  it('treats a caller with no role the same as a non-admin', async () => {
    paidBill();

    const res = await deleteBill();

    expect(res.status).toBe(403);
    expect(writes()).toEqual([]);
  });

  it('answers 404 for a bill that does not exist', async () => {
    const res = await deleteBill('admin');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'bill not found' });
    expect(writes()).toEqual([]);
    expect(ran(/^ROLLBACK$/)).toBe(true);
    expect(db.released).toBe(1);
  });
});

describe('DELETE /api/bills/:id — when something else depends on the bill', () => {
  const refused = async (reason: string) => {
    const res = await deleteBill('admin');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: reason, blockers: [reason] });
    expect(writes()).toEqual([]);
    expect(ran(/^COMMIT$/)).toBe(false);
    expect(ran(/^ROLLBACK$/)).toBe(true);
    expect(db.released).toBe(1);
  };

  it('refuses when its payment also pays another bill', async () => {
    paidBill();
    db.payments = [payment({ other_bills: ['BILL-2026-0008'] })];

    await refused('Payment PMT-2026-0005 also pays BILL-2026-0008, so it cannot be removed along with this bill. Void that payment under Purchases > Payments Made first, then delete the bill.');
  });

  it('refuses when its payment is matched on a bank statement', async () => {
    paidBill();
    db.bankMatches = [{ payment_id: 7, statement_number: 'STMT-2026-0001' }];

    await refused('Payment PMT-2026-0005 is matched to a line on bank statement STMT-2026-0001. Unmatch it under Accounting > Bank Reconciliation first.');
  });

  it('refuses when a posted landed cost batch was built on it', async () => {
    paidBill();
    db.batches = [{ batch_number: 'LC-2026-0001', status: 'POSTED' }];

    await refused('This bill is part of landed cost batch LC-2026-0001, which is posted and has already repriced stock from it. A posted batch cannot be undone, so the bill has to stay.');
  });

  it('refuses while a draft landed cost batch still uses it', async () => {
    paidBill();
    db.batches = [{ batch_number: 'LC-2026-0002', status: 'DRAFT' }];

    await refused('This bill is part of landed cost batch LC-2026-0002. Delete that batch under Purchases > Landed Cost first.');
  });

  it('reports every reason at once', async () => {
    paidBill();
    db.payments = [payment({ other_bills: ['BILL-2026-0008', 'BILL-2026-0009'] })];
    db.batches = [{ batch_number: 'LC-2026-0002', status: 'DRAFT' }];

    const res = await deleteBill('admin');

    expect(res.status).toBe(409);
    expect(res.body.blockers).toHaveLength(2);
    expect(res.body.blockers[0]).toContain('also pays BILL-2026-0008, BILL-2026-0009');
    expect(res.body.error).toBe(res.body.blockers.join(' '));
  });
});

describe('GET /api/bills/:id/delete-impact', () => {
  it('says what deleting a paid bill would do, without doing any of it', async () => {
    paidBill();
    db.stock = [{ part_number: 'XY-CC211-3P-I-1C', quantity: '30' }];

    const res = await impactOf('admin');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      billNumber: 'BILL-2026-0005', status: 'PAID', currency: 'ZAR', hasReceipt: true,
      reverseLedger: true,
      payments: [{ paymentNumber: 'PMT-2026-0005', amount: 3441.38 }],
      stockKept: [{ partNumber: 'XY-CC211-3P-I-1C', quantity: 30 }],
      blockers: [],
    });
    expect(db.statements.every((s) => /^SELECT\b/.test(s.text))).toBe(true);
  });

  it('looks for booked-in stock by the reference the bill wrote', async () => {
    paidBill();

    await impactOf('admin');

    const lookup = db.statements.find((s) => /FROM transactions WHERE reference = \$1 AND type = 'BOOK-IN'/.test(s.text))!;
    expect(lookup.params).toEqual(['Bill BILL-2026-0005']);
  });

  it('says a void bill needs no reversal', async () => {
    db.bill = bill({ status: 'VOID', has_receipt: false });

    const res = await impactOf('admin');

    expect(res.body.reverseLedger).toBe(false);
    expect(res.body.hasReceipt).toBe(false);
    expect(res.body.payments).toEqual([]);
  });

  it('carries the same blockers the delete would refuse with', async () => {
    paidBill();
    db.payments = [payment({ other_bills: ['BILL-2026-0008'] })];

    const preview = await impactOf('admin');
    db.statements = [];
    const attempt = await deleteBill('admin');

    expect(preview.body.blockers).toHaveLength(1);
    expect(attempt.body.blockers).toEqual(preview.body.blockers);
  });

  it('answers 404 for a bill that does not exist', async () => {
    const res = await impactOf('admin');

    expect(res.status).toBe(404);
  });
});
