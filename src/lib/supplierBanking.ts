// A supplier's banking details, for paying their bills (EFT). Shared by the
// server (checks and stores them) and the screens (shows them, masked in lists).
//
// Changed bank details are how most supplier-payment fraud works (a fake "we
// have new banking details" email), so every change is logged with the old and
// new account (last four digits only) and the date it changed is kept on the
// supplier, for the screens to show and prompt a phone check before paying.

export interface SupplierBanking {
  bankName: string | null;
  accountHolder: string | null;
  accountNumber: string | null;
  branchCode: string | null;
  accountType: string | null;
  swift: string | null;
  reference: string | null;
}

export const ACCOUNT_TYPES = ['Cheque / Current', 'Savings', 'Transmission', 'Business'] as const;

/** Database column for each field. */
export const BANK_COLUMNS: Record<keyof SupplierBanking, string> = {
  bankName: 'bank_name',
  accountHolder: 'bank_account_holder',
  accountNumber: 'bank_account_number',
  branchCode: 'bank_branch_code',
  accountType: 'bank_account_type',
  swift: 'bank_swift',
  reference: 'bank_reference',
};

/** A 400: what was entered can't be right. */
const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

const text = (v: unknown) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, 120) : null;
};

/** Cleans and checks what was entered. Throws a plain-language message when something can't be right. */
export function normalizeBanking(input: any): SupplierBanking {
  const b: SupplierBanking = {
    bankName: text(input?.bankName),
    accountHolder: text(input?.accountHolder),
    accountNumber: text(input?.accountNumber)?.replace(/[\s-]/g, '') ?? null,
    branchCode: text(input?.branchCode)?.replace(/[\s-]/g, '') ?? null,
    accountType: text(input?.accountType),
    swift: text(input?.swift)?.replace(/\s/g, '').toUpperCase() ?? null,
    reference: text(input?.reference),
  };
  if (b.accountNumber && !/^[A-Za-z0-9]{4,34}$/.test(b.accountNumber)) {
    throw bad('The account number should be 4 to 34 letters or digits (an IBAN is fine).');
  }
  if (b.branchCode && !/^\d{4,8}$/.test(b.branchCode)) throw bad('The branch code should be digits only (usually 6).');
  if (b.swift && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(b.swift)) throw bad('A SWIFT/BIC code is 8 or 11 letters and digits, e.g. FIRNZAJJ.');
  return b;
}

export function fromRow(r: any): SupplierBanking {
  const b = {} as SupplierBanking;
  for (const [k, col] of Object.entries(BANK_COLUMNS)) (b as any)[k] = r?.[col] ?? null;
  return b;
}

export const hasBanking = (b: SupplierBanking) => Object.values(b).some(Boolean);

/** Which fields differ (to log a change). */
export function changedFields(before: SupplierBanking, after: SupplierBanking): Array<keyof SupplierBanking> {
  return (Object.keys(BANK_COLUMNS) as Array<keyof SupplierBanking>).filter((k) => (before[k] ?? null) !== (after[k] ?? null));
}

/** "••••6789": enough to tell accounts apart without showing the number. */
export function maskAccount(n: string | null | undefined): string {
  if (!n) return '';
  return n.length <= 4 ? n : `••••${n.slice(-4)}`;
}
