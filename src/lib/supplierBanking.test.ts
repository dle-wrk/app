import { describe, expect, it } from 'vitest';
import { changedFields, fromRow, hasBanking, maskAccount, normalizeBanking } from './supplierBanking';

describe('supplier banking details', () => {
  it('tidies what was typed: spaces and dashes out of numbers, SWIFT in capitals, blanks as nothing', () => {
    expect(normalizeBanking({ bankName: '  FNB ', accountHolder: 'ACDC  Express', accountNumber: '6212 345-6789', branchCode: '250 655', swift: 'firnzajj', reference: '', accountType: 'Cheque / Current' }))
      .toEqual({ bankName: 'FNB', accountHolder: 'ACDC Express', accountNumber: '62123456789', branchCode: '250655', accountType: 'Cheque / Current', swift: 'FIRNZAJJ', reference: null });
    expect(hasBanking(normalizeBanking({}))).toBe(false);
  });

  it('refuses numbers that cannot be right, with a 400', () => {
    expect(() => normalizeBanking({ accountNumber: '12' })).toThrow('4 to 34');
    expect(() => normalizeBanking({ accountNumber: '1234;DROP' })).toThrow('4 to 34');
    expect(() => normalizeBanking({ branchCode: 'ABC123' })).toThrow('digits only');
    expect(() => normalizeBanking({ swift: 'FNB' })).toThrow('8 or 11');
    try { normalizeBanking({ swift: 'X' }); } catch (e: any) { expect(e.status).toBe(400); }
    expect(normalizeBanking({ accountNumber: 'GB29NWBK60161331926819', swift: 'NWBKGB2L' }).accountNumber).toBe('GB29NWBK60161331926819'); // an IBAN
  });

  it('spots a change, for the activity log and the "changed recently" warning', () => {
    const before = fromRow({ bank_name: 'FNB', bank_account_number: '62123456789', bank_branch_code: '250655' });
    expect(changedFields(before, normalizeBanking({ bankName: 'FNB', accountNumber: '62123456789', branchCode: '250655' }))).toEqual([]);
    expect(changedFields(before, normalizeBanking({ bankName: 'Capitec', accountNumber: '1500000000', branchCode: '470010' }))).toEqual(['bankName', 'accountNumber', 'branchCode']);
  });

  it('masks an account number to its last four digits in lists and logs', () => {
    expect(maskAccount('62123456789')).toBe('••••6789');
    expect(maskAccount('123')).toBe('123');
    expect(maskAccount(null)).toBe('');
  });
});
