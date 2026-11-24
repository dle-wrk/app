// A supplier's bank details as printed on their invoice ("Our banking details:
// Nedbank, a/c no. 1084804371, branch code 198765"), for their vendor record.
// Shared by the server (reading, saving) and the screens (showing).
//
// A misread account number pays the wrong account, and changed bank details on
// an invoice are a common fraud. So these only ever fill a vendor that has no
// bank account yet (never change one), the change is logged and stamped like any
// other banking change ("changed recently" on the vendor list), and the screens
// say to confirm by phone before paying.

export interface InvoiceBank {
  bankName: string | null;
  accountNumber: string;
  branchCode: string | null;
  accountType: string | null;
  swift: string | null;
}

/** South African banks as printed, and as a reader might drop a letter ("edbank"). */
const BANKS: [RegExp, string][] = [
  [/n?edbank/, 'Nedbank'],
  [/standardbank|stanbic/, 'Standard Bank'],
  [/firstnationalbank|\bfnb\b/, 'FNB'],
  [/absa/, 'Absa'],
  [/capitec/, 'Capitec'],
  [/investec/, 'Investec'],
  [/bidvest/, 'Bidvest Bank'],
  [/africanbank/, 'African Bank'],
  [/discoverybank/, 'Discovery Bank'],
  [/tymebank/, 'TymeBank'],
  [/mercantile/, 'Mercantile Bank'],
  [/sasfin/, 'Sasfin'],
];

const TYPES: [RegExp, string][] = [
  [/\bbusiness\b/i, 'Business'],
  [/\b(cheque|current)\b/i, 'Cheque / Current'],
  [/\bsavings?\b/i, 'Savings'],
  [/\btransmission\b/i, 'Transmission'],
];

const digits = (s: string) => s.replace(/\D/g, '');

/**
 * The bank details an invoice prints, from its text: the bank, account number,
 * branch code, account type and SWIFT code near "banking details" / "account
 * number" / "branch code". Null without an account number and a bank or branch
 * code. The buyer's own account ("Your a/c no.") and numbers given in
 * `exclude` (the VAT number) are never taken.
 */
export function bankFromText(text: string | null | undefined, exclude: Array<string | null | undefined> = []): InvoiceBank | null {
  const t = String(text || '').replace(/[ \t]+/g, ' ');
  const skip = new Set(exclude.map(e => digits(String(e ?? ''))).filter(Boolean));
  // Look about each place the bank details may be (a footer or a box), not the whole page:
  // the first that gives a whole set wins (the buyer's "Account Number" box may come first).
  for (const anchor of t.matchAll(/bank(ing)?\s*det|bank\s*name|\bbank\b|\ba\/c\b|acc(oun)?t\s*(no|num)|br[ae]nch\s*code/gi)) {
    const found = bankNear(t.slice(Math.max(0, anchor.index! - 80), anchor.index! + 420), skip);
    if (found) return found;
  }
  return null;
}

/** The bank details in one stretch of an invoice's text, or null. */
function bankNear(w: string, skip: Set<string>): InvoiceBank | null {

  // The account number: after its label ("a/c no.", "Account Number"), not after "Your".
  let account: string | null = null;
  for (const m of w.matchAll(/(your\s*)?(?:a\/c|acc(?:oun)?t)\s*(?:n\w{0,5}|m\w)?\s*[.:#]?\s*[:.]?\s*(\d[\d ]{4,15}\d)/gi)) {
    const n = digits(m[2]);
    if (!m[1] && n.length >= 6 && n.length <= 13 && !skip.has(n)) { account = n; break; }
  }
  // A table ("Bank Name: Branch: Account Number: ACDC Express Nedbank 128842 1028893787"): the
  // labels first, then the values: the account is the one 8 to 13 digit run.
  if (!account && /acc(oun)?t\s*(n|num)/i.test(w)) {
    const runs = [...w.matchAll(/(?<![\d/(-])\d{8,13}(?![\d/)])/g)].map(m => m[0]).filter(n => !skip.has(n));
    if (runs.length === 1) account = runs[0];
  }
  if (!account) return null;

  const compact = w.toLowerCase().replace(/[^a-z]/g, '');
  const bankName = BANKS.find(([re]) => re.test(compact))?.[1] ?? null;
  const labelled = /br\w{2,4}\s*(?:code|no)?\s*[.:]?\s*(\d{3}\s?\d{3})(?!\d)/i.exec(w);
  let branchCode = labelled ? digits(labelled[1]) : null;
  if (!branchCode && /br[ae]nch/i.test(w)) {
    const six = [...w.matchAll(/(?<![\d/(-])\d{6}(?![\d/)])/g)].map(m => m[0]).filter(n => n !== account && !skip.has(n));
    if (six.length === 1) branchCode = six[0];
  }
  if (!bankName && !branchCode) return null;
  const swift = /swift\s*(?:code|\/bic)?\s*[.:]?\s*([A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/.exec(w)?.[1] ?? null;
  const accountType = TYPES.find(([re]) => re.test(w))?.[1] ?? null;
  return { bankName, accountNumber: account, branchCode, accountType, swift };
}

/** Coerces a reader's own bank object (OpenAI, Mindee) to an InvoiceBank: null without an account number. */
export function tidyInvoiceBank(b: any): InvoiceBank | null {
  const s = (v: unknown, max = 60) => { const x = String(v ?? '').replace(/\s+/g, ' ').trim(); return x ? x.slice(0, max) : null; };
  const account = s(b?.accountNumber)?.replace(/[\s-]/g, '') ?? null;
  if (!account || !/^[A-Za-z0-9]{6,34}$/.test(account)) return null;
  const branch = s(b?.branchCode)?.replace(/[\s-]/g, '') ?? null;
  const swift = s(b?.swift)?.replace(/\s/g, '').toUpperCase() ?? null;
  return {
    bankName: s(b?.bankName), accountNumber: account,
    branchCode: branch && /^\d{4,8}$/.test(branch) ? branch : null,
    accountType: s(b?.accountType),
    swift: swift && /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift) ? swift : null,
  };
}

/** The bank details of a read invoice: what the reader gave, else found in its text. */
export function invoiceBank(o: { bank?: InvoiceBank | null; text?: string | null; supplierVatNumber?: string | null } | null | undefined): InvoiceBank | null {
  if (!o) return null;
  return o.bank ?? bankFromText(o.text, [o.supplierVatNumber]);
}

/** "Nedbank · a/c 1084804371 · branch 186786 · Business" */
export function describeBank(b: InvoiceBank | null | undefined): string {
  if (!b) return '';
  return [b.bankName, `a/c ${b.accountNumber}`, b.branchCode && `branch ${b.branchCode}`, b.accountType, b.swift && `SWIFT ${b.swift}`].filter(Boolean).join(' · ');
}
