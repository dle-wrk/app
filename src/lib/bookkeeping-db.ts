import type { PoolClient } from 'pg';
import { pool, query, queryOne, exec } from './db';

// ============================================================================
// SCHEMA BOOTSTRAP
// ============================================================================
// All statements are CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, so this
// is safe to run on every server boot against a live database with existing data.

export async function ensureBookkeepingSchema() {
  // --- Chart of Accounts -----------------------------------------------------
  await exec(`CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')),
    subtype TEXT,
    normal_balance TEXT NOT NULL CHECK (normal_balance IN ('DEBIT','CREDIT')),
    description TEXT,
    is_system BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});

  await exec(`CREATE TABLE IF NOT EXISTS tax_rates (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    rate NUMERIC(6,3) NOT NULL DEFAULT 0,
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});

  // --- Clients & Suppliers -------------------------------------------------------
  await exec(`CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    client_name TEXT NOT NULL UNIQUE,
    contact_name TEXT,
    email TEXT,
    phone TEXT,
    address TEXT,
    vat_number TEXT,
    status TEXT DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});

  await exec(`CREATE TABLE IF NOT EXISTS suppliers (
    id SERIAL PRIMARY KEY,
    supplier_name TEXT NOT NULL UNIQUE,
    contact_name TEXT,
    email TEXT,
    phone TEXT,
    address TEXT,
    vat_number TEXT,
    status TEXT DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});

  // --- General Ledger ----------------------------------------------------------
  await exec(`CREATE TABLE IF NOT EXISTS journal_entries (
    id SERIAL PRIMARY KEY,
    entry_number TEXT UNIQUE NOT NULL,
    entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
    memo TEXT,
    source_type TEXT NOT NULL DEFAULT 'MANUAL',
    source_id INTEGER,
    status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','VOID')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});

  await exec(`CREATE TABLE IF NOT EXISTS journal_lines (
    id SERIAL PRIMARY KEY,
    journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_id INTEGER REFERENCES accounts(id),
    debit NUMERIC(14,2) NOT NULL DEFAULT 0,
    credit NUMERIC(14,2) NOT NULL DEFAULT 0,
    description TEXT,
    entity_type TEXT,
    entity_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(journal_entry_id)`).catch(() => {});

  // --- Sales: Invoices & Receipts ----------------------------------------------
  await exec(`CREATE TABLE IF NOT EXISTS invoices (
    id SERIAL PRIMARY KEY,
    invoice_number TEXT UNIQUE NOT NULL,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    client_order_id INTEGER REFERENCES client_orders(id) ON DELETE SET NULL,
    invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SENT','PARTIAL','PAID','OVERDUE','VOID')),
    currency TEXT DEFAULT 'ZAR',
    subtotal NUMERIC(14,2) DEFAULT 0,
    tax_total NUMERIC(14,2) DEFAULT 0,
    discount_total NUMERIC(14,2) DEFAULT 0,
    total NUMERIC(14,2) DEFAULT 0,
    amount_paid NUMERIC(14,2) DEFAULT 0,
    balance_due NUMERIC(14,2) DEFAULT 0,
    notes TEXT,
    terms TEXT,
    journal_entry_id INTEGER REFERENCES journal_entries(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});

  await exec(`CREATE TABLE IF NOT EXISTS invoice_items (
    id SERIAL PRIMARY KEY,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
    part_number TEXT,
    description TEXT NOT NULL,
    quantity NUMERIC(12,2) DEFAULT 1,
    unit_price NUMERIC(14,4) DEFAULT 0,
    tax_rate_id INTEGER REFERENCES tax_rates(id),
    tax_amount NUMERIC(14,2) DEFAULT 0,
    line_total NUMERIC(14,2) DEFAULT 0,
    deduct_stock BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});

  await exec(`CREATE TABLE IF NOT EXISTS payments_received (
    id SERIAL PRIMARY KEY,
    payment_number TEXT UNIQUE NOT NULL,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    amount NUMERIC(14,2) NOT NULL,
    unallocated_amount NUMERIC(14,2) DEFAULT 0,
    method TEXT DEFAULT 'EFT',
    deposit_account_id INTEGER REFERENCES accounts(id),
    reference TEXT,
    notes TEXT,
    journal_entry_id INTEGER REFERENCES journal_entries(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});

  await exec(`CREATE TABLE IF NOT EXISTS payment_receipt_allocations (
    id SERIAL PRIMARY KEY,
    payment_id INTEGER REFERENCES payments_received(id) ON DELETE CASCADE,
    invoice_id INTEGER REFERENCES invoices(id),
    amount_applied NUMERIC(14,2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});

  // --- Purchasing: POs, Bills & Payments ---------------------------------------
  await exec(`CREATE TABLE IF NOT EXISTS purchase_orders (
    id SERIAL PRIMARY KEY,
    po_number TEXT UNIQUE NOT NULL,
    supplier_id TEXT,
    order_date DATE NOT NULL DEFAULT CURRENT_DATE,
    expected_date DATE,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SENT','PARTIAL','RECEIVED','CANCELLED')),
    currency TEXT DEFAULT 'ZAR',
    subtotal NUMERIC(14,2) DEFAULT 0,
    tax_total NUMERIC(14,2) DEFAULT 0,
    total NUMERIC(14,2) DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});

  await exec(`CREATE TABLE IF NOT EXISTS purchase_order_items (
    id SERIAL PRIMARY KEY,
    purchase_order_id INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
    part_number TEXT,
    description TEXT NOT NULL,
    quantity NUMERIC(12,2) DEFAULT 1,
    unit_price NUMERIC(14,4) DEFAULT 0,
    tax_rate_id INTEGER REFERENCES tax_rates(id),
    tax_amount NUMERIC(14,2) DEFAULT 0,
    line_total NUMERIC(14,2) DEFAULT 0,
    qty_received NUMERIC(12,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});

  await exec(`CREATE TABLE IF NOT EXISTS bills (
    id SERIAL PRIMARY KEY,
    bill_number TEXT UNIQUE NOT NULL,
    supplier_id TEXT,
    purchase_order_id INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
    bill_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','AWAITING_PAYMENT','PARTIAL','PAID','OVERDUE','VOID')),
    currency TEXT DEFAULT 'ZAR',
    subtotal NUMERIC(14,2) DEFAULT 0,
    tax_total NUMERIC(14,2) DEFAULT 0,
    total NUMERIC(14,2) DEFAULT 0,
    amount_paid NUMERIC(14,2) DEFAULT 0,
    balance_due NUMERIC(14,2) DEFAULT 0,
    notes TEXT,
    journal_entry_id INTEGER REFERENCES journal_entries(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});

  await exec(`CREATE TABLE IF NOT EXISTS bill_items (
    id SERIAL PRIMARY KEY,
    bill_id INTEGER REFERENCES bills(id) ON DELETE CASCADE,
    part_number TEXT,
    description TEXT NOT NULL,
    quantity NUMERIC(12,2) DEFAULT 1,
    unit_price NUMERIC(14,4) DEFAULT 0,
    account_id INTEGER REFERENCES accounts(id),
    tax_rate_id INTEGER REFERENCES tax_rates(id),
    tax_amount NUMERIC(14,2) DEFAULT 0,
    line_total NUMERIC(14,2) DEFAULT 0,
    receive_stock BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});

  await exec(`CREATE TABLE IF NOT EXISTS payments_made (
    id SERIAL PRIMARY KEY,
    payment_number TEXT UNIQUE NOT NULL,
    supplier_id TEXT,
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    amount NUMERIC(14,2) NOT NULL,
    unallocated_amount NUMERIC(14,2) DEFAULT 0,
    method TEXT DEFAULT 'EFT',
    paid_from_account_id INTEGER REFERENCES accounts(id),
    reference TEXT,
    notes TEXT,
    journal_entry_id INTEGER REFERENCES journal_entries(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});

  await exec(`CREATE TABLE IF NOT EXISTS payment_made_allocations (
    id SERIAL PRIMARY KEY,
    payment_id INTEGER REFERENCES payments_made(id) ON DELETE CASCADE,
    bill_id INTEGER REFERENCES bills(id),
    amount_applied NUMERIC(14,2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});

  // --- Expenses (paid immediately, no AP) --------------------------------------
  await exec(`CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY,
    expense_number TEXT UNIQUE NOT NULL,
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
    payee TEXT,
    supplier_id TEXT,
    category_account_id INTEGER REFERENCES accounts(id),
    paid_from_account_id INTEGER REFERENCES accounts(id),
    amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_rate_id INTEGER REFERENCES tax_rates(id),
    tax_amount NUMERIC(14,2) DEFAULT 0,
    total NUMERIC(14,2) DEFAULT 0,
    reference TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED','VOID')),
    journal_entry_id INTEGER REFERENCES journal_entries(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});

  // --- Warranty claim flag on invoices -----------------------------------------
  // Default TRUE: for now every sales value is treated as a warranty claim, with a
  // per-invoice toggle to mark it as a normal sale instead. This is metadata only —
  // the GL posting is unchanged — so the accounting treatment can be refined later
  // (e.g. routing warranty claims to a dedicated income/expense account).
  await exec(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_warranty_claim BOOLEAN DEFAULT TRUE`).catch(() => {});

  // --- Dispatch notes: delivery & collection of final project products ---------
  // Fulfillment documents (not accounting entries): they record which finished goods
  // physically left the premises (DELIVERY) or were handed over for pickup (COLLECTION),
  // optionally against a client order. No GL impact and no automatic stock movement —
  // invoices already own optional stock deduction, so keeping these document-only avoids
  // double-counting inventory.
  await exec(`CREATE TABLE IF NOT EXISTS dispatch_notes (
    id SERIAL PRIMARY KEY,
    note_number TEXT UNIQUE NOT NULL,
    note_type TEXT NOT NULL CHECK (note_type IN ('DELIVERY','COLLECTION')),
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    client_order_id INTEGER REFERENCES client_orders(id) ON DELETE SET NULL,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    note_date DATE NOT NULL DEFAULT CURRENT_DATE,
    scheduled_date DATE,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ISSUED','COMPLETED','CANCELLED')),
    contact_person TEXT,
    address TEXT,
    carrier TEXT,
    reference TEXT,
    notes TEXT,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});

  await exec(`CREATE TABLE IF NOT EXISTS dispatch_note_items (
    id SERIAL PRIMARY KEY,
    dispatch_note_id INTEGER REFERENCES dispatch_notes(id) ON DELETE CASCADE,
    part_number TEXT,
    description TEXT NOT NULL,
    quantity NUMERIC(12,2) DEFAULT 1,
    serial_numbers TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS idx_dispatch_note_items_note ON dispatch_note_items(dispatch_note_id)`).catch(() => {});

  // --- Extend existing entities with light-weight accounting fields -----------
  await exec(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER DEFAULT 30`).catch(() => {});
  await exec(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS opening_balance NUMERIC(14,2) DEFAULT 0`).catch(() => {});
  await exec(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER DEFAULT 30`).catch(() => {});

  // --- Document numbering sequences --------------------------------------------
  await exec(`CREATE SEQUENCE IF NOT EXISTS invoice_seq`).catch(() => {});
  await exec(`CREATE SEQUENCE IF NOT EXISTS bill_seq`).catch(() => {});
  await exec(`CREATE SEQUENCE IF NOT EXISTS po_seq`).catch(() => {});
  await exec(`CREATE SEQUENCE IF NOT EXISTS payment_in_seq`).catch(() => {});
  await exec(`CREATE SEQUENCE IF NOT EXISTS payment_out_seq`).catch(() => {});
  await exec(`CREATE SEQUENCE IF NOT EXISTS expense_seq`).catch(() => {});
  await exec(`CREATE SEQUENCE IF NOT EXISTS je_seq`).catch(() => {});
  await exec(`CREATE SEQUENCE IF NOT EXISTS dispatch_delivery_seq`).catch(() => {});
  await exec(`CREATE SEQUENCE IF NOT EXISTS dispatch_collection_seq`).catch(() => {});

  // --- Default Chart of Accounts (seeded once) ---------------------------------
  const acctCount = await queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM accounts`);
  if (parseInt(acctCount?.count || '0', 10) === 0) {
    const defaultAccounts: Array<[string, string, string, string, string, boolean]> = [
      // code, name, type, subtype, normalBalance, isSystem
      ['1000', 'Cash on Hand', 'ASSET', 'CASH', 'DEBIT', false],
      ['1010', 'Bank Account', 'ASSET', 'BANK', 'DEBIT', false],
      ['1100', 'Accounts Receivable', 'ASSET', 'ACCOUNTS_RECEIVABLE', 'DEBIT', true],
      ['1200', 'Inventory Asset', 'ASSET', 'INVENTORY', 'DEBIT', true],
      ['1400', 'Prepaid Expenses', 'ASSET', 'OTHER_CURRENT_ASSET', 'DEBIT', false],
      ['1500', 'Equipment & Fixed Assets', 'ASSET', 'FIXED_ASSET', 'DEBIT', false],
      ['2000', 'Accounts Payable', 'LIABILITY', 'ACCOUNTS_PAYABLE', 'CREDIT', true],
      ['2100', 'VAT Control Account', 'LIABILITY', 'TAX', 'CREDIT', true],
      ['2200', 'Accrued Expenses', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT', false],
      ['2300', 'Short-Term Loans', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT', false],
      ['3000', "Owner's Equity", 'EQUITY', 'EQUITY', 'CREDIT', false],
      ['3900', 'Retained Earnings', 'EQUITY', 'EQUITY', 'CREDIT', true],
      ['4000', 'Sales Revenue', 'INCOME', 'SALES', 'CREDIT', true],
      ['4100', 'Service Revenue', 'INCOME', 'SALES', 'CREDIT', false],
      ['4900', 'Other Income', 'INCOME', 'OTHER_INCOME', 'CREDIT', false],
      ['5000', 'Cost of Goods Sold', 'EXPENSE', 'COGS', 'DEBIT', true],
      ['6000', 'Salaries & Wages', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT', false],
      ['6010', 'Rent Expense', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT', false],
      ['6020', 'Utilities Expense', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT', false],
      ['6030', 'Office Supplies', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT', false],
      ['6040', 'Bank Fees & Charges', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT', false],
      ['6050', 'Shipping & Freight', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT', false],
      ['6060', 'Repairs & Maintenance', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT', false],
      ['6070', 'Marketing & Advertising', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT', false],
      ['6080', 'Professional Fees', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT', false],
      ['6090', 'Insurance', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT', false],
      ['6900', 'Other Expenses', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT', true],
    ];
    for (const [code, name, type, subtype, normalBalance, isSystem] of defaultAccounts) {
      await pool.query(
        `INSERT INTO accounts (code, name, type, subtype, normal_balance, is_system) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING`,
        [code, name, type, subtype, normalBalance, isSystem]
      );
    }
    console.log('Seeded default Chart of Accounts.');
  }

  // --- Default Tax Rates (seeded once) -----------------------------------------
  const taxCount = await queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM tax_rates`);
  if (parseInt(taxCount?.count || '0', 10) === 0) {
    await pool.query(`INSERT INTO tax_rates (name, rate, is_default) VALUES ($1,$2,$3)`, ['Standard VAT (15%)', 15, true]);
    await pool.query(`INSERT INTO tax_rates (name, rate, is_default) VALUES ($1,$2,$3)`, ['Zero-Rated (0%)', 0, false]);
    await pool.query(`INSERT INTO tax_rates (name, rate, is_default) VALUES ($1,$2,$3)`, ['Exempt', 0, false]);
    console.log('Seeded default tax rates.');
  }

  // --- Default Clients (seeded once) -------------------------------------------
  const clientCount = await queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM clients`);
  if (parseInt(clientCount?.count || '0', 10) === 0) {
    const defaultClients = [
      ['DEWA', 'Ahmed Hassan', 'ahmed@dewa.ae', '+971-4-XXX-XXXX', 'Dubai, UAE', 'AE-123456', 'ACTIVE'],
      ['SASOL', 'Thembi Ntuli', 'thembi@sasol.com', '+27-11-XXX-XXXX', 'Johannesburg, SA', 'ZA-654321', 'ACTIVE'],
      ['BOKPOORT', 'Jan de Villiers', 'jan@bokpoort.co.za', '+27-54-XXX-XXXX', 'Northern Cape, SA', 'ZA-789012', 'ACTIVE'],
      ['ESKOM', 'Lindiwe Khumalo', 'lindiwe@eskom.co.za', '+27-11-XXX-XXXX', 'Pretoria, SA', 'ZA-345678', 'ACTIVE'],
      ['ARAMCO', 'Mohammed Al-Saud', 'mohammed@aramco.com.sa', '+966-1-XXX-XXXX', 'Riyadh, SA', 'SA-111111', 'ACTIVE'],
    ];
    for (const [clientName, contactName, email, phone, address, vatNum, status] of defaultClients) {
      await pool.query(
        `INSERT INTO clients (client_name, contact_name, email, phone, address, vat_number, status) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (client_name) DO NOTHING`,
        [clientName, contactName, email, phone, address, vatNum, status]
      );
    }
    console.log('Seeded default clients.');
  }

  // --- Default Suppliers (seeded once) -----------------------------------------
  const supplierCount = await queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM suppliers`);
  if (parseInt(supplierCount?.count || '0', 10) === 0) {
    const defaultSuppliers = [
      ['MOUSER ELECTRONICS', 'John Smith', 'john@mouser.com', '+1-817-XXX-XXXX', 'Fort Worth, USA', 'US-111111', 'ACTIVE'],
      ['DIGIKEY', 'Sarah Johnson', 'sarah@digikey.com', '+1-218-XXX-XXXX', 'Thief River Falls, USA', 'US-222222', 'ACTIVE'],
      ['LCSC ELECTRONICS', 'Li Wei', 'li@lcsc.com', '+86-755-XXX-XXXX', 'Shenzhen, China', 'CN-333333', 'ACTIVE'],
      ['HEILIND INDUSTRIAL', 'Mike Brown', 'mike@heilind.com', '+27-11-XXX-XXXX', 'Johannesburg, SA', 'ZA-444444', 'ACTIVE'],
      ['RS COMPONENTS', 'Emma White', 'emma@rs-online.com', '+44-20-XXX-XXXX', 'Corby, UK', 'GB-555555', 'ACTIVE'],
    ];
    for (const [supplierName, contactName, email, phone, address, vatNum, status] of defaultSuppliers) {
      await pool.query(
        `INSERT INTO suppliers (supplier_name, contact_name, email, phone, address, vat_number, status) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (supplier_name) DO NOTHING`,
        [supplierName, contactName, email, phone, address, vatNum, status]
      );
    }
    console.log('Seeded default suppliers.');
  }
}

// ============================================================================
// SYSTEM ACCOUNT LOOKUPS
// ============================================================================

export const SYSTEM_ACCOUNT_CODES = {
  AR: '1100',
  AP: '2000',
  VAT: '2100',
  SALES: '4000',
  COGS: '5000',
  DEFAULT_EXPENSE: '6900',
  DEFAULT_BANK: '1010',
} as const;

export async function getAccountIdByCode(code: string): Promise<number> {
  const row = await queryOne<{ id: number }>(`SELECT id FROM accounts WHERE code = $1`, [code]);
  if (!row) throw new Error(`System account with code ${code} not found. Chart of Accounts may be misconfigured.`);
  return row.id;
}

// ============================================================================
// DOCUMENT NUMBERING
// ============================================================================

type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

export async function nextDocNumber(db: Queryable, prefix: string, seqName: string): Promise<string> {
  const { rows } = await db.query(`SELECT nextval($1) as n`, [seqName]);
  const n = Number(rows[0].n);
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
}

// ============================================================================
// DOUBLE-ENTRY POSTING HELPERS
// ============================================================================

export interface JournalLineInput {
  accountId: number;
  debit?: number;
  credit?: number;
  description?: string;
  entityType?: 'CUSTOMER' | 'SUPPLIER';
  entityId?: number;
}

export interface PostJournalEntryParams {
  entryDate: string;
  memo?: string;
  sourceType: 'INVOICE' | 'BILL' | 'PAYMENT_RECEIVED' | 'PAYMENT_MADE' | 'EXPENSE' | 'MANUAL' | 'REVERSAL';
  sourceId?: number;
  lines: JournalLineInput[];
}

const EPSILON = 0.005;

/**
 * Posts a balanced double-entry journal entry inside an existing DB transaction.
 * Throws if debits and credits don't balance, or if fewer than 2 lines are supplied.
 */
export async function postJournalEntry(client: PoolClient, params: PostJournalEntryParams): Promise<number> {
  const { entryDate, memo, sourceType, sourceId, lines } = params;
  if (!lines || lines.length < 2) {
    throw new Error('A journal entry requires at least two lines.');
  }
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    totalDebit += Number(line.debit || 0);
    totalCredit += Number(line.credit || 0);
  }
  if (Math.abs(totalDebit - totalCredit) > EPSILON) {
    throw new Error(`Journal entry does not balance: debits ${totalDebit.toFixed(2)} vs credits ${totalCredit.toFixed(2)}.`);
  }
  if (totalDebit <= 0) {
    throw new Error('Journal entry has a zero total and cannot be posted.');
  }

  const entryNumber = await nextDocNumber(client, 'JE', 'je_seq');
  const entryRes = await client.query(
    `INSERT INTO journal_entries (entry_number, entry_date, memo, source_type, source_id, status)
     VALUES ($1, $2, $3, $4, $5, 'POSTED') RETURNING id`,
    [entryNumber, entryDate, memo || null, sourceType, sourceId || null]
  );
  const journalEntryId = entryRes.rows[0].id;

  for (const line of lines) {
    await client.query(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, description, entity_type, entity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [journalEntryId, line.accountId, line.debit || 0, line.credit || 0, line.description || null, line.entityType || null, line.entityId || null]
    );
  }

  return journalEntryId;
}

/**
 * Posts an equal-and-opposite reversing entry for a previously posted journal entry.
 * The original entry is left untouched (immutable audit trail); the reversal is dated
 * "today" (or an explicit date) rather than back-dated to the original transaction.
 */
export async function reverseJournalEntry(client: PoolClient, originalEntryId: number, opts: { entryDate?: string; memo?: string; sourceType: PostJournalEntryParams['sourceType']; sourceId?: number }): Promise<number> {
  const { rows } = await client.query(`SELECT account_id, debit, credit, description, entity_type, entity_id FROM journal_lines WHERE journal_entry_id = $1`, [originalEntryId]);
  if (!rows.length) throw new Error('Cannot reverse: original journal entry has no lines.');

  const lines: JournalLineInput[] = rows.map((r: any) => ({
    accountId: r.account_id,
    debit: Number(r.credit || 0),
    credit: Number(r.debit || 0),
    description: r.description,
    entityType: r.entity_type,
    entityId: r.entity_id,
  }));

  return postJournalEntry(client, {
    entryDate: opts.entryDate || new Date().toISOString().slice(0, 10),
    memo: opts.memo || 'Reversal',
    sourceType: opts.sourceType,
    sourceId: opts.sourceId,
    lines,
  });
}

// ============================================================================
// ROW MAPPERS (snake_case DB rows -> camelCase API shapes)
// ============================================================================

export const mapAccount = (r: any) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  type: r.type,
  subtype: r.subtype,
  normalBalance: r.normal_balance,
  description: r.description,
  isSystem: r.is_system,
  isActive: r.is_active,
  createdAt: r.created_at,
});

export const mapTaxRate = (r: any) => ({
  id: r.id,
  name: r.name,
  rate: parseFloat(r.rate) || 0,
  isDefault: r.is_default,
  createdAt: r.created_at,
});

export const mapJournalEntry = (r: any) => ({
  id: r.id,
  entryNumber: r.entry_number,
  entryDate: r.entry_date,
  memo: r.memo,
  sourceType: r.source_type,
  sourceId: r.source_id,
  status: r.status,
  createdAt: r.created_at,
});

export const mapJournalLine = (r: any) => ({
  id: r.id,
  journalEntryId: r.journal_entry_id,
  accountId: r.account_id,
  accountCode: r.account_code,
  accountName: r.account_name,
  debit: parseFloat(r.debit) || 0,
  credit: parseFloat(r.credit) || 0,
  description: r.description,
  entityType: r.entity_type,
  entityId: r.entity_id,
});

export const mapInvoice = (r: any) => ({
  id: r.id,
  invoiceNumber: r.invoice_number,
  clientId: r.client_id,
  clientOrderId: r.client_order_id,
  invoiceDate: r.invoice_date,
  dueDate: r.due_date,
  status: r.status,
  currency: r.currency,
  subtotal: parseFloat(r.subtotal) || 0,
  taxTotal: parseFloat(r.tax_total) || 0,
  discountTotal: parseFloat(r.discount_total) || 0,
  total: parseFloat(r.total) || 0,
  amountPaid: parseFloat(r.amount_paid) || 0,
  balanceDue: parseFloat(r.balance_due) || 0,
  notes: r.notes,
  terms: r.terms,
  isWarrantyClaim: r.is_warranty_claim ?? true,
  journalEntryId: r.journal_entry_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  clientName: r.client_name,
});

export const mapInvoiceItem = (r: any) => ({
  id: r.id,
  invoiceId: r.invoice_id,
  partNumber: r.part_number,
  description: r.description,
  quantity: parseFloat(r.quantity) || 0,
  unitPrice: parseFloat(r.unit_price) || 0,
  taxRateId: r.tax_rate_id,
  taxAmount: parseFloat(r.tax_amount) || 0,
  lineTotal: parseFloat(r.line_total) || 0,
  deductStock: r.deduct_stock,
});

export const mapPaymentReceived = (r: any) => ({
  id: r.id,
  paymentNumber: r.payment_number,
  clientId: r.client_id,
  paymentDate: r.payment_date,
  amount: parseFloat(r.amount) || 0,
  unallocatedAmount: parseFloat(r.unallocated_amount) || 0,
  method: r.method,
  depositAccountId: r.deposit_account_id,
  reference: r.reference,
  notes: r.notes,
  journalEntryId: r.journal_entry_id,
  createdAt: r.created_at,
  clientName: r.client_name,
});

export const mapPaymentAllocation = (r: any) => ({
  id: r.id,
  paymentId: r.payment_id,
  invoiceId: r.invoice_id,
  amountApplied: parseFloat(r.amount_applied) || 0,
  invoiceNumber: r.invoice_number,
});

export const mapPurchaseOrder = (r: any) => ({
  id: r.id,
  poNumber: r.po_number,
  supplierId: r.supplier_id,
  orderDate: r.order_date,
  expectedDate: r.expected_date,
  status: r.status,
  currency: r.currency,
  subtotal: parseFloat(r.subtotal) || 0,
  taxTotal: parseFloat(r.tax_total) || 0,
  total: parseFloat(r.total) || 0,
  notes: r.notes,
  createdAt: r.created_at,
  supplierName: r.supplier_name,
});

export const mapPurchaseOrderItem = (r: any) => ({
  id: r.id,
  purchaseOrderId: r.purchase_order_id,
  partNumber: r.part_number,
  description: r.description,
  quantity: parseFloat(r.quantity) || 0,
  unitPrice: parseFloat(r.unit_price) || 0,
  taxRateId: r.tax_rate_id,
  taxAmount: parseFloat(r.tax_amount) || 0,
  lineTotal: parseFloat(r.line_total) || 0,
  qtyReceived: parseFloat(r.qty_received) || 0,
});

export const mapBill = (r: any) => ({
  id: r.id,
  billNumber: r.bill_number,
  supplierId: r.supplier_id,
  purchaseOrderId: r.purchase_order_id,
  billDate: r.bill_date,
  dueDate: r.due_date,
  status: r.status,
  currency: r.currency,
  subtotal: parseFloat(r.subtotal) || 0,
  taxTotal: parseFloat(r.tax_total) || 0,
  total: parseFloat(r.total) || 0,
  amountPaid: parseFloat(r.amount_paid) || 0,
  balanceDue: parseFloat(r.balance_due) || 0,
  notes: r.notes,
  journalEntryId: r.journal_entry_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  supplierName: r.supplier_name,
});

export const mapBillItem = (r: any) => ({
  id: r.id,
  billId: r.bill_id,
  partNumber: r.part_number,
  description: r.description,
  quantity: parseFloat(r.quantity) || 0,
  unitPrice: parseFloat(r.unit_price) || 0,
  accountId: r.account_id,
  taxRateId: r.tax_rate_id,
  taxAmount: parseFloat(r.tax_amount) || 0,
  lineTotal: parseFloat(r.line_total) || 0,
  receiveStock: r.receive_stock,
});

export const mapPaymentMade = (r: any) => ({
  id: r.id,
  paymentNumber: r.payment_number,
  supplierId: r.supplier_id,
  paymentDate: r.payment_date,
  amount: parseFloat(r.amount) || 0,
  unallocatedAmount: parseFloat(r.unallocated_amount) || 0,
  method: r.method,
  paidFromAccountId: r.paid_from_account_id,
  reference: r.reference,
  notes: r.notes,
  journalEntryId: r.journal_entry_id,
  createdAt: r.created_at,
  supplierName: r.supplier_name,
});

export const mapPaymentMadeAllocation = (r: any) => ({
  id: r.id,
  paymentId: r.payment_id,
  billId: r.bill_id,
  amountApplied: parseFloat(r.amount_applied) || 0,
  billNumber: r.bill_number,
});

export const mapExpense = (r: any) => ({
  id: r.id,
  expenseNumber: r.expense_number,
  expenseDate: r.expense_date,
  payee: r.payee,
  supplierId: r.supplier_id,
  categoryAccountId: r.category_account_id,
  paidFromAccountId: r.paid_from_account_id,
  amount: parseFloat(r.amount) || 0,
  taxRateId: r.tax_rate_id,
  taxAmount: parseFloat(r.tax_amount) || 0,
  total: parseFloat(r.total) || 0,
  reference: r.reference,
  notes: r.notes,
  status: r.status,
  journalEntryId: r.journal_entry_id,
  createdAt: r.created_at,
  categoryAccountName: r.category_account_name,
  paidFromAccountName: r.paid_from_account_name,
});

export const mapDispatchNote = (r: any) => ({
  id: r.id,
  noteNumber: r.note_number,
  noteType: r.note_type,
  clientId: r.client_id,
  clientOrderId: r.client_order_id,
  invoiceId: r.invoice_id,
  noteDate: r.note_date,
  scheduledDate: r.scheduled_date,
  status: r.status,
  contactPerson: r.contact_person,
  address: r.address,
  carrier: r.carrier,
  reference: r.reference,
  notes: r.notes,
  completedAt: r.completed_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  clientName: r.client_name,
  orderNumber: r.order_number,
  invoiceNumber: r.invoice_number,
});

export const mapDispatchNoteItem = (r: any) => ({
  id: r.id,
  dispatchNoteId: r.dispatch_note_id,
  partNumber: r.part_number,
  description: r.description,
  quantity: parseFloat(r.quantity) || 0,
  serialNumbers: r.serial_numbers,
});

// ============================================================================
// LINE ITEM COMPUTATION (shared by invoices, bills, purchase orders)
// ============================================================================

export interface RawLineInput {
  partNumber?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRatePercent?: number;
}

export function computeLineTotals(line: RawLineInput) {
  const qty = Number(line.quantity) || 0;
  const price = Number(line.unitPrice) || 0;
  const taxPct = Number(line.taxRatePercent) || 0;
  const base = qty * price;
  const taxAmount = Math.round(base * (taxPct / 100) * 100) / 100;
  const lineTotal = Math.round((base + taxAmount) * 100) / 100;
  return { base: Math.round(base * 100) / 100, taxAmount, lineTotal };
}

export function computeDocumentTotals(lines: Array<{ base: number; taxAmount: number }>, discountTotal = 0) {
  const subtotal = Math.round(lines.reduce((s, l) => s + l.base, 0) * 100) / 100;
  const taxTotal = Math.round(lines.reduce((s, l) => s + l.taxAmount, 0) * 100) / 100;
  const total = Math.round((subtotal - discountTotal + taxTotal) * 100) / 100;
  return { subtotal, taxTotal, total };
}
