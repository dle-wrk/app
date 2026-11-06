import { describe, it, expect } from 'vitest';
import { assembleStatement, isIsoDate } from './customerStatement';
import { statementRows, statementFilename, statementStart, allCustomerRows, combineStatements, sectionTables } from './statementPdf';

const client = { id: 30, name: 'Lumax Energy', contactName: 'Thabo', email: 'ap@lumax.test', phone: null, address: '270 Roan Cresent Midrand', vatNumber: '4123', paymentTermsDays: 30 };

const base = () => assembleStatement({
  client, asOf: '2026-11-06', from: null, openingBalance: 100,
  invoices: [
    { number: 'INV-2', date: '2026-10-13', dueDate: '2026-11-12', total: '1150', subtotal: '1000', tax: '150', discount: '0', balanceDue: '150', status: 'PARTIAL',
      lines: [{ partNumber: 'TCU06', description: 'Controller', quantity: 2, unitPrice: 500, lineTotal: 1000 }], notes: ['Deliver to gate 3', 'SO-2026-0004: rush'] },
    { number: 'INV-1', date: '2026-08-01', dueDate: '2026-08-31', total: '500', subtotal: '500', tax: '0', discount: '0', balanceDue: '200', status: 'PARTIAL', lines: [] },
  ],
  payments: [{ number: 'RCPT-1', date: '2026-10-13', amount: '1000', method: 'EFT', reference: 'LMX 77', appliedTo: [{ docNumber: 'INV-2', amount: 1000 }], notes: ['Paid late'] }],
  creditNotes: [{ number: 'CN-1', date: '2026-09-01', total: '300', refunded: '100', invoiceNumber: 'INV-1', reason: 'Damaged', status: 'APPLIED', lines: [] }],
});

describe('customer statement', () => {
  it('orders the documents and keeps a running balance', () => {
    const s = base();
    expect(s.transactions.map((t) => `${t.type} ${t.docNumber}`)).toEqual(['INVOICE INV-1', 'REFUND CN-1', 'CREDIT_NOTE CN-1', 'INVOICE INV-2', 'PAYMENT RCPT-1']);
    expect(s.transactions.map((t) => t.runningBalance)).toEqual([600, 700, 400, 1550, 550]);
    expect(s.closingBalance).toBe(550);
    expect(s.totals).toEqual({ invoiced: 1650, paid: 1000, credited: 300, refunded: 100 });
  });

  it('ages what is still open', () => {
    const s = base();
    expect(s.aging).toEqual({ current: 150, d30: 0, d60: 0, d90plus: 200, total: 350 });
    expect(s.overdueInvoices).toEqual([{ number: 'INV-1', date: '2026-08-01', dueDate: '2026-08-31', daysOverdue: 67, amount: 200 }]);
  });

  it('puts lines, VAT, what payments paid and every note under their document', () => {
    const rows = statementRows(base()).map((r) => r.cells[2]);
    expect(rows[0]).toBe('Opening balance');
    expect(rows.at(-1)).toBe('Closing balance');
    const inv2 = rows.lastIndexOf('Invoice · PARTIAL');
    expect(rows.slice(inv2 + 1, inv2 + 7)).toEqual([
      'TCU06  Controller  ·  2 × R500.00 = R1 000.00', 'Subtotal: R1 000.00', 'VAT: R150.00', 'Still owing on this invoice: R150.00', 'Note: Deliver to gate 3', 'Note: SO-2026-0004: rush',
    ]);
    expect(rows).toContain('Paid towards INV-2: R1 000.00');
    expect(rows).toContain('Note: Paid late');
    expect(rows).toContain('Payment · Ref LMX 77 · EFT');
    expect(rows).toContain('Credit note · against INV-1 · Damaged');
  });

  it('names the file for one customer or all of them', () => {
    expect(statementFilename([base()], '2026-11-06')).toBe('customer-statement-Lumax-Energy-2026-11-06.pdf');
    expect(statementFilename([base(), base()], '2026-11-06')).toBe('customer-statements-all-2026-11-06.pdf');
  });

  it('runs from the first transaction to the as-of date', () => {
    const s = base();
    expect(statementStart(s)).toBe('2026-08-01');
    expect(statementRows(s)[0].cells[0]).toBe('2026-08-01');
    expect(statementStart({ ...s, period: { from: '2026-01-01', asOf: '2026-11-06' } })).toBe('2026-01-01');
  });

  it('puts all customers in one statement, sorted by customer, with grand totals', () => {
    const lumax = base();
    const acme = { ...base(), client: { ...client, id: 2, name: 'acme Mining' }, transactions: base().transactions.slice(0, 1), closingBalance: 600, overdueInvoices: [] };
    const rows = allCustomerRows([lumax, acme]);
    const groups = rows.filter((r) => r.kind === 'group').map((r) => r.cells[2]);
    expect(groups).toEqual(['acme Mining', 'Lumax Energy']);
    expect(rows.at(-1)!.kind).toBe('total');
    expect(rows.at(-1)!.cells.slice(2)).toEqual(['All customers (2)', '', 'R2 250.00', 'R1 300.00', 'R1 150.00']);
    expect(rows.find((r) => r.cells[2] === 'Closing balance: Lumax Energy')!.cells[6]).toBe('R550.00');
    const c = combineStatements([lumax, acme]);
    expect(c.start).toBe('2026-08-01');
    expect(c.closingBalance).toBe(1150);
    expect(c.aging.total).toBe(700);
    expect(c.overdue.map((o) => `${o.customer} ${o.number}`)).toEqual(['Lumax Energy INV-1']);
  });

  it('shows a customer with no activity on the all-customers statement', () => {
    const quiet = { ...base(), client: { ...client, id: 3, name: 'Bokpoort' }, transactions: [], openingBalance: 0, closingBalance: 0, overdueInvoices: [] };
    const rows = allCustomerRows([base(), quiet]);
    const at = rows.findIndex((r) => r.kind === 'group' && r.cells[2] === 'Bokpoort');
    expect(rows.slice(at, at + 4).map((r) => r.cells[2])).toEqual(['Bokpoort', 'Opening balance', 'No invoices, payments or credit notes yet', 'Closing balance: Bokpoort']);
    expect(rows.at(-1)!.cells[2]).toBe('All customers (2)');
  });

  it('adds the Customer 360 tabs as tables, with a Customer column for all customers', () => {
    const sections: any = {
      overview: { openAr: 550, overdue: 200, overdueCount: 1, openOrders: 1, quotes: 2, lifetimeRevenue: 1650 },
      orders: [{ number: 'QUO-1', date: '2026-08-01', requiredDate: null, status: 'QUOTATION', total: 900, notes: 'Price valid 30 days', lines: [{ partNumber: 'TCU06', description: 'Controller', quantity: 1, unitPrice: 900, lineTotal: 900 }] }],
      invoices: [{ number: 'INV-3', date: '2026-11-01', dueDate: null, status: 'DRAFT', total: 10, paid: 0, balance: 10 }],
      payments: [], creditNotes: [],
      deliveries: [{ number: 'DN-1', type: 'DELIVERY', date: '2026-10-14', scheduledDate: null, status: 'COMPLETED', orderNumber: 'SO-1', invoiceNumber: 'INV-2', carrier: 'Courier Guy', reference: null, contact: null, address: null, notes: 'Gate 3', items: [{ partNumber: 'TCU06', description: 'Controller', quantity: 2, serials: 'A1, A2' }] }],
      history: [{ at: '2026-11-02', title: 'Call', detail: 'Asked for a quote', amount: null, by: 'dylan', followUp: '2026-11-09' }],
    };
    const one = sectionTables([{ ...base(), sections }], false);
    expect(one.map((t) => t.title)).toEqual(['Overview', 'Orders & Quotes', 'Invoices', 'Payments', 'Credit Notes', 'Deliveries', 'History']);
    const orders = one[1].rows;
    expect(orders[0].cells).toEqual(['QUO-1', '2026-08-01', '', 'Quotation', 'R900.00']);
    expect(orders.slice(1).map((r) => r.detail)).toEqual(['TCU06  Controller  ·  1 × R900.00 = R900.00', 'Note: Price valid 30 days']);
    expect(one[2].rows[0].cells[3]).toBe('Draft');
    expect(one[5].rows.map((r) => r.detail ?? r.cells[0])).toEqual(['DN-1', 'TCU06  Controller  ·  2  ·  S/N A1, A2', 'Carrier: Courier Guy', 'Note: Gate 3']);
    expect(one[6].rows[0].cells).toEqual(['2026-11-02', 'Call', 'Asked for a quote · follow up 2026-11-09', '', 'dylan']);

    const quiet = { ...base(), client: { ...client, id: 3, name: 'Bokpoort' }, sections: { ...sections, orders: [], deliveries: [], history: [], invoices: [] } };
    const all = sectionTables([{ ...base(), sections }, quiet], true);
    expect(all[0].head[0]).toBe('Customer');
    expect(all[0].rows.map((r) => r.cells[0])).toEqual(['Bokpoort', 'Lumax Energy']);
    expect(all[1].rows[0].cells[0]).toBe('Lumax Energy');
    expect(all[1].right).toEqual([5]);
  });

  it('only takes real dates', () => {
    expect(isIsoDate('2026-11-06')).toBe(true);
    expect(isIsoDate("2026-11-06'; DROP")).toBe(false);
  });
});
