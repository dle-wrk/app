import type { Express } from 'express';
import { z } from 'zod';
import { pool, query, queryOne } from './db';
import {
  getAccountIdByCode,
  nextDocNumber,
  postJournalEntry,
  reverseJournalEntry,
  computeLineTotals,
  computeDocumentTotals,
  mapAccount,
  mapTaxRate,
  mapJournalEntry,
  mapJournalLine,
  mapInvoice,
  mapInvoiceItem,
  mapPaymentReceived,
  mapPaymentAllocation,
  mapPurchaseOrder,
  mapPurchaseOrderItem,
  mapBill,
  mapBillItem,
  mapPaymentMade,
  mapPaymentMadeAllocation,
  mapExpense,
  mapDispatchNote,
  mapDispatchNoteItem,
  SYSTEM_ACCOUNT_CODES,
  releaseReservation,
  rewriteReservations,
} from './bookkeeping-db';

const LineItemSchema = z.object({
  partNumber: z.string().optional(),
  description: z.string().min(1),
  quantity: z.preprocess((v) => v === '' || v === null || v === undefined ? v : Number(v), z.number().positive()),
  unitPrice: z.preprocess((v) => v === '' || v === null || v === undefined ? v : Number(v), z.number().min(0)),
  taxRateId: z.preprocess((v) => {
    if (v === null || v === undefined || v === '') return null;
    return Number(v);
  }, z.number().nullable().optional()),
  deductStock: z.preprocess((v) => {
    if (typeof v === 'string') return v === 'true' || v === 'on';
    return v;
  }, z.boolean().optional()),
  receiveStock: z.preprocess((v) => {
    if (typeof v === 'string') return v === 'true' || v === 'on';
    return v;
  }, z.boolean().optional()),
  accountId: z.preprocess((v) => {
    if (v === null || v === undefined || v === '') return null;
    return Number(v);
  }, z.number().nullable().optional()),
  taxInclusive: z.preprocess((v) => {
    if (typeof v === 'string') return v === 'true' || v === 'on';
    return v;
  }, z.boolean().optional()),
});

const InvoiceCreateSchema = z.object({
  clientId: z.preprocess((v) => {
    if (v === null || v === undefined || v === '') return null;
    return Number(v);
  }, z.number().nullable().optional()),
  clientOrderId: z.preprocess((v) => {
    if (v === null || v === undefined || v === '') return null;
    return Number(v);
  }, z.number().nullable().optional()),
  invoiceDate: z.string().optional(),
  dueDate: z.string().nullable().optional(),
  currency: z.string().optional(),
  notes: z.string().optional(),
  terms: z.string().optional(),
  discountTotal: z.preprocess((v) => v === '' || v === null || v === undefined ? v : Number(v), z.number().min(0).optional()),
  isWarrantyClaim: z.preprocess((v) => {
    if (typeof v === 'string') return v === 'true' || v === 'on';
    return v;
  }, z.boolean().optional()),
  status: z.enum(['DRAFT', 'SENT']).optional(),
  items: z.array(LineItemSchema).min(1),
});

const BillCreateSchema = z.object({
  supplierId: z.string().nullable().optional(),
  purchaseOrderId: z.number().nullable().optional(),
  billDate: z.string().optional(),
  dueDate: z.string().nullable().optional(),
  currency: z.string().optional(),
  notes: z.string().optional(),
  status: z.enum(['DRAFT', 'AWAITING_PAYMENT']).optional(),
  items: z.array(LineItemSchema).min(1),
});

const PurchaseOrderCreateSchema = z.object({
  supplierId: z.string().nullable().optional(),
  orderDate: z.string().optional(),
  expectedDate: z.string().nullable().optional(),
  currency: z.string().optional(),
  notes: z.string().optional(),
  status: z.enum(['DRAFT', 'SENT']).optional(),
  items: z.array(LineItemSchema).min(1),
});

const PaymentReceivedSchema = z.object({
  clientId: z.number().nullable().optional(),
  paymentDate: z.string().optional(),
  amount: z.number().positive(),
  method: z.string().optional(),
  depositAccountId: z.number(),
  reference: z.string().optional(),
  notes: z.string().optional(),
  allocations: z.array(z.object({ invoiceId: z.number(), amountApplied: z.number().positive() })).optional(),
});

const PaymentMadeSchema = z.object({
  supplierId: z.string().nullable().optional(),
  paymentDate: z.string().optional(),
  amount: z.number().positive(),
  method: z.string().optional(),
  paidFromAccountId: z.number(),
  reference: z.string().optional(),
  notes: z.string().optional(),
  allocations: z.array(z.object({ billId: z.number(), amountApplied: z.number().positive() })).optional(),
});

const ExpenseSchema = z.object({
  expenseDate: z.string().optional(),
  payee: z.string().optional(),
  supplierId: z.string().nullable().optional(),
  categoryAccountId: z.number(),
  paidFromAccountId: z.number(),
  amount: z.number().positive(),
  taxRateId: z.number().nullable().optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
});

const ManualJournalSchema = z.object({
  entryDate: z.string().optional(),
  memo: z.string().optional(),
  lines: z.array(z.object({
    accountId: z.number(),
    debit: z.number().min(0).optional(),
    credit: z.number().min(0).optional(),
    description: z.string().optional(),
  })).min(2),
});

const DispatchNoteItemSchema = z.object({
  partNumber: z.string().optional(),
  description: z.string().min(1),
  quantity: z.number().positive(),
  serialNumbers: z.string().optional(),
  deductStock: z.boolean().optional(),
});

const DispatchNoteCreateSchema = z.object({
  noteType: z.enum(['DELIVERY', 'COLLECTION']),
  clientId: z.number().nullable().optional(),
  clientOrderId: z.number().nullable().optional(),
  invoiceId: z.number().nullable().optional(),
  noteDate: z.string().optional(),
  scheduledDate: z.string().nullable().optional(),
  contactPerson: z.string().optional(),
  address: z.string().optional(),
  carrier: z.string().optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
  status: z.enum(['DRAFT', 'ISSUED']).optional(),
  items: z.array(DispatchNoteItemSchema).min(1),
});

async function resolveTaxPercent(taxRateId: number | null | undefined): Promise<number> {
  if (!taxRateId) return 0;
  const row = await queryOne<{ rate: string }>(`SELECT rate FROM tax_rates WHERE id = $1`, [taxRateId]);
  return row ? parseFloat(row.rate) || 0 : 0;
}

async function fetchInventoryItem(partNumber: string) {
  return queryOne<any>(`SELECT * FROM inventory WHERE serial_number = $1`, [partNumber]);
}

async function adjustStock(client: any, partNumber: string, delta: number, type: 'INBOUND' | 'OUTBOUND' | 'BOOK-IN' | 'BOOK-OUT', reference: string, newCost?: number) {
  const item = await client.query(`SELECT name, stock FROM inventory WHERE serial_number = $1`, [partNumber]);
  if (!item.rows.length) return; // silently skip unknown part numbers (loose coupling, matches app convention)
  await client.query(`UPDATE inventory SET stock = stock + $1 WHERE serial_number = $2`, [delta, partNumber]);
  const trxId = `TRX-BK-${partNumber}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  await client.query(
    `INSERT INTO transactions (trxId, itemPartNumber, itemName, type, qtyChange, reference, performedBy, dateTime, newCost)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [trxId, partNumber, item.rows[0].name || partNumber, type, delta, reference, 'System', new Date().toISOString(), newCost || null]
  );
}

export function registerBookkeepingRoutes(app: Express) {
  // ==========================================================================
  // BOOTSTRAP — one round trip for the whole module
  // ==========================================================================
  app.get('/api/bookkeeping/bootstrap', async (_req, res) => {
    try {
      await query(`UPDATE invoices SET status = 'OVERDUE' WHERE status IN ('SENT','PARTIAL') AND due_date < CURRENT_DATE AND balance_due > 0`).catch(() => {});
      await query(`UPDATE bills SET status = 'OVERDUE' WHERE status IN ('AWAITING_PAYMENT','PARTIAL') AND due_date < CURRENT_DATE AND balance_due > 0`).catch(() => {});

      const { rows: accounts } = await query(`SELECT * FROM accounts ORDER BY code`);
      const { rows: taxRates } = await query(`SELECT * FROM tax_rates ORDER BY id`);
      const { rows: invoices } = await query(`
        SELECT i.*, c.client_name FROM invoices i LEFT JOIN clients c ON c.id = i.client_id ORDER BY i.id DESC`);
      const { rows: paymentsReceived } = await query(`
        SELECT p.*, c.client_name FROM payments_received p LEFT JOIN clients c ON c.id = p.client_id ORDER BY p.id DESC`);
      const { rows: purchaseOrders } = await query(`
        SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id ORDER BY po.id DESC`);
      const { rows: bills } = await query(`
        SELECT b.*, s.name as supplier_name FROM bills b LEFT JOIN suppliers s ON s.id = b.supplier_id ORDER BY b.id DESC`);
      const { rows: paymentsMade } = await query(`
        SELECT p.*, s.name as supplier_name FROM payments_made p LEFT JOIN suppliers s ON s.id = p.supplier_id ORDER BY p.id DESC`);
      const { rows: expenses } = await query(`
        SELECT e.*, ca.name as category_account_name, pa.name as paid_from_account_name
        FROM expenses e
        LEFT JOIN accounts ca ON ca.id = e.category_account_id
        LEFT JOIN accounts pa ON pa.id = e.paid_from_account_id
        ORDER BY e.id DESC`);

      res.json({
        accounts: accounts.map(mapAccount),
        taxRates: taxRates.map(mapTaxRate),
        invoices: invoices.map(mapInvoice),
        paymentsReceived: paymentsReceived.map(mapPaymentReceived),
        purchaseOrders: purchaseOrders.map(mapPurchaseOrder),
        bills: bills.map(mapBill),
        paymentsMade: paymentsMade.map(mapPaymentMade),
        expenses: expenses.map(mapExpense),
      });
    } catch (err: any) {
      console.error('ERROR IN GET /api/bookkeeping/bootstrap:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // CHART OF ACCOUNTS
  // ==========================================================================
  app.get('/api/accounts', async (_req, res) => {
    try {
      const { rows } = await query(`SELECT * FROM accounts ORDER BY code`);
      res.json(rows.map(mapAccount));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/accounts', async (req, res) => {
    const { code, name, type, subtype, description } = req.body;
    if (!code || !name || !type) return res.status(400).json({ error: 'code, name and type are required' });
    if (!['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'].includes(type)) return res.status(400).json({ error: 'invalid account type' });
    const normalBalance = (type === 'ASSET' || type === 'EXPENSE') ? 'DEBIT' : 'CREDIT';
    try {
      const row = await queryOne(
        `INSERT INTO accounts (code, name, type, subtype, normal_balance, description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [code, name, type, subtype || null, normalBalance, description || null]
      );
      res.status(201).json(mapAccount(row));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/accounts/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { name, subtype, description, isActive } = req.body;
    try {
      const row = await queryOne(
        `UPDATE accounts SET name = COALESCE($1, name), subtype = COALESCE($2, subtype), description = COALESCE($3, description), is_active = COALESCE($4, is_active) WHERE id = $5 RETURNING *`,
        [name ?? null, subtype ?? null, description ?? null, isActive ?? null, id]
      );
      if (!row) return res.status(404).json({ error: 'account not found' });
      res.json(mapAccount(row));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/accounts/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const acct = await queryOne<any>(`SELECT is_system FROM accounts WHERE id = $1`, [id]);
      if (!acct) return res.status(404).json({ error: 'account not found' });
      if (acct.is_system) return res.status(400).json({ error: 'System accounts cannot be deleted. You can deactivate them instead.' });
      const used = await queryOne<any>(`SELECT id FROM journal_lines WHERE account_id = $1 LIMIT 1`, [id]);
      if (used) return res.status(400).json({ error: 'This account has posted transactions and cannot be deleted. Deactivate it instead.' });
      await query(`DELETE FROM accounts WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // TAX RATES
  // ==========================================================================
  app.get('/api/tax-rates', async (_req, res) => {
    try {
      const { rows } = await query(`SELECT * FROM tax_rates ORDER BY id`);
      res.json(rows.map(mapTaxRate));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/tax-rates', async (req, res) => {
    const { name, rate, isDefault } = req.body;
    if (!name || rate === undefined) return res.status(400).json({ error: 'name and rate are required' });
    try {
      if (isDefault) await query(`UPDATE tax_rates SET is_default = false`);
      const row = await queryOne(`INSERT INTO tax_rates (name, rate, is_default) VALUES ($1,$2,$3) RETURNING *`, [name, rate, !!isDefault]);
      res.status(201).json(mapTaxRate(row));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/tax-rates/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const { rowCount } = await query(`DELETE FROM tax_rates WHERE id = $1`, [id]);
      if (rowCount === 0) return res.status(404).json({ error: 'tax rate not found' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // INVOICES (Accounts Receivable)
  // ==========================================================================
  app.get('/api/invoices', async (_req, res) => {
    try {
      await query(`UPDATE invoices SET status = 'OVERDUE' WHERE status IN ('SENT','PARTIAL') AND due_date < CURRENT_DATE AND balance_due > 0`).catch(() => {});
      const { rows } = await query(`SELECT i.*, c.client_name FROM invoices i LEFT JOIN clients c ON c.id = i.client_id ORDER BY i.id DESC`);
      res.json(rows.map(mapInvoice));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/invoices/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const row = await queryOne(`SELECT i.*, c.client_name FROM invoices i LEFT JOIN clients c ON c.id = i.client_id WHERE i.id = $1`, [id]);
      if (!row) return res.status(404).json({ error: 'invoice not found' });
      const { rows: items } = await query(`SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [id]);
      res.json({ ...mapInvoice(row), items: items.map(mapInvoiceItem) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  async function finalizeInvoiceInTx(client: any, invoiceId: number, invoiceNumber: string, invoiceDate: string, total: number, subtotal: number, taxTotal: number, discountTotal: number, items: any[]) {
    const arAccountId = await getAccountIdByCode(SYSTEM_ACCOUNT_CODES.AR);
    const salesAccountId = await getAccountIdByCode(SYSTEM_ACCOUNT_CODES.SALES);
    const vatAccountId = await getAccountIdByCode(SYSTEM_ACCOUNT_CODES.VAT);

    // Net sales = subtotal - discount.  Without this adjustment the credit side
    // (subtotal + taxTotal) would exceed the debit side (total = subtotal - discount
    // + taxTotal) whenever a discount is applied, and postJournalEntry would throw.
    const salesCredit = Math.round((subtotal - discountTotal) * 100) / 100;

    const lines = [{ accountId: arAccountId, debit: total, credit: 0, description: `Invoice ${invoiceNumber}` }];
    if (salesCredit > 0) lines.push({ accountId: salesAccountId, debit: 0, credit: salesCredit, description: `Invoice ${invoiceNumber}` });
    if (taxTotal > 0) lines.push({ accountId: vatAccountId, debit: 0, credit: taxTotal, description: `VAT on ${invoiceNumber}` });

    const journalEntryId = await postJournalEntry(client, {
      entryDate: invoiceDate,
      memo: `Sales invoice ${invoiceNumber}`,
      sourceType: 'INVOICE',
      sourceId: invoiceId,
      lines,
    });

    await client.query(`UPDATE invoices SET status = 'SENT', journal_entry_id = $1, balance_due = total, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [journalEntryId, invoiceId]);

    const invoiceRow = await queryOne<any>(`SELECT client_order_id FROM invoices WHERE id = $1`, [invoiceId]);
    const linkedOrderId = invoiceRow?.client_order_id as number | null;
    for (const item of items) {
      if (item.deduct_stock && item.part_number) {
        const qty = Number(item.quantity) || 0;
        await adjustStock(client, item.part_number, -qty, 'OUTBOUND', `Invoice ${invoiceNumber}`);
        if (linkedOrderId) {
          await releaseReservation(client, linkedOrderId, item.part_number, qty);
        }
      }
    }
    return journalEntryId;
  }

  // ---------------------------------------------------------------------------
  // Sales-order reservations
  // ---------------------------------------------------------------------------
  // Exposed so the UI can badge each SO line as fully reserved vs
  // backordered without re-computing on the client. Both endpoints are
  // safe to call at any time — the write-path recomputes from live stock
  // levels + other orders' reservations, so this is idempotent.

  // ---------------------------------------------------------------------------
  // Auto-fulfil macro: SO → Invoice (SENT) → Delivery Note (COMPLETED) in
  // one round-trip. Everything runs in a single transaction so a failure
  // half-way through leaves nothing behind — the SO retains its old
  // status and no partial invoice/delivery is created.
  //
  // Payload options (all optional booleans, default true except payment):
  //   createInvoice, sendInvoice, createDelivery, completeDelivery,
  //   recordPayment (+ paymentAmount, paymentMethod, depositAccountId)
  //
  // Book-out behaviour: the invoice line carries deduct_stock=true so
  // finalizeInvoiceInTx handles both the physical decrement and the
  // reservation release. The delivery note's lines then default to
  // deduct_stock=false so completing it doesn't double-decrement — it's
  // a paper record of the shipment, not a second stock movement.
  // ---------------------------------------------------------------------------
  // Runs the auto-fulfil sequence for ONE order inside a caller-owned
  // transaction — no BEGIN/COMMIT/ROLLBACK here. Returns the summary or
  // throws with a message the batch caller can attach to the failing row.
  // Both the single-SO endpoint and the batch endpoint wrap the same
  // logic so behaviour stays identical whether you fire one or fifty.
  async function runAutoFulfilInTx(
    client: any,
    id: number,
    opts: any,
  ): Promise<any> {
    const createInvoice = opts.createInvoice !== false;
    const sendInvoice = opts.sendInvoice !== false;
    const createDelivery = opts.createDelivery !== false;
    const completeDelivery = opts.completeDelivery !== false;
    const recordPayment = !!opts.recordPayment;

    const so = await queryOne<any>(`SELECT * FROM client_orders WHERE id = $1`, [id]);
    if (!so) throw new Error('sales order not found');
    if (so.status === 'CANCELLED' || so.status === 'FULFILLED') {
      throw new Error(`Cannot auto-fulfil a ${so.status} order.`);
    }
    const { rows: soItems } = await client.query(
      `SELECT part_number, description, quantity, unit_price FROM client_order_items WHERE client_order_id = $1 ORDER BY id`,
      [id]
    );
    if (soItems.length === 0) throw new Error('Sales order has no line items.');

    const summary: any = { orderId: id, orderNumber: so.order_number };

    // 1) Invoice ------------------------------------------------------------
    let invoiceId: number | null = null;
    let invoiceNumber: string | null = null;
    let invoiceTotal = 0;
    if (createInvoice) {
      const computedLines = soItems.map((it: any) => ({
        partNumber: it.part_number,
        description: it.description || it.part_number || '',
        quantity: Number(it.quantity) || 0,
        unitPrice: Number(it.unit_price) || 0,
        taxRateId: null,
        taxInclusive: false,
        deductStock: !!it.part_number,
        ...computeLineTotals({
          description: it.description || it.part_number || '',
          quantity: Number(it.quantity) || 0,
          unitPrice: Number(it.unit_price) || 0,
          taxRatePercent: 0,
          taxInclusive: false,
        }),
      }));
      const { subtotal, taxTotal, total } = computeDocumentTotals(computedLines, 0);
      invoiceTotal = total;
      invoiceNumber = await nextDocNumber(client, 'INV', 'invoice_seq');
      const invoiceDate = new Date().toISOString().slice(0, 10);
      const invRes = await client.query(
        `INSERT INTO invoices (invoice_number, client_id, client_order_id, invoice_date, due_date, status, currency, subtotal, tax_total, discount_total, total, balance_due, notes, terms, is_warranty_claim)
         VALUES ($1,$2,$3,$4,$5,'DRAFT',$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [invoiceNumber, so.client_id, id, invoiceDate, null, so.currency || 'ZAR', subtotal, taxTotal, 0, total, total, `Auto-fulfilment of ${so.order_number}`, null, false]
      );
      invoiceId = invRes.rows[0].id;
      const insertedItems: any[] = [];
      for (const line of computedLines) {
        const r = await client.query(
          `INSERT INTO invoice_items (invoice_id, part_number, description, quantity, unit_price, tax_rate_id, tax_amount, line_total, deduct_stock, tax_inclusive)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [invoiceId, line.partNumber || null, line.description, line.quantity, line.unitPrice, null, line.taxAmount, line.lineTotal, !!line.deductStock, false]
        );
        insertedItems.push(r.rows[0]);
      }
      if (sendInvoice) {
        await finalizeInvoiceInTx(client, invoiceId!, invoiceNumber, invoiceDate, total, subtotal, taxTotal, 0, insertedItems);
      }
      summary.invoiceId = invoiceId;
      summary.invoiceNumber = invoiceNumber;
    }

    // 2) Delivery note ------------------------------------------------------
    if (createDelivery) {
      const noteNumber = await nextDocNumber(client, 'DN', 'dispatch_delivery_seq');
      const noteDate = new Date().toISOString().slice(0, 10);
      const noteRes = await client.query(
        `INSERT INTO dispatch_notes (note_number, note_type, client_id, client_order_id, invoice_id, note_date, scheduled_date, status, contact_person, address, carrier, reference, notes)
         VALUES ($1,'DELIVERY',$2,$3,$4,$5,NULL,'DRAFT',NULL,NULL,NULL,NULL,$6) RETURNING id`,
        [noteNumber, so.client_id, id, invoiceId, noteDate, `Auto-fulfilment of ${so.order_number}`]
      );
      const noteId = noteRes.rows[0].id;
      for (const it of soItems) {
        const shouldDeduct = !(sendInvoice && createInvoice) && !!it.part_number;
        await client.query(
          `INSERT INTO dispatch_note_items (dispatch_note_id, part_number, description, quantity, serial_numbers, deduct_stock)
           VALUES ($1,$2,$3,$4,NULL,$5)`,
          [noteId, it.part_number || null, it.description || it.part_number || '', Number(it.quantity) || 0, shouldDeduct]
        );
      }
      await client.query(`UPDATE dispatch_notes SET status = 'ISSUED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [noteId]);
      if (completeDelivery) {
        await client.query(`UPDATE dispatch_notes SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [noteId]);
        const { rows: dnItemRows } = await client.query(`SELECT part_number, quantity, deduct_stock FROM dispatch_note_items WHERE dispatch_note_id = $1`, [noteId]);
        for (const dn of dnItemRows) {
          if (dn.deduct_stock && dn.part_number) {
            const qty = Number(dn.quantity) || 0;
            await adjustStock(client, dn.part_number, -qty, 'OUTBOUND', `Dispatch ${noteNumber}`);
            await releaseReservation(client, id, dn.part_number, qty);
          }
        }
      }
      summary.dispatchNoteId = noteId;
      summary.dispatchNoteNumber = noteNumber;
    }

    // 3) Payment ------------------------------------------------------------
    if (recordPayment && invoiceId && sendInvoice) {
      const amt = Number(opts.paymentAmount) || invoiceTotal;
      const method = opts.paymentMethod || 'EFT';
      const depositAccountId = opts.depositAccountId;
      if (!depositAccountId) {
        throw new Error('depositAccountId is required when recordPayment is true.');
      }
      const paymentDate = new Date().toISOString().slice(0, 10);
      const paymentNumber = await nextDocNumber(client, 'RCPT', 'payment_in_seq');
      const payRes = await client.query(
        `INSERT INTO payments_received (payment_number, client_id, payment_date, amount, unallocated_amount, method, deposit_account_id, reference, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [paymentNumber, so.client_id, paymentDate, amt, 0, method, depositAccountId, `Auto-fulfilment of ${so.order_number}`, null]
      );
      const paymentId = payRes.rows[0].id;
      await client.query(`INSERT INTO payment_receipt_allocations (payment_id, invoice_id, amount_applied) VALUES ($1,$2,$3)`, [paymentId, invoiceId, amt]);
      await client.query(
        `UPDATE invoices SET amount_paid = amount_paid + $1, balance_due = balance_due - $1, status = CASE WHEN balance_due - $1 <= 0.005 THEN 'PAID' ELSE 'PARTIAL' END, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [amt, invoiceId]
      );
      const arAccountId = await getAccountIdByCode(SYSTEM_ACCOUNT_CODES.AR);
      const journalEntryId = await postJournalEntry(client, {
        entryDate: paymentDate,
        memo: `Payment received ${paymentNumber}`,
        sourceType: 'PAYMENT_RECEIVED',
        sourceId: paymentId,
        lines: [
          { accountId: depositAccountId, debit: amt, credit: 0, description: paymentNumber, entityType: 'CUSTOMER', entityId: so.client_id || undefined },
          { accountId: arAccountId, debit: 0, credit: amt, description: paymentNumber, entityType: 'CUSTOMER', entityId: so.client_id || undefined },
        ],
      });
      await client.query(`UPDATE payments_received SET journal_entry_id = $1 WHERE id = $2`, [journalEntryId, paymentId]);
      summary.paymentId = paymentId;
      summary.paymentNumber = paymentNumber;
    }

    // 4) SO status ----------------------------------------------------------
    if (createDelivery && completeDelivery) {
      await client.query(`UPDATE client_orders SET status = 'FULFILLED' WHERE id = $1`, [id]);
      summary.orderStatus = 'FULFILLED';
    } else if (createInvoice && so.status === 'DRAFT') {
      await client.query(`UPDATE client_orders SET status = 'APPROVED' WHERE id = $1`, [id]);
      summary.orderStatus = 'APPROVED';
    }

    return summary;
  }

  app.post('/api/client-orders/:id/auto-fulfil', async (req, res) => {
    const id = parseInt(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const summary = await runAutoFulfilInTx(client, id, req.body || {});
      await client.query('COMMIT');
      res.status(201).json(summary);
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(400).json({ error: err.message || String(err) });
    } finally {
      client.release();
    }
  });

  // Batch auto-fulfil: run the macro over N sales orders. Each order gets
  // its OWN transaction so a broken row (missing lines, wrong status)
  // reports back as { ok: false, error } without dragging the rest down
  // with it. Response is a parallel array — same length as orderIds,
  // same order — with either a summary or an error message per slot.
  app.post('/api/client-orders/auto-fulfil-batch', async (req, res) => {
    const raw = req.body || {};
    const orderIds: number[] = Array.isArray(raw.orderIds)
      ? raw.orderIds.map((n: any) => Number(n)).filter(Number.isFinite)
      : [];
    if (orderIds.length === 0) return res.status(400).json({ error: 'orderIds is required and must be a non-empty array.' });
    if (orderIds.length > 100) return res.status(400).json({ error: 'A batch cannot exceed 100 orders. Split into smaller batches.' });
    const opts = raw.options || {};

    const results: any[] = [];
    for (const id of orderIds) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const summary = await runAutoFulfilInTx(client, id, opts);
        await client.query('COMMIT');
        results.push({ orderId: id, ok: true, ...summary });
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        results.push({ orderId: id, ok: false, error: err.message || String(err) });
      } finally {
        client.release();
      }
    }
    const okCount = results.filter(r => r.ok).length;
    res.status(201).json({
      total: results.length,
      succeeded: okCount,
      failed: results.length - okCount,
      results,
    });
  });

  // Aggregate view used by the SO list to badge each row: totals per
  // client_order_id. Small even for a busy account so the SO list can
  // fetch it in one call rather than one round-trip per row.
  app.get('/api/client-order-reservations/summary', async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT client_order_id,
                COALESCE(SUM(reserved_qty), 0)::text AS reserved,
                COALESCE(SUM(backorder_qty), 0)::text AS backorder
         FROM client_order_reservations
         GROUP BY client_order_id`
      );
      res.json(rows.map(r => ({
        clientOrderId: r.client_order_id,
        reservedQty: Number(r.reserved) || 0,
        backorderQty: Number(r.backorder) || 0,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-part aggregate for the Inventory grid + Item Detail + BOM audit.
  // We only count reservations against OPEN sales orders — a stuck row
  // left behind by a bug against a FULFILLED / CANCELLED order would
  // otherwise falsely reduce the "available" figure on every screen
  // that quotes it. Empty totals are dropped by HAVING so the response
  // stays as small as possible.
  app.get('/api/inventory/reservations/summary', async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT r.part_number,
                COALESCE(SUM(r.reserved_qty), 0)::text AS reserved
         FROM client_order_reservations r
         JOIN client_orders o ON o.id = r.client_order_id
         WHERE o.status NOT IN ('FULFILLED', 'CANCELLED')
         GROUP BY r.part_number
         HAVING COALESCE(SUM(r.reserved_qty), 0) > 0`
      );
      res.json(rows.map(r => ({
        partNumber: r.part_number,
        reservedQty: Number(r.reserved) || 0,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/client-orders/:id/reservations', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const { rows } = await query(
        `SELECT part_number, reserved_qty, backorder_qty
         FROM client_order_reservations
         WHERE client_order_id = $1
         ORDER BY id`,
        [id]
      );
      res.json(rows.map(r => ({
        partNumber: r.part_number,
        reservedQty: Number(r.reserved_qty) || 0,
        backorderQty: Number(r.backorder_qty) || 0,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/client-orders/:id/reservations/refresh', async (req, res) => {
    const id = parseInt(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: lineRows } = await client.query(
        `SELECT part_number, quantity FROM client_order_items WHERE client_order_id = $1`,
        [id]
      );
      const lines = lineRows.map(r => ({ partNumber: r.part_number, quantity: Number(r.quantity) || 0 }));
      await rewriteReservations(client, id, lines);
      await client.query('COMMIT');
      const { rows } = await query(
        `SELECT part_number, reserved_qty, backorder_qty
         FROM client_order_reservations
         WHERE client_order_id = $1 ORDER BY id`,
        [id]
      );
      res.json(rows.map(r => ({
        partNumber: r.part_number,
        reservedQty: Number(r.reserved_qty) || 0,
        backorderQty: Number(r.backorder_qty) || 0,
      })));
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/invoices', async (req, res) => {
    const parsed = InvoiceCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid invoice payload', details: parsed.error.flatten() });
    const body = parsed.data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const computedLines = await Promise.all(body.items.map(async (item) => {
        const taxPct = await resolveTaxPercent(item.taxRateId);
        return { ...item, ...computeLineTotals({ ...item, taxRatePercent: taxPct, taxInclusive: !!item.taxInclusive }), taxPct };
      }));
      const { subtotal, taxTotal, total } = computeDocumentTotals(computedLines, body.discountTotal || 0);

      const invoiceNumber = await nextDocNumber(client, 'INV', 'invoice_seq');
      const invoiceDate = body.invoiceDate || new Date().toISOString().slice(0, 10);
      const status = body.status || 'DRAFT';

      const invRes = await client.query(
        `INSERT INTO invoices (invoice_number, client_id, client_order_id, invoice_date, due_date, status, currency, subtotal, tax_total, discount_total, total, balance_due, notes, terms, is_warranty_claim)
         VALUES ($1,$2,$3,$4,$5,'DRAFT',$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [invoiceNumber, body.clientId || null, body.clientOrderId || null, invoiceDate, body.dueDate || null, body.currency || 'ZAR', subtotal, taxTotal, body.discountTotal || 0, total, total, body.notes || null, body.terms || null, body.isWarrantyClaim ?? false]
      );
      const invoiceId = invRes.rows[0].id;

      const insertedItems: any[] = [];
      for (const line of computedLines) {
        const itemRes = await client.query(
          `INSERT INTO invoice_items (invoice_id, part_number, description, quantity, unit_price, tax_rate_id, tax_amount, line_total, deduct_stock, tax_inclusive)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [invoiceId, line.partNumber || null, line.description, line.quantity, line.unitPrice, line.taxRateId || null, line.taxAmount, line.lineTotal, !!line.deductStock, !!line.taxInclusive]
        );
        insertedItems.push(itemRes.rows[0]);
      }

      if (status === 'SENT') {
        await finalizeInvoiceInTx(client, invoiceId, invoiceNumber, invoiceDate, total, subtotal, taxTotal, body.discountTotal || 0, insertedItems);
      }

      await client.query('COMMIT');
      const finalRow = await queryOne(`SELECT i.*, c.client_name FROM invoices i LEFT JOIN clients c ON c.id = i.client_id WHERE i.id = $1`, [invoiceId]);
      res.status(201).json({ ...mapInvoice(finalRow), items: insertedItems.map(mapInvoiceItem) });
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  app.put('/api/invoices/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const parsed = InvoiceCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid invoice payload', details: parsed.error.flatten() });
    const body = parsed.data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Editing rules (broadened from the original DRAFT-only stance):
      //   - DRAFT: unchanged flow, no ledger to worry about.
      //   - SENT / OVERDUE with zero payments: allow. We reverse the
      //     previously-posted journal entry so the ledger nets to nothing
      //     from the original finalise, then re-run the standard finalise
      //     path at the end which posts a fresh journal + restores the
      //     SENT status. Same reasoning as void's payment check applies:
      //     if money has already been collected against this row the
      //     allocations reference amounts that would silently shift, so
      //     the operator must void the payment(s) first.
      //   - PARTIAL / PAID / VOID: refuse. PARTIAL/PAID always have
      //     payments; VOID has already been reversed.
      const existing = await client.query(`SELECT status, journal_entry_id, invoice_number, amount_paid FROM invoices WHERE id = $1`, [id]);
      if (!existing.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'invoice not found' }); }
      const priorStatus = existing.rows[0].status as string;
      const priorJournal = existing.rows[0].journal_entry_id as number | null;
      const priorInvoiceNumber = existing.rows[0].invoice_number as string;
      const priorAmountPaid = parseFloat(existing.rows[0].amount_paid) || 0;
      const EDITABLE_STATUSES = new Set(['DRAFT', 'SENT', 'OVERDUE']);
      if (!EDITABLE_STATUSES.has(priorStatus)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Cannot edit an invoice with status ${priorStatus}. Void payments and start again if you need to revise.` });
      }
      if (priorStatus !== 'DRAFT' && priorAmountPaid > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cannot edit an invoice with payments applied. Void the payment(s) first.' });
      }
      // Reverse the prior journal entry BEFORE we mutate the row. If
      // the caller is downgrading a SENT invoice back to DRAFT, we still
      // want the ledger unwound; the DRAFT save path won't re-post a
      // journal entry, so this is the right (and only) place to do it.
      if (priorStatus !== 'DRAFT' && priorJournal) {
        await reverseJournalEntry(client, priorJournal, { sourceType: 'REVERSAL', sourceId: id, memo: `Revise invoice ${priorInvoiceNumber}` });
        // Clear the pointer so the follow-up finalise (if the caller
        // asked for status SENT) inserts a fresh one rather than
        // overwriting the field non-atomically.
        await client.query(`UPDATE invoices SET journal_entry_id = NULL WHERE id = $1`, [id]);
      }

      const computedLines = await Promise.all(body.items.map(async (item) => {
        const taxPct = await resolveTaxPercent(item.taxRateId);
        return { ...item, ...computeLineTotals({ ...item, taxRatePercent: taxPct, taxInclusive: !!item.taxInclusive }) };
      }));
      const { subtotal, taxTotal, total } = computeDocumentTotals(computedLines, body.discountTotal || 0);

      // Resolve the status the row should carry after this update. If the
      // caller says SENT, finalizeInvoiceInTx below overwrites this to
      // SENT anyway; but if they save the edit as DRAFT (the "reopen and
      // fix" flow) we need to explicitly demote the row here — otherwise
      // it stays SENT/OVERDUE with a reversed journal, which is worse
      // than the state we started in.
      const nextStatus = body.status === 'DRAFT' ? 'DRAFT' : priorStatus === 'DRAFT' ? 'DRAFT' : priorStatus;
      await client.query(
        `UPDATE invoices SET client_id=$1, client_order_id=$2, invoice_date=$3, due_date=$4, currency=$5, subtotal=$6, tax_total=$7, discount_total=$8, total=$9, balance_due=$10, notes=$11, terms=$12, is_warranty_claim=$13, status=$14, updated_at=CURRENT_TIMESTAMP WHERE id=$15`,
        [body.clientId || null, body.clientOrderId || null, body.invoiceDate || new Date().toISOString().slice(0, 10), body.dueDate || null, body.currency || 'ZAR', subtotal, taxTotal, body.discountTotal || 0, total, total, body.notes || null, body.terms || null, body.isWarrantyClaim ?? false, nextStatus, id]
      );
      await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
      const insertedItems: any[] = [];
      for (const line of computedLines) {
        const itemRes = await client.query(
          `INSERT INTO invoice_items (invoice_id, part_number, description, quantity, unit_price, tax_rate_id, tax_amount, line_total, deduct_stock, tax_inclusive)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [id, line.partNumber || null, line.description, line.quantity, line.unitPrice, line.taxRateId || null, line.taxAmount, line.lineTotal, !!line.deductStock, !!line.taxInclusive]
        );
        insertedItems.push(itemRes.rows[0]);
      }

      if (body.status === 'SENT') {
        const invoiceDate = body.invoiceDate || new Date().toISOString().slice(0, 10);
        const invNumRow = await client.query(`SELECT invoice_number FROM invoices WHERE id = $1`, [id]);
        await finalizeInvoiceInTx(client, id, invNumRow.rows[0].invoice_number, invoiceDate, total, subtotal, taxTotal, body.discountTotal || 0, insertedItems);
      }

      await client.query('COMMIT');
      const finalRow = await queryOne(`SELECT i.*, c.client_name FROM invoices i LEFT JOIN clients c ON c.id = i.client_id WHERE i.id = $1`, [id]);
      res.json({ ...mapInvoice(finalRow), items: insertedItems.map(mapInvoiceItem) });
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/invoices/:id/finalize', async (req, res) => {
    const id = parseInt(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inv = await client.query(`SELECT * FROM invoices WHERE id = $1`, [id]);
      if (!inv.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'invoice not found' }); }
      const invoice = inv.rows[0];
      if (invoice.status !== 'DRAFT') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Only DRAFT invoices can be finalized.' }); }
      const items = (await client.query(`SELECT * FROM invoice_items WHERE invoice_id = $1`, [id])).rows;
      if (!items.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cannot finalize an invoice with no line items.' }); }

      await finalizeInvoiceInTx(client, id, invoice.invoice_number, invoice.invoice_date, parseFloat(invoice.total), parseFloat(invoice.subtotal), parseFloat(invoice.tax_total), parseFloat(invoice.discount_total) || 0, items);
      await client.query('COMMIT');
      const finalRow = await queryOne(`SELECT i.*, c.client_name FROM invoices i LEFT JOIN clients c ON c.id = i.client_id WHERE i.id = $1`, [id]);
      res.json(mapInvoice(finalRow));
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/invoices/:id/void', async (req, res) => {
    const id = parseInt(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inv = await client.query(`SELECT * FROM invoices WHERE id = $1`, [id]);
      if (!inv.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'invoice not found' }); }
      const invoice = inv.rows[0];
      if (invoice.status === 'VOID') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Invoice is already void.' }); }
      if (parseFloat(invoice.amount_paid) > 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cannot void an invoice with payments applied. Void the payment(s) first.' }); }

      if (invoice.journal_entry_id) {
        await reverseJournalEntry(client, invoice.journal_entry_id, { sourceType: 'REVERSAL', sourceId: id, memo: `Void invoice ${invoice.invoice_number}` });
      }
      await client.query(`UPDATE invoices SET status = 'VOID', balance_due = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  app.delete('/api/invoices/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const inv = await queryOne<any>(`SELECT status FROM invoices WHERE id = $1`, [id]);
      if (!inv) return res.status(404).json({ error: 'invoice not found' });
      if (inv.status !== 'DRAFT') return res.status(400).json({ error: 'Only DRAFT invoices can be deleted. Void it instead.' });
      await query(`DELETE FROM invoices WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // PAYMENTS RECEIVED
  // ==========================================================================
  app.get('/api/payments-received', async (_req, res) => {
    try {
      const { rows } = await query(`SELECT p.*, c.client_name FROM payments_received p LEFT JOIN clients c ON c.id = p.client_id ORDER BY p.id DESC`);
      res.json(rows.map(mapPaymentReceived));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/payments-received/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const row = await queryOne(`SELECT p.*, c.client_name FROM payments_received p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = $1`, [id]);
      if (!row) return res.status(404).json({ error: 'payment not found' });
      const { rows: allocations } = await query(`SELECT a.*, i.invoice_number FROM payment_receipt_allocations a LEFT JOIN invoices i ON i.id = a.invoice_id WHERE a.payment_id = $1`, [id]);
      res.json({ ...mapPaymentReceived(row), allocations: allocations.map(mapPaymentAllocation) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/payments-received', async (req, res) => {
    const parsed = PaymentReceivedSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payment payload', details: parsed.error.flatten() });
    const body = parsed.data;
    const allocations = body.allocations || [];
    const allocatedTotal = allocations.reduce((s, a) => s + a.amountApplied, 0);
    if (allocatedTotal - body.amount > 0.005) {
      return res.status(400).json({ error: 'Allocated amount cannot exceed the payment amount.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const alloc of allocations) {
        const invRow = await client.query(`SELECT balance_due, invoice_number, status FROM invoices WHERE id = $1 FOR UPDATE`, [alloc.invoiceId]);
        if (!invRow.rows.length) throw new Error(`Invoice ${alloc.invoiceId} not found.`);
        if (invRow.rows[0].status === 'VOID') throw new Error(`Invoice ${invRow.rows[0].invoice_number} is void and cannot receive payment.`);
        if (alloc.amountApplied - parseFloat(invRow.rows[0].balance_due) > 0.005) {
          throw new Error(`Amount applied to ${invRow.rows[0].invoice_number} exceeds its balance due.`);
        }
      }

      const paymentDate = body.paymentDate || new Date().toISOString().slice(0, 10);
      const paymentNumber = await nextDocNumber(client, 'RCPT', 'payment_in_seq');
      const unallocated = Math.round((body.amount - allocatedTotal) * 100) / 100;

      const payRes = await client.query(
        `INSERT INTO payments_received (payment_number, client_id, payment_date, amount, unallocated_amount, method, deposit_account_id, reference, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [paymentNumber, body.clientId || null, paymentDate, body.amount, unallocated, body.method || 'EFT', body.depositAccountId, body.reference || null, body.notes || null]
      );
      const paymentId = payRes.rows[0].id;

      for (const alloc of allocations) {
        await client.query(`INSERT INTO payment_receipt_allocations (payment_id, invoice_id, amount_applied) VALUES ($1,$2,$3)`, [paymentId, alloc.invoiceId, alloc.amountApplied]);
        const updated = await client.query(
          `UPDATE invoices SET amount_paid = amount_paid + $1, balance_due = balance_due - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING balance_due`,
          [alloc.amountApplied, alloc.invoiceId]
        );
        const newBalance = parseFloat(updated.rows[0].balance_due);
        const newStatus = newBalance <= 0.005 ? 'PAID' : 'PARTIAL';
        await client.query(`UPDATE invoices SET status = $1 WHERE id = $2`, [newStatus, alloc.invoiceId]);
      }

      const arAccountId = await getAccountIdByCode(SYSTEM_ACCOUNT_CODES.AR);
      const journalEntryId = await postJournalEntry(client, {
        entryDate: paymentDate,
        memo: `Payment received ${paymentNumber}`,
        sourceType: 'PAYMENT_RECEIVED',
        sourceId: paymentId,
        lines: [
          { accountId: body.depositAccountId, debit: body.amount, credit: 0, description: paymentNumber, entityType: 'CUSTOMER', entityId: body.clientId || undefined },
          { accountId: arAccountId, debit: 0, credit: body.amount, description: paymentNumber, entityType: 'CUSTOMER', entityId: body.clientId || undefined },
        ],
      });
      await client.query(`UPDATE payments_received SET journal_entry_id = $1 WHERE id = $2`, [journalEntryId, paymentId]);

      await client.query('COMMIT');
      const finalRow = await queryOne(`SELECT p.*, c.client_name FROM payments_received p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = $1`, [paymentId]);
      res.status(201).json(mapPaymentReceived(finalRow));
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/payments-received/:id/void', async (req, res) => {
    const id = parseInt(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pay = await client.query(`SELECT * FROM payments_received WHERE id = $1`, [id]);
      if (!pay.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'payment not found' }); }
      const payment = pay.rows[0];

      const allocations = (await client.query(`SELECT * FROM payment_receipt_allocations WHERE payment_id = $1`, [id])).rows;
      for (const alloc of allocations) {
        const updated = await client.query(
          `UPDATE invoices SET amount_paid = amount_paid - $1, balance_due = balance_due + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING balance_due, total`,
          [alloc.amount_applied, alloc.invoice_id]
        );
        if (updated.rows.length) {
          const balanceDue = parseFloat(updated.rows[0].balance_due);
          const total = parseFloat(updated.rows[0].total);
          const newStatus = balanceDue >= total - 0.005 ? 'SENT' : 'PARTIAL';
          await client.query(`UPDATE invoices SET status = $1 WHERE id = $2 AND status != 'VOID'`, [newStatus, alloc.invoice_id]);
        }
      }
      await client.query(`DELETE FROM payment_receipt_allocations WHERE payment_id = $1`, [id]);

      if (payment.journal_entry_id) {
        await reverseJournalEntry(client, payment.journal_entry_id, { sourceType: 'REVERSAL', sourceId: id, memo: `Void payment ${payment.payment_number}` });
      }
      await client.query(`DELETE FROM payments_received WHERE id = $1`, [id]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // ==========================================================================
  // PURCHASE ORDERS (no direct GL impact — they become Bills once received/billed)
  // ==========================================================================
  app.get('/api/purchase-orders', async (_req, res) => {
    try {
      const { rows } = await query(`SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id ORDER BY po.id DESC`);
      res.json(rows.map(mapPurchaseOrder));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/purchase-orders/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const row = await queryOne(`SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`, [id]);
      if (!row) return res.status(404).json({ error: 'purchase order not found' });
      const { rows: items } = await query(`SELECT * FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY id`, [id]);
      res.json({ ...mapPurchaseOrder(row), items: items.map(mapPurchaseOrderItem) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/purchase-orders', async (req, res) => {
    const parsed = PurchaseOrderCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid purchase order payload', details: parsed.error.flatten() });
    const body = parsed.data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const computedLines = await Promise.all(body.items.map(async (item) => {
        const taxPct = await resolveTaxPercent(item.taxRateId);
        return { ...item, ...computeLineTotals({ ...item, taxRatePercent: taxPct }) };
      }));
      const { subtotal, taxTotal, total } = computeDocumentTotals(computedLines);

      const poNumber = await nextDocNumber(client, 'PO', 'po_seq');
      const orderDate = body.orderDate || new Date().toISOString().slice(0, 10);

      const poRes = await client.query(
        `INSERT INTO purchase_orders (po_number, supplier_id, order_date, expected_date, status, currency, subtotal, tax_total, total, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [poNumber, body.supplierId || null, orderDate, body.expectedDate || null, body.status || 'DRAFT', body.currency || 'ZAR', subtotal, taxTotal, total, body.notes || null]
      );
      const poId = poRes.rows[0].id;

      const insertedItems: any[] = [];
      for (const line of computedLines) {
        const r = await client.query(
          `INSERT INTO purchase_order_items (purchase_order_id, part_number, description, quantity, unit_price, tax_rate_id, tax_amount, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [poId, line.partNumber || null, line.description, line.quantity, line.unitPrice, line.taxRateId || null, line.taxAmount, line.lineTotal]
        );
        insertedItems.push(r.rows[0]);
      }

      await client.query('COMMIT');
      const finalRow = await queryOne(`SELECT po.*, s.name as supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`, [poId]);
      res.status(201).json({ ...mapPurchaseOrder(finalRow), items: insertedItems.map(mapPurchaseOrderItem) });
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  app.put('/api/purchase-orders/:id/status', async (req, res) => {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    if (!['DRAFT', 'SENT', 'PARTIAL', 'RECEIVED', 'CANCELLED'].includes(status)) return res.status(400).json({ error: 'invalid status' });
    try {
      const row = await queryOne(`UPDATE purchase_orders SET status = $1 WHERE id = $2 RETURNING *`, [status, id]);
      if (!row) return res.status(404).json({ error: 'purchase order not found' });
      res.json(mapPurchaseOrder(row));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/purchase-orders/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      // Only DRAFTs can be deleted — a PO that's been SENT/RECEIVED has
      // downstream effects (stock adjustments, bills) that a hard delete
      // would silently corrupt. Client should void or cancel instead.
      const row = await queryOne<{ status: string }>(`SELECT status FROM purchase_orders WHERE id = $1`, [id]);
      if (!row) return res.status(404).json({ error: 'purchase order not found' });
      if (row.status !== 'DRAFT') {
        return res.status(400).json({ error: `Only DRAFT purchase orders can be deleted (this one is ${row.status})` });
      }
      await query(`DELETE FROM purchase_orders WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // BILLS (Accounts Payable)
  // ==========================================================================
  app.get('/api/bills', async (_req, res) => {
    try {
      await query(`UPDATE bills SET status = 'OVERDUE' WHERE status IN ('AWAITING_PAYMENT','PARTIAL') AND due_date < CURRENT_DATE AND balance_due > 0`).catch(() => {});
      const { rows } = await query(`SELECT b.*, s.name as supplier_name FROM bills b LEFT JOIN suppliers s ON s.id = b.supplier_id ORDER BY b.id DESC`);
      res.json(rows.map(mapBill));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/bills/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const row = await queryOne(`SELECT b.*, s.name as supplier_name FROM bills b LEFT JOIN suppliers s ON s.id = b.supplier_id WHERE b.id = $1`, [id]);
      if (!row) return res.status(404).json({ error: 'bill not found' });
      const { rows: items } = await query(`SELECT * FROM bill_items WHERE bill_id = $1 ORDER BY id`, [id]);
      res.json({ ...mapBill(row), items: items.map(mapBillItem) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  async function finalizeBillInTx(client: any, billId: number, billNumber: string, billDate: string, total: number, taxTotal: number, items: any[]) {
    const apAccountId = await getAccountIdByCode(SYSTEM_ACCOUNT_CODES.AP);
    const vatAccountId = await getAccountIdByCode(SYSTEM_ACCOUNT_CODES.VAT);
    const defaultExpenseId = await getAccountIdByCode(SYSTEM_ACCOUNT_CODES.DEFAULT_EXPENSE);

    const byAccount = new Map<number, number>();
    for (const item of items) {
      const accountId = item.account_id || defaultExpenseId;
      const base = Number(item.quantity) * Number(item.unit_price);
      byAccount.set(accountId, (byAccount.get(accountId) || 0) + Math.round(base * 100) / 100);
    }

    const lines: any[] = [];
    for (const [accountId, amount] of byAccount.entries()) {
      lines.push({ accountId, debit: amount, credit: 0, description: `Bill ${billNumber}` });
    }
    if (taxTotal > 0) lines.push({ accountId: vatAccountId, debit: taxTotal, credit: 0, description: `Input VAT on ${billNumber}` });
    lines.push({ accountId: apAccountId, debit: 0, credit: total, description: `Bill ${billNumber}` });

    const journalEntryId = await postJournalEntry(client, {
      entryDate: billDate,
      memo: `Vendor bill ${billNumber}`,
      sourceType: 'BILL',
      sourceId: billId,
      lines,
    });

    await client.query(`UPDATE bills SET status = 'AWAITING_PAYMENT', journal_entry_id = $1, balance_due = total, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [journalEntryId, billId]);

    for (const item of items) {
      if (item.receive_stock && item.part_number) {
        await adjustStock(client, item.part_number, Number(item.quantity), 'BOOK-IN', `Bill ${billNumber}`, Number(item.unit_price));
      }
    }
    return journalEntryId;
  }

  app.post('/api/bills', async (req, res) => {
    const parsed = BillCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid bill payload', details: parsed.error.flatten() });
    const body = parsed.data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const computedLines = await Promise.all(body.items.map(async (item) => {
        const taxPct = await resolveTaxPercent(item.taxRateId);
        return { ...item, ...computeLineTotals({ ...item, taxRatePercent: taxPct }) };
      }));
      const { subtotal, taxTotal, total } = computeDocumentTotals(computedLines);

      const billNumber = await nextDocNumber(client, 'BILL', 'bill_seq');
      const billDate = body.billDate || new Date().toISOString().slice(0, 10);

      const billRes = await client.query(
        `INSERT INTO bills (bill_number, supplier_id, purchase_order_id, bill_date, due_date, status, currency, subtotal, tax_total, total, balance_due, notes)
         VALUES ($1,$2,$3,$4,$5,'DRAFT',$6,$7,$8,$9,$10,$11) RETURNING id`,
        [billNumber, body.supplierId || null, body.purchaseOrderId || null, billDate, body.dueDate || null, body.currency || 'ZAR', subtotal, taxTotal, total, total, body.notes || null]
      );
      const billId = billRes.rows[0].id;

      const insertedItems: any[] = [];
      for (const line of computedLines) {
        const r = await client.query(
          `INSERT INTO bill_items (bill_id, part_number, description, quantity, unit_price, account_id, tax_rate_id, tax_amount, line_total, receive_stock)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [billId, line.partNumber || null, line.description, line.quantity, line.unitPrice, line.accountId || null, line.taxRateId || null, line.taxAmount, line.lineTotal, !!line.receiveStock]
        );
        insertedItems.push(r.rows[0]);
      }

      if (body.status === 'AWAITING_PAYMENT') {
        await finalizeBillInTx(client, billId, billNumber, billDate, total, taxTotal, insertedItems);
      }

      await client.query('COMMIT');
      const finalRow = await queryOne(`SELECT b.*, s.name as supplier_name FROM bills b LEFT JOIN suppliers s ON s.id = b.supplier_id WHERE b.id = $1`, [billId]);
      res.status(201).json({ ...mapBill(finalRow), items: insertedItems.map(mapBillItem) });
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/bills/:id/finalize', async (req, res) => {
    const id = parseInt(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const b = await client.query(`SELECT * FROM bills WHERE id = $1`, [id]);
      if (!b.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'bill not found' }); }
      const bill = b.rows[0];
      if (bill.status !== 'DRAFT') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Only DRAFT bills can be finalized.' }); }
      const items = (await client.query(`SELECT * FROM bill_items WHERE bill_id = $1`, [id])).rows;
      if (!items.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cannot finalize a bill with no line items.' }); }

      await finalizeBillInTx(client, id, bill.bill_number, bill.bill_date, parseFloat(bill.total), parseFloat(bill.tax_total), items);
      await client.query('COMMIT');
      const finalRow = await queryOne(`SELECT b.*, s.name as supplier_name FROM bills b LEFT JOIN suppliers s ON s.id = b.supplier_id WHERE b.id = $1`, [id]);
      res.json(mapBill(finalRow));
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/bills/:id/void', async (req, res) => {
    const id = parseInt(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const b = await client.query(`SELECT * FROM bills WHERE id = $1`, [id]);
      if (!b.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'bill not found' }); }
      const bill = b.rows[0];
      if (bill.status === 'VOID') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Bill is already void.' }); }
      if (parseFloat(bill.amount_paid) > 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cannot void a bill with payments applied. Void the payment(s) first.' }); }

      if (bill.journal_entry_id) {
        await reverseJournalEntry(client, bill.journal_entry_id, { sourceType: 'REVERSAL', sourceId: id, memo: `Void bill ${bill.bill_number}` });
      }
      await client.query(`UPDATE bills SET status = 'VOID', balance_due = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  app.delete('/api/bills/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const bill = await queryOne<any>(`SELECT status FROM bills WHERE id = $1`, [id]);
      if (!bill) return res.status(404).json({ error: 'bill not found' });
      if (bill.status !== 'DRAFT') return res.status(400).json({ error: 'Only DRAFT bills can be deleted. Void it instead.' });
      await query(`DELETE FROM bills WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Attach or replace the scanned till slip / vendor invoice image for a bill.
  // Expects a base64 data URL (data:image/…;base64,…) in body.image. The
  // client resizes on capture to keep payloads under ~2 MB.
  app.post('/api/bills/:id/receipt', async (req, res) => {
    const id = parseInt(req.params.id);
    // Multi-page: `images[]` is the modern shape; `image` is the
    // pre-multi-page single value kept for compat. Storage column is
    // TEXT — one page saves as a bare data URL (readable by every old
    // client and the /bills/:id/receipt-image renderer as-is), N pages
    // save as a JSON array so nothing else needs a schema change.
    const rawImages = Array.isArray(req.body?.images) ? req.body.images
      : typeof req.body?.image === 'string' ? [req.body.image]
      : [];
    const images: string[] = rawImages.filter((v: any) => typeof v === 'string' && v.startsWith('data:image/'));
    if (images.length === 0) return res.status(400).json({ error: 'Expected data:image/… URLs in body.images[]' });
    if (images.length > 8) return res.status(400).json({ error: 'Up to 8 pages per receipt.' });
    const totalBytes = images.reduce((s, v) => s + v.length, 0);
    if (totalBytes > 30_000_000) return res.status(413).json({ error: 'Combined image payload too large.' });
    const stored = images.length === 1 ? images[0] : JSON.stringify(images);
    try {
      const bill = await queryOne<any>(`SELECT id FROM bills WHERE id = $1`, [id]);
      if (!bill) return res.status(404).json({ error: 'bill not found' });
      await query(`UPDATE bills SET receipt_image = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [stored, id]);
      res.json({ ok: true, pages: images.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/bookkeeping/ocr/receipt — OpenAI Vision OCR for bill /
  // receipt images. Accepts one or more base64 data URLs (multi-page
  // bills are common — a supplier invoice + a payment slip, for
  // example). Returns the same OcrResult shape the client was already
  // consuming from local Tesseract:
  //   { text, supplier, date, total, currency, lineItems }
  // plus a new taxTotal field for the tax subtotal when the model
  // can find one.
  //
  // Model choice: gpt-4o. Cheap enough at ~$0.01/receipt, fast
  // (usually under 3s), and reliably outputs valid JSON in
  // response_format=json_object mode. If the key isn't set the
  // endpoint 501s cleanly so the client falls back to image-only.
  app.post('/api/bookkeeping/ocr/receipt', async (req, res) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(501).json({
        error: 'OpenAI Vision OCR is not configured on this server. Add OPENAI_API_KEY via flyctl secrets set.',
      });
    }
    const rawImages = Array.isArray(req.body?.images) ? req.body.images
      : req.body?.image ? [req.body.image]
      : [];
    const images: string[] = rawImages
      .filter((v: any) => typeof v === 'string' && v.startsWith('data:image/'));
    if (images.length === 0) {
      return res.status(400).json({ error: 'Provide one or more data:image/… URLs in body.images[]' });
    }
    if (images.length > 8) {
      return res.status(400).json({ error: 'Up to 8 images per receipt — split larger uploads.' });
    }
    const totalBytes = images.reduce((s, i) => s + i.length, 0);
    if (totalBytes > 25_000_000) {
      return res.status(413).json({ error: 'Combined image payload too large — please recompress or split.' });
    }

    // System prompt spells out the JSON schema exactly. Being strict
    // here means the client can trust the shape without runtime
    // validation of every field.
    const systemPrompt = `You extract structured data from receipt / invoice / bill photos.
Return JSON matching this shape exactly:
{
  "supplier": string | null,        // Trading name of the seller. Ignore addresses, VAT numbers, receipt headers.
  "date": string | null,            // ISO YYYY-MM-DD. Prefer the invoice date over the print date.
  "currency": string | null,        // "ZAR", "USD", "EUR", … — infer from symbols if not stated.
  "total": number | null,           // Grand total the customer owes.
  "taxTotal": number | null,        // VAT / GST amount if stated.
  "lineItems": [                    // Each purchased line. Skip subtotals, tax, delivery, discount summary rows.
    { "description": string, "quantity": number, "unitPrice": number, "lineTotal": number }
  ],
  "text": string                    // Concatenated readable text from every page in reading order.
}
If a field is unreadable, use null (or [] for lineItems). Never invent values.`;

    const userContent: any[] = [
      { type: 'text', text: `Extract the receipt data as JSON.` },
      ...images.map(url => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
    ];

    try {
      const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          response_format: { type: 'json_object' },
          temperature: 0,
          max_tokens: 2048,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
        }),
      });
      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        console.error('[ocr:receipt] OpenAI', upstream.status, errText.slice(0, 300));
        return res.status(502).json({ error: `Vision API rejected the request (${upstream.status}).` });
      }
      const data: any = await upstream.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) return res.status(502).json({ error: 'Vision API returned no content.' });
      let parsed: any = {};
      try { parsed = JSON.parse(content); }
      catch { return res.status(502).json({ error: 'Vision API returned unparseable JSON.' }); }

      // Coerce to the shape the client expects. Null defaults for
      // missing fields so the client can trust `?? null` semantics.
      const num = (v: any): number | null => {
        const n = typeof v === 'number' ? v : parseFloat(String(v || ''));
        return Number.isFinite(n) ? n : null;
      };
      const str = (v: any): string | null => {
        const s = typeof v === 'string' ? v.trim() : '';
        return s ? s : null;
      };
      const lineItems = Array.isArray(parsed.lineItems)
        ? parsed.lineItems.map((li: any) => ({
            description: str(li?.description) || '',
            quantity: num(li?.quantity) || 1,
            unitPrice: num(li?.unitPrice) || 0,
            lineTotal: num(li?.lineTotal) || 0,
          })).filter((li: any) => li.description || li.lineTotal > 0)
        : [];
      res.json({
        supplier: str(parsed.supplier),
        date: str(parsed.date),
        currency: str(parsed.currency),
        total: num(parsed.total),
        taxTotal: num(parsed.taxTotal),
        lineItems,
        text: str(parsed.text) || '',
      });
    } catch (err: any) {
      console.error('[ocr:receipt] failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/bills/:id/receipt', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      await query(`UPDATE bills SET receipt_image = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // PAYMENTS MADE
  // ==========================================================================
  app.get('/api/payments-made', async (_req, res) => {
    try {
      const { rows } = await query(`SELECT p.*, s.name as supplier_name FROM payments_made p LEFT JOIN suppliers s ON s.id = p.supplier_id ORDER BY p.id DESC`);
      res.json(rows.map(mapPaymentMade));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/payments-made/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const row = await queryOne(`SELECT p.*, s.name as supplier_name FROM payments_made p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = $1`, [id]);
      if (!row) return res.status(404).json({ error: 'payment not found' });
      const { rows: allocations } = await query(`SELECT a.*, b.bill_number FROM payment_made_allocations a LEFT JOIN bills b ON b.id = a.bill_id WHERE a.payment_id = $1`, [id]);
      res.json({ ...mapPaymentMade(row), allocations: allocations.map(mapPaymentMadeAllocation) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/payments-made', async (req, res) => {
    const parsed = PaymentMadeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payment payload', details: parsed.error.flatten() });
    const body = parsed.data;
    const allocations = body.allocations || [];
    const allocatedTotal = allocations.reduce((s, a) => s + a.amountApplied, 0);
    if (allocatedTotal - body.amount > 0.005) {
      return res.status(400).json({ error: 'Allocated amount cannot exceed the payment amount.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const alloc of allocations) {
        const billRow = await client.query(`SELECT balance_due, bill_number, status FROM bills WHERE id = $1 FOR UPDATE`, [alloc.billId]);
        if (!billRow.rows.length) throw new Error(`Bill ${alloc.billId} not found.`);
        if (billRow.rows[0].status === 'VOID') throw new Error(`Bill ${billRow.rows[0].bill_number} is void and cannot receive payment.`);
        if (alloc.amountApplied - parseFloat(billRow.rows[0].balance_due) > 0.005) {
          throw new Error(`Amount applied to ${billRow.rows[0].bill_number} exceeds its balance due.`);
        }
      }

      const paymentDate = body.paymentDate || new Date().toISOString().slice(0, 10);
      const paymentNumber = await nextDocNumber(client, 'PMT', 'payment_out_seq');
      const unallocated = Math.round((body.amount - allocatedTotal) * 100) / 100;

      const payRes = await client.query(
        `INSERT INTO payments_made (payment_number, supplier_id, payment_date, amount, unallocated_amount, method, paid_from_account_id, reference, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [paymentNumber, body.supplierId || null, paymentDate, body.amount, unallocated, body.method || 'EFT', body.paidFromAccountId, body.reference || null, body.notes || null]
      );
      const paymentId = payRes.rows[0].id;

      for (const alloc of allocations) {
        await client.query(`INSERT INTO payment_made_allocations (payment_id, bill_id, amount_applied) VALUES ($1,$2,$3)`, [paymentId, alloc.billId, alloc.amountApplied]);
        const updated = await client.query(
          `UPDATE bills SET amount_paid = amount_paid + $1, balance_due = balance_due - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING balance_due`,
          [alloc.amountApplied, alloc.billId]
        );
        const newBalance = parseFloat(updated.rows[0].balance_due);
        const newStatus = newBalance <= 0.005 ? 'PAID' : 'PARTIAL';
        await client.query(`UPDATE bills SET status = $1 WHERE id = $2`, [newStatus, alloc.billId]);
      }

      const apAccountId = await getAccountIdByCode(SYSTEM_ACCOUNT_CODES.AP);
      const journalEntryId = await postJournalEntry(client, {
        entryDate: paymentDate,
        memo: `Payment made ${paymentNumber}`,
        sourceType: 'PAYMENT_MADE',
        sourceId: paymentId,
        lines: [
          { accountId: apAccountId, debit: body.amount, credit: 0, description: paymentNumber, entityType: 'SUPPLIER' },
          { accountId: body.paidFromAccountId, debit: 0, credit: body.amount, description: paymentNumber, entityType: 'SUPPLIER' },
        ],
      });
      await client.query(`UPDATE payments_made SET journal_entry_id = $1 WHERE id = $2`, [journalEntryId, paymentId]);

      await client.query('COMMIT');
      const finalRow = await queryOne(`SELECT p.*, s.name as supplier_name FROM payments_made p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = $1`, [paymentId]);
      res.status(201).json(mapPaymentMade(finalRow));
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/payments-made/:id/void', async (req, res) => {
    const id = parseInt(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pay = await client.query(`SELECT * FROM payments_made WHERE id = $1`, [id]);
      if (!pay.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'payment not found' }); }
      const payment = pay.rows[0];

      const allocations = (await client.query(`SELECT * FROM payment_made_allocations WHERE payment_id = $1`, [id])).rows;
      for (const alloc of allocations) {
        const updated = await client.query(
          `UPDATE bills SET amount_paid = amount_paid - $1, balance_due = balance_due + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING balance_due, total`,
          [alloc.amount_applied, alloc.bill_id]
        );
        if (updated.rows.length) {
          const balanceDue = parseFloat(updated.rows[0].balance_due);
          const total = parseFloat(updated.rows[0].total);
          const newStatus = balanceDue >= total - 0.005 ? 'AWAITING_PAYMENT' : 'PARTIAL';
          await client.query(`UPDATE bills SET status = $1 WHERE id = $2 AND status != 'VOID'`, [newStatus, alloc.bill_id]);
        }
      }
      await client.query(`DELETE FROM payment_made_allocations WHERE payment_id = $1`, [id]);

      if (payment.journal_entry_id) {
        await reverseJournalEntry(client, payment.journal_entry_id, { sourceType: 'REVERSAL', sourceId: id, memo: `Void payment ${payment.payment_number}` });
      }
      await client.query(`DELETE FROM payments_made WHERE id = $1`, [id]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // ==========================================================================
  // EXPENSES (paid immediately, no AP)
  // ==========================================================================
  app.get('/api/expenses', async (_req, res) => {
    try {
      const { rows } = await query(`
        SELECT e.*, ca.name as category_account_name, pa.name as paid_from_account_name
        FROM expenses e
        LEFT JOIN accounts ca ON ca.id = e.category_account_id
        LEFT JOIN accounts pa ON pa.id = e.paid_from_account_id
        ORDER BY e.id DESC`);
      res.json(rows.map(mapExpense));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/expenses', async (req, res) => {
    const parsed = ExpenseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid expense payload', details: parsed.error.flatten() });
    const body = parsed.data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const taxPct = await resolveTaxPercent(body.taxRateId);
      const taxAmount = Math.round(body.amount * (taxPct / 100) * 100) / 100;
      const total = Math.round((body.amount + taxAmount) * 100) / 100;
      const expenseDate = body.expenseDate || new Date().toISOString().slice(0, 10);
      const expenseNumber = await nextDocNumber(client, 'EXP', 'expense_seq');

      const expRes = await client.query(
        `INSERT INTO expenses (expense_number, expense_date, payee, supplier_id, category_account_id, paid_from_account_id, amount, tax_rate_id, tax_amount, total, reference, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [expenseNumber, expenseDate, body.payee || null, body.supplierId || null, body.categoryAccountId, body.paidFromAccountId, body.amount, body.taxRateId || null, taxAmount, total, body.reference || null, body.notes || null]
      );
      const expenseId = expRes.rows[0].id;

      const vatAccountId = await getAccountIdByCode(SYSTEM_ACCOUNT_CODES.VAT);
      const lines = [{ accountId: body.categoryAccountId, debit: body.amount, credit: 0, description: expenseNumber }];
      if (taxAmount > 0) lines.push({ accountId: vatAccountId, debit: taxAmount, credit: 0, description: `Input VAT on ${expenseNumber}` });
      lines.push({ accountId: body.paidFromAccountId, debit: 0, credit: total, description: expenseNumber });

      const journalEntryId = await postJournalEntry(client, {
        entryDate: expenseDate,
        memo: `Expense ${expenseNumber}${body.payee ? ' — ' + body.payee : ''}`,
        sourceType: 'EXPENSE',
        sourceId: expenseId,
        lines,
      });
      await client.query(`UPDATE expenses SET journal_entry_id = $1 WHERE id = $2`, [journalEntryId, expenseId]);

      await client.query('COMMIT');
      const finalRow = await queryOne(`
        SELECT e.*, ca.name as category_account_name, pa.name as paid_from_account_name
        FROM expenses e LEFT JOIN accounts ca ON ca.id = e.category_account_id LEFT JOIN accounts pa ON pa.id = e.paid_from_account_id
        WHERE e.id = $1`, [expenseId]);
      res.status(201).json(mapExpense(finalRow));
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/expenses/:id/void', async (req, res) => {
    const id = parseInt(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const exp = await client.query(`SELECT * FROM expenses WHERE id = $1`, [id]);
      if (!exp.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'expense not found' }); }
      const expense = exp.rows[0];
      if (expense.status === 'VOID') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Expense is already void.' }); }

      if (expense.journal_entry_id) {
        await reverseJournalEntry(client, expense.journal_entry_id, { sourceType: 'REVERSAL', sourceId: id, memo: `Void expense ${expense.expense_number}` });
      }
      await client.query(`UPDATE expenses SET status = 'VOID' WHERE id = $1`, [id]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // ==========================================================================
  // JOURNAL / GENERAL LEDGER
  // ==========================================================================
  app.get('/api/journal-entries', async (req, res) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit || '200'), 10) || 200, 1000);
      const { rows } = await query(`
        SELECT je.*, COALESCE(SUM(jl.debit),0) as total_debit, COALESCE(SUM(jl.credit),0) as total_credit
        FROM journal_entries je
        LEFT JOIN journal_lines jl ON jl.journal_entry_id = je.id
        GROUP BY je.id ORDER BY je.id DESC LIMIT $1`, [limit]);
      res.json(rows.map((r: any) => ({ ...mapJournalEntry(r), totalDebit: parseFloat(r.total_debit) || 0, totalCredit: parseFloat(r.total_credit) || 0 })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/journal-entries/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const row = await queryOne(`SELECT * FROM journal_entries WHERE id = $1`, [id]);
      if (!row) return res.status(404).json({ error: 'journal entry not found' });
      const { rows: lines } = await query(`
        SELECT jl.*, a.code as account_code, a.name as account_name
        FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.journal_entry_id = $1 ORDER BY jl.id`, [id]);
      res.json({ ...mapJournalEntry(row), lines: lines.map(mapJournalLine) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/journal-entries', async (req, res) => {
    const parsed = ManualJournalSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid journal entry payload', details: parsed.error.flatten() });
    const body = parsed.data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const journalEntryId = await postJournalEntry(client, {
        entryDate: body.entryDate || new Date().toISOString().slice(0, 10),
        memo: body.memo,
        sourceType: 'MANUAL',
        lines: body.lines,
      });
      await client.query('COMMIT');
      const row = await queryOne(`SELECT * FROM journal_entries WHERE id = $1`, [journalEntryId]);
      res.status(201).json(mapJournalEntry(row));
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/journal-entries/:id/void', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const entry = await queryOne<any>(`SELECT * FROM journal_entries WHERE id = $1`, [id]);
      if (!entry) return res.status(404).json({ error: 'journal entry not found' });
      if (entry.source_type !== 'MANUAL') {
        return res.status(400).json({ error: 'This entry was generated automatically. Void the source document (invoice, bill, payment, or expense) instead.' });
      }
      if (entry.status === 'VOID') return res.status(400).json({ error: 'Already void.' });
      await query(`UPDATE journal_entries SET status = 'VOID' WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // FINANCIAL REPORTS
  // ==========================================================================
  app.get('/api/reports/trial-balance', async (req, res) => {
    const asOf = String(req.query.asOf || new Date().toISOString().slice(0, 10));
    try {
      const { rows } = await query(`
        SELECT a.id as account_id, a.code, a.name, a.type,
               COALESCE(SUM(jl.debit),0) as total_debit,
               COALESCE(SUM(jl.credit),0) as total_credit
        FROM accounts a
        -- The POSTED / as-of filters must restrict which LINES are summed. Putting
        -- them in a LEFT JOIN ON clause against journal_entries only nulls out je;
        -- the journal_lines row survives and its debit/credit are still summed, so
        -- voided and future-dated entries leaked into the totals.
        LEFT JOIN (
          SELECT jl.account_id, jl.debit, jl.credit
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.journal_entry_id
          WHERE je.status = 'POSTED' AND je.entry_date <= $1
        ) jl ON jl.account_id = a.id
        GROUP BY a.id, a.code, a.name, a.type
        HAVING COALESCE(SUM(jl.debit),0) != 0 OR COALESCE(SUM(jl.credit),0) != 0
        ORDER BY a.code`, [asOf]);
      const mapped = rows.map((r: any) => {
        const debit = parseFloat(r.total_debit) || 0;
        const credit = parseFloat(r.total_credit) || 0;
        const net = Math.round((debit - credit) * 100) / 100;
        return { accountId: r.account_id, code: r.code, name: r.name, type: r.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
      })
        // Drop accounts whose debits and credits cancel out. The SQL HAVING
        // cannot exclude them because the net is only known after this mapping,
        // so they reached the table as rows with both cells rendered blank.
        .filter(r => r.debit !== 0 || r.credit !== 0);
      const totalDebit = Math.round(mapped.reduce((s, r) => s + r.debit, 0) * 100) / 100;
      const totalCredit = Math.round(mapped.reduce((s, r) => s + r.credit, 0) * 100) / 100;
      res.json({ asOf, rows: mapped, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/reports/profit-loss', async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const from = String(req.query.from || `${new Date().getFullYear()}-01-01`);
    const to = String(req.query.to || today);
    try {
      const { rows } = await query(`
        SELECT a.id as account_id, a.code, a.name, a.type,
               COALESCE(SUM(jl.debit),0) as total_debit,
               COALESCE(SUM(jl.credit),0) as total_credit
        FROM accounts a
        JOIN journal_lines jl ON jl.account_id = a.id
        JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' AND je.entry_date BETWEEN $1 AND $2
        WHERE a.type IN ('INCOME','EXPENSE')
        GROUP BY a.id, a.code, a.name, a.type
        ORDER BY a.code`, [from, to]);

      const income: any[] = [];
      const expenses: any[] = [];
      for (const r of rows) {
        const debit = parseFloat(r.total_debit) || 0;
        const credit = parseFloat(r.total_credit) || 0;
        if (r.type === 'INCOME') {
          income.push({ accountId: r.account_id, code: r.code, name: r.name, amount: Math.round((credit - debit) * 100) / 100 });
        } else {
          expenses.push({ accountId: r.account_id, code: r.code, name: r.name, amount: Math.round((debit - credit) * 100) / 100 });
        }
      }
      const totalIncome = Math.round(income.reduce((s, r) => s + r.amount, 0) * 100) / 100;
      const totalExpenses = Math.round(expenses.reduce((s, r) => s + r.amount, 0) * 100) / 100;
      res.json({ from, to, income, expenses, totalIncome, totalExpenses, netProfit: Math.round((totalIncome - totalExpenses) * 100) / 100 });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/reports/balance-sheet', async (req, res) => {
    const asOf = String(req.query.asOf || new Date().toISOString().slice(0, 10));
    const yearStart = `${new Date(asOf).getFullYear()}-01-01`;
    try {
      const { rows } = await query(`
        SELECT a.id as account_id, a.code, a.name, a.type,
               COALESCE(SUM(jl.debit),0) as total_debit,
               COALESCE(SUM(jl.credit),0) as total_credit
        FROM accounts a
        -- Same fix as the trial balance: filter the lines, not the joined entry,
        -- or voided/future-dated entries stay in the balance sheet.
        LEFT JOIN (
          SELECT jl.account_id, jl.debit, jl.credit
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.journal_entry_id
          WHERE je.status = 'POSTED' AND je.entry_date <= $1
        ) jl ON jl.account_id = a.id
        WHERE a.type IN ('ASSET','LIABILITY','EQUITY')
        GROUP BY a.id, a.code, a.name, a.type
        HAVING COALESCE(SUM(jl.debit),0) != 0 OR COALESCE(SUM(jl.credit),0) != 0
        ORDER BY a.code`, [asOf]);

      const assets: any[] = [];
      const liabilities: any[] = [];
      const equity: any[] = [];
      for (const r of rows) {
        const debit = parseFloat(r.total_debit) || 0;
        const credit = parseFloat(r.total_credit) || 0;
        if (r.type === 'ASSET') assets.push({ accountId: r.account_id, code: r.code, name: r.name, amount: Math.round((debit - credit) * 100) / 100 });
        else if (r.type === 'LIABILITY') liabilities.push({ accountId: r.account_id, code: r.code, name: r.name, amount: Math.round((credit - debit) * 100) / 100 });
        else equity.push({ accountId: r.account_id, code: r.code, name: r.name, amount: Math.round((credit - debit) * 100) / 100 });
      }

      // Same reasoning as the trial balance: an account whose debits and credits
      // cancel contributes nothing to the sheet and would render as a R0.00 row.
      const dropZero = (arr: any[]) => arr.filter(r => Math.abs(r.amount) > 0.005);
      assets.splice(0, assets.length, ...dropZero(assets));
      liabilities.splice(0, liabilities.length, ...dropZero(liabilities));
      equity.splice(0, equity.length, ...dropZero(equity));

      // Fold current year-to-date net income into equity as "Current Year Earnings" so the
      // sheet balances without requiring a formal period-close journal entry.
      const plRes = await query(`
        SELECT a.type, COALESCE(SUM(jl.debit),0) as d, COALESCE(SUM(jl.credit),0) as c
        FROM accounts a JOIN journal_lines jl ON jl.account_id = a.id
        JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED' AND je.entry_date BETWEEN $1 AND $2
        WHERE a.type IN ('INCOME','EXPENSE') GROUP BY a.type`, [yearStart, asOf]);
      let incomeTotal = 0, expenseTotal = 0;
      for (const r of plRes.rows as any[]) {
        if (r.type === 'INCOME') incomeTotal += parseFloat(r.c) - parseFloat(r.d);
        else expenseTotal += parseFloat(r.d) - parseFloat(r.c);
      }
      const currentEarnings = Math.round((incomeTotal - expenseTotal) * 100) / 100;
      if (Math.abs(currentEarnings) > 0.005) {
        equity.push({ accountId: -1, code: '3999', name: 'Current Year Earnings', amount: currentEarnings });
      }

      const totalAssets = Math.round(assets.reduce((s, r) => s + r.amount, 0) * 100) / 100;
      const totalLiabilities = Math.round(liabilities.reduce((s, r) => s + r.amount, 0) * 100) / 100;
      const totalEquity = Math.round(equity.reduce((s, r) => s + r.amount, 0) * 100) / 100;

      res.json({ asOf, assets, liabilities, equity, currentEarnings, totalAssets, totalLiabilities, totalEquity, balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01 });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/reports/ar-aging', async (req, res) => {
    const asOf = String(req.query.asOf || new Date().toISOString().slice(0, 10));
    try {
      const { rows } = await query(`
        SELECT i.client_id, COALESCE(c.client_name, 'Unassigned') as client_name, i.balance_due, i.due_date
        FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
        WHERE i.status NOT IN ('DRAFT','VOID','PAID') AND i.balance_due > 0.005`);
      res.json(buildAgingReport(rows, 'client_id', 'client_name', asOf));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/reports/ap-aging', async (req, res) => {
    const asOf = String(req.query.asOf || new Date().toISOString().slice(0, 10));
    try {
      const { rows } = await query(`
        SELECT b.supplier_id, COALESCE(s.name, 'Unassigned') as supplier_name, b.balance_due, b.due_date
        FROM bills b LEFT JOIN suppliers s ON s.id = b.supplier_id
        WHERE b.status NOT IN ('DRAFT','VOID','PAID') AND b.balance_due > 0.005`);
      res.json(buildAgingReport(rows, 'supplier_id', 'supplier_name', asOf));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/reports/general-ledger', async (req, res) => {
    const accountId = parseInt(String(req.query.accountId || '0'));
    if (!accountId) return res.status(400).json({ error: 'accountId is required' });
    const from = String(req.query.from || `${new Date().getFullYear()}-01-01`);
    const to = String(req.query.to || new Date().toISOString().slice(0, 10));
    try {
      const { rows } = await query(`
        SELECT jl.*, je.entry_number, je.entry_date, je.memo, je.source_type
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.journal_entry_id
        WHERE jl.account_id = $1 AND je.status = 'POSTED' AND je.entry_date BETWEEN $2 AND $3
        ORDER BY je.entry_date, je.id`, [accountId, from, to]);
      let running = 0;
      const account = await queryOne<any>(`SELECT normal_balance FROM accounts WHERE id = $1`, [accountId]);
      const normalDebit = account?.normal_balance === 'DEBIT';
      const mapped = rows.map((r: any) => {
        const debit = parseFloat(r.debit) || 0;
        const credit = parseFloat(r.credit) || 0;
        running += normalDebit ? (debit - credit) : (credit - debit);
        return { entryNumber: r.entry_number, entryDate: r.entry_date, memo: r.memo, sourceType: r.source_type, description: r.description, debit, credit, runningBalance: Math.round(running * 100) / 100 };
      });
      res.json({ accountId, from, to, lines: mapped, closingBalance: Math.round(running * 100) / 100 });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // DISPATCH NOTES — delivery & collection of final project products
  // Document-only: no GL posting and no automatic stock movement.
  // ==========================================================================
  const DISPATCH_NOTE_JOIN = `
    SELECT dn.*, c.client_name, co.order_number, i.invoice_number
    FROM dispatch_notes dn
    LEFT JOIN clients c ON c.id = dn.client_id
    LEFT JOIN client_orders co ON co.id = dn.client_order_id
    LEFT JOIN invoices i ON i.id = dn.invoice_id`;

  app.get('/api/dispatch-notes', async (req, res) => {
    try {
      const type = req.query.type ? String(req.query.type).toUpperCase() : null;
      const params: any[] = [];
      let where = '';
      if (type === 'DELIVERY' || type === 'COLLECTION') {
        params.push(type);
        where = `WHERE dn.note_type = $1`;
      }
      const { rows } = await query(`${DISPATCH_NOTE_JOIN} ${where} ORDER BY dn.id DESC`, params);
      res.json(rows.map(mapDispatchNote));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/dispatch-notes/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const row = await queryOne(`${DISPATCH_NOTE_JOIN} WHERE dn.id = $1`, [id]);
      if (!row) return res.status(404).json({ error: 'dispatch note not found' });
      const { rows: items } = await query(`SELECT * FROM dispatch_note_items WHERE dispatch_note_id = $1 ORDER BY id`, [id]);
      res.json({ ...mapDispatchNote(row), items: items.map(mapDispatchNoteItem) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  async function insertDispatchItems(client: any, noteId: number, items: any[]) {
    const inserted: any[] = [];
    for (const item of items) {
      const r = await client.query(
        `INSERT INTO dispatch_note_items (dispatch_note_id, part_number, description, quantity, serial_numbers, deduct_stock)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [noteId, item.partNumber || null, item.description, item.quantity, item.serialNumbers || null, !!item.deductStock]
      );
      inserted.push(r.rows[0]);
    }
    return inserted;
  }

  app.post('/api/dispatch-notes', async (req, res) => {
    const parsed = DispatchNoteCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid dispatch note payload', details: parsed.error.flatten() });
    const body = parsed.data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const isDelivery = body.noteType === 'DELIVERY';
      const noteNumber = await nextDocNumber(client, isDelivery ? 'DN' : 'CN', isDelivery ? 'dispatch_delivery_seq' : 'dispatch_collection_seq');
      const noteDate = body.noteDate || new Date().toISOString().slice(0, 10);
      const status = body.status || 'DRAFT';

      const noteRes = await client.query(
        `INSERT INTO dispatch_notes (note_number, note_type, client_id, client_order_id, invoice_id, note_date, scheduled_date, status, contact_person, address, carrier, reference, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [noteNumber, body.noteType, body.clientId || null, body.clientOrderId || null, body.invoiceId || null, noteDate, body.scheduledDate || null, status, body.contactPerson || null, body.address || null, body.carrier || null, body.reference || null, body.notes || null]
      );
      const noteId = noteRes.rows[0].id;
      const insertedItems = await insertDispatchItems(client, noteId, body.items);

      await client.query('COMMIT');
      const finalRow = await queryOne(`${DISPATCH_NOTE_JOIN} WHERE dn.id = $1`, [noteId]);
      res.status(201).json({ ...mapDispatchNote(finalRow), items: insertedItems.map(mapDispatchNoteItem) });
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  app.put('/api/dispatch-notes/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const parsed = DispatchNoteCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid dispatch note payload', details: parsed.error.flatten() });
    const body = parsed.data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(`SELECT status FROM dispatch_notes WHERE id = $1`, [id]);
      if (!existing.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'dispatch note not found' }); }
      if (existing.rows[0].status !== 'DRAFT') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Only DRAFT dispatch notes can be edited.' }); }

      await client.query(
        `UPDATE dispatch_notes SET client_id=$1, client_order_id=$2, invoice_id=$3, note_date=$4, scheduled_date=$5, contact_person=$6, address=$7, carrier=$8, reference=$9, notes=$10, updated_at=CURRENT_TIMESTAMP WHERE id=$11`,
        [body.clientId || null, body.clientOrderId || null, body.invoiceId || null, body.noteDate || new Date().toISOString().slice(0, 10), body.scheduledDate || null, body.contactPerson || null, body.address || null, body.carrier || null, body.reference || null, body.notes || null, id]
      );
      await client.query(`DELETE FROM dispatch_note_items WHERE dispatch_note_id = $1`, [id]);
      const insertedItems = await insertDispatchItems(client, id, body.items);

      await client.query('COMMIT');
      const finalRow = await queryOne(`${DISPATCH_NOTE_JOIN} WHERE dn.id = $1`, [id]);
      res.json({ ...mapDispatchNote(finalRow), items: insertedItems.map(mapDispatchNoteItem) });
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // Status transitions: DRAFT -> ISSUED -> COMPLETED, plus CANCELLED from DRAFT/ISSUED.
  const DISPATCH_TRANSITIONS: Record<string, string[]> = {
    issue: ['DRAFT'],
    complete: ['ISSUED'],
    cancel: ['DRAFT', 'ISSUED'],
  };
  const DISPATCH_TARGET: Record<string, string> = { issue: 'ISSUED', complete: 'COMPLETED', cancel: 'CANCELLED' };

  for (const action of ['issue', 'complete', 'cancel'] as const) {
    app.post(`/api/dispatch-notes/:id/${action}`, async (req, res) => {
      const id = parseInt(req.params.id);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const note = await queryOne<any>(`SELECT id, note_number, note_type, client_order_id, status FROM dispatch_notes WHERE id = $1`, [id]);
        if (!note) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'dispatch note not found' }); }
        if (!DISPATCH_TRANSITIONS[action].includes(note.status)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Cannot ${action} a dispatch note that is ${note.status}.` });
        }
        const target = DISPATCH_TARGET[action];
        const completedClause = target === 'COMPLETED' ? ', completed_at = CURRENT_TIMESTAMP' : '';
        await client.query(`UPDATE dispatch_notes SET status = $1${completedClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [target, id]);

        // On COMPLETE: deduct stock for any line flagged deduct_stock, and
        // release matching reservations against the linked sales order.
        if (target === 'COMPLETED') {
          const { rows: itemRows } = await client.query(`SELECT part_number, quantity, deduct_stock FROM dispatch_note_items WHERE dispatch_note_id = $1`, [id]);
          for (const it of itemRows) {
            if (it.deduct_stock && it.part_number) {
              const qty = Number(it.quantity) || 0;
              await adjustStock(client, it.part_number, -qty, 'OUTBOUND', `Dispatch ${note.note_number}`);
              if (note.client_order_id) {
                await releaseReservation(client, note.client_order_id, it.part_number, qty);
              }
            }
          }
        }

        await client.query('COMMIT');
        const finalRow = await queryOne(`${DISPATCH_NOTE_JOIN} WHERE dn.id = $1`, [id]);
        res.json(mapDispatchNote(finalRow));
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ error: err.message });
      } finally {
        client.release();
      }
    });
  }

  app.delete('/api/dispatch-notes/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const note = await queryOne<any>(`SELECT status FROM dispatch_notes WHERE id = $1`, [id]);
      if (!note) return res.status(404).json({ error: 'dispatch note not found' });
      if (note.status !== 'DRAFT') return res.status(400).json({ error: 'Only DRAFT dispatch notes can be deleted. Cancel it instead.' });
      await query(`DELETE FROM dispatch_notes WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}

function buildAgingReport(rows: any[], idField: string, nameField: string, asOf: string) {
  const asOfDate = new Date(asOf);
  const buckets = new Map<string, { entityId: any; entityName: string; current: number; d30: number; d60: number; d90: number; d90plus: number; total: number }>();
  for (const r of rows) {
    const key = String(r[idField] ?? 'unassigned');
    if (!buckets.has(key)) {
      buckets.set(key, { entityId: r[idField], entityName: r[nameField], current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0, total: 0 });
    }
    const bucket = buckets.get(key)!;
    const due = parseFloat(r.balance_due) || 0;
    const dueDate = r.due_date ? new Date(r.due_date) : asOfDate;
    const daysOverdue = Math.floor((asOfDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysOverdue <= 0) bucket.current += due;
    else if (daysOverdue <= 30) bucket.d30 += due;
    else if (daysOverdue <= 60) bucket.d60 += due;
    else if (daysOverdue <= 90) bucket.d90 += due;
    else bucket.d90plus += due;
    bucket.total += due;
  }
  return Array.from(buckets.values()).map(b => ({
    ...b,
    current: Math.round(b.current * 100) / 100,
    d30: Math.round(b.d30 * 100) / 100,
    d60: Math.round(b.d60 * 100) / 100,
    d90: Math.round(b.d90 * 100) / 100,
    d90plus: Math.round(b.d90plus * 100) / 100,
    total: Math.round(b.total * 100) / 100,
  })).sort((a, b) => b.total - a.total);
}
