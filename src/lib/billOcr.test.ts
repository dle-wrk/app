import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromMindeeFields, mergePages, normaliseBillOcr, readBill, readerOrder, readWithMindee, type BillOcr } from './billOcr';

const v = (value: unknown) => ({ value, confidence: 'High', locations: [] });
/** A page as Mindee's invoice model returns it (inference.result.fields). */
const mindeeFields = (over: Record<string, unknown> = {}) => ({
  supplier_name: v('HD Cabling'),
  supplier_company_registrations: { items: [{ fields: { type: v('CRN'), number: v('2010/123456/07') } }, { fields: { type: v('VAT NUMBER'), number: v('4 123 456 789') } }] },
  supplier_address: { fields: { address: v('14 Eastern St, Wierda Park, Centurion') } },
  supplier_phone_number: v('012 345 6789'),
  supplier_email: v('Sales@HDcabling.example'),
  supplier_website: v(null),
  invoice_number: v('SO-16907'),
  date: v('2026-11-10'),
  due_date: v(null),
  reference_numbers: { items: [v('PO-2026-0031')] },
  locale: { fields: { language: v('en'), currency: v('ZAR') } },
  total_net: v(151.3), total_tax: v(22.7), total_amount: v(174),
  line_items: { items: [{ fields: { description: v('100 Pack Network Cable Label Clips'), product_code: v('CLC-100'), quantity: v(2), unit_price: v(75.65), total_price: v(151.3) } }] },
  ...over,
});

describe('Mindee: what its invoice model returns, in the bill reader shape', () => {
  it('maps the fields: VAT from the registrations, address from its parts, currency from the locale, PO from the references', () => {
    const o = normaliseBillOcr(fromMindeeFields(mindeeFields()));
    expect(o).toMatchObject({
      supplier: 'HD Cabling', supplierVatNumber: '4123456789', supplierAddress: '14 Eastern St, Wierda Park, Centurion',
      supplierPhone: '012 345 6789', supplierEmail: 'sales@hdcabling.example', supplierWebsite: null,
      invoiceNumber: 'SO-16907', date: '2026-11-10', dueDate: null, poNumber: 'PO-2026-0031', currency: 'ZAR',
      subtotal: 151.3, taxTotal: 22.7, total: 174,
    });
    expect(o.lineItems).toEqual([{ description: '100 Pack Network Cable Label Clips', partNumber: 'CLC-100', quantity: 2, unitPrice: 75.65, lineTotal: 151.3 }]);
  });

  it('takes the first registration when none says VAT, and copes with an empty page', () => {
    const o = normaliseBillOcr(fromMindeeFields(mindeeFields({ supplier_company_registrations: { items: [{ fields: { type: v(null), number: v('4999888777') } }] } })));
    expect(o.supplierVatNumber).toBe('4999888777');
    expect(normaliseBillOcr(fromMindeeFields({}))).toMatchObject({ supplier: null, total: null, lineItems: [] });
  });

  it('puts the pages of one invoice together: details from the first that has them, totals from the last, all the lines', () => {
    const p1 = normaliseBillOcr(fromMindeeFields(mindeeFields({ total_net: v(null), total_tax: v(null), total_amount: v(null) })));
    const p2 = normaliseBillOcr(fromMindeeFields(mindeeFields({ supplier_name: v(null), invoice_number: v(null), total_amount: v(999), line_items: { items: [{ fields: { description: v('Delivery'), total_price: v(50) } }] } })));
    const m = mergePages([p1, p2]);
    expect(m).toMatchObject({ supplier: 'HD Cabling', invoiceNumber: 'SO-16907', total: 999, subtotal: 151.3 });
    expect(m.lineItems.map(l => l.description)).toEqual(['100 Pack Network Cable Label Clips', 'Delivery']);
  });
});

describe('which reader reads', () => {
  it('Mindee first when it is set up, OpenAI as the fallback; BILL_READER=openai swaps them', () => {
    expect(readerOrder({ MINDEE_API_KEY: 'k', MINDEE_MODEL_ID: 'm', OPENAI_API_KEY: 'o' })).toEqual(['mindee', 'openai']);
    expect(readerOrder({ MINDEE_API_KEY: 'k', MINDEE_MODEL_ID: 'm', OPENAI_API_KEY: 'o', BILL_READER: 'openai' })).toEqual(['openai', 'mindee']);
    expect(readerOrder({ MINDEE_API_KEY: 'k', OPENAI_API_KEY: 'o' })).toEqual(['openai']); // no model id: Mindee isn't set up
    expect(readerOrder({ MINDEE_API_KEY: 'k', MINDEE_MODEL_ID: 'm' })).toEqual(['mindee']);
    expect(readerOrder({})).toEqual([]);
  });
});

describe('talking to Mindee', () => {
  const page = 'data:image/jpeg;base64,/9j/AAAA';
  let calls: { url: string; init: any }[];
  const saved = { ...process.env };
  beforeEach(() => {
    calls = [];
    process.env.MINDEE_API_KEY = 'md_test_key'; process.env.MINDEE_MODEL_ID = 'model-123'; delete process.env.OPENAI_API_KEY; delete process.env.BILL_READER;
  });
  afterEach(() => { vi.unstubAllGlobals(); process.env = { ...saved }; });
  const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

  it('enqueues each page with the key and model, polls the job, reads the result, and merges the pages', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      if (url.endsWith('/products/extraction/enqueue')) { n++; return json(202, { job: { id: `job-${n}`, status: 'Processing', result_url: null } }); }
      if (url.includes('/jobs/')) {
        const id = /jobs\/([^?]+)/.exec(url)![1];
        const polls = calls.filter(c => c.url.includes(`/jobs/${id}`)).length;
        return json(200, { job: { id, status: polls < 2 ? 'Processing' : 'Processed', result_url: polls < 2 ? null : `https://api-v2.mindee.net/v2/products/extraction/results/${id}` } });
      }
      if (url.includes('/results/job-1')) return json(200, { inference: { result: { fields: mindeeFields({ total_amount: v(null) }) } } });
      if (url.includes('/results/job-2')) return json(200, { inference: { result: { fields: mindeeFields({ supplier_name: v(null), total_amount: v(174), line_items: { items: [] } }) } } });
      return json(404, {});
    }));
    const o = await readWithMindee([page, page], async () => {});
    expect(o).toMatchObject({ supplier: 'HD Cabling', total: 174, invoiceNumber: 'SO-16907' });
    const enq = calls.filter(c => c.url.endsWith('/enqueue'));
    expect(enq).toHaveLength(2);
    expect(enq[0].init.headers.Authorization).toBe('md_test_key'); // the key itself, no "Token" prefix
    expect(JSON.parse(enq[0].init.body)).toEqual({ model_id: 'model-123', file_base64: '/9j/AAAA', filename: 'page-1.jpg' });
    expect(calls.some(c => c.url.includes('/jobs/job-1?redirect=false'))).toBe(true);
  });

  it("says plainly when Mindee refuses the key or the job fails", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { detail: 'Invalid API key' })));
    await expect(readWithMindee([page], async () => {})).rejects.toThrow('refused the key');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/enqueue') ? json(202, { job: { id: 'j' } }) : json(200, { job: { id: 'j', status: 'Failed', error: { detail: 'Unreadable' } } }))));
    await expect(readWithMindee([page], async () => {})).rejects.toThrow('could not read page 1: Unreadable');
  });

  it('falls back to OpenAI when Mindee fails, and says which reader read it', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('https://api-v2.mindee.net')) return json(500, { detail: 'down' });
      return json(200, { choices: [{ message: { content: JSON.stringify({ supplier: 'HD Cabling', total: 174, lineItems: [] }) } }] });
    }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const o: BillOcr = await readBill([page]);
    expect(o).toMatchObject({ supplier: 'HD Cabling', total: 174, reader: 'openai' });
    err.mockRestore();
  });

  it('needs a reader set up', async () => {
    delete process.env.MINDEE_API_KEY;
    await expect(readBill([page])).rejects.toMatchObject({ status: 501 });
  });
});
