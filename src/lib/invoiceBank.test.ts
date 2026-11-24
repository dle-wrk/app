import { describe, expect, it } from 'vitest';
import { bankFromText, describeBank, invoiceBank, tidyInvoiceBank } from './invoiceBank';

// As Tracklab's own reader read three real invoices (misreads and all).
const COMMUNICA = 'CABLE TIE 388MM X 7,8MM T120R X31 J 1 BLACK | Our Banking Detalles Sub-Total R2 268,90 Lommunica Vv) Ld : ) : a/c Mo. 1084804371 ; Extra Charges: R0,00 VAT: R340,34 [edb ank, Business | Round Off: -R0O,04 Banking Midrarid : : Brench Code. 186786 Grand Teta: __R2 609,20 south African Rand Your A/c No.: TK000203 Sales';
const ACDC = 'Tel: 012 003 2030 | EVERYTHING ELECTRICAL cen.accounts@acdcexpress.com ACDC Express Centurion 4440264614 CRN:2010/074822/ Invoice Date Total Paid (ZAR): R259.35 Outstanding (ZAR): R0.00 Account name: | Bank Name: Branch: Account Number: ACDC Express Centurion Nedbank 128842 1028893787 Terms and Conditions: Cash Sales: May be paid by cash or approved credit card.';
const MANTECH = 'Billed To TRACK-LAB Deliver To TRACK LAB Account Numbe! TRAST 270 ROAN CRESCENT CORPORATE PARK NORTH MIDRAND 076 452 5064 MANTECH ELECTRONICS (PTY) LTD TELEPHONE BANKING DETAILS Company Registration # - 2001 / 004235 / 07 JHB 011 493 9307 Account Number 253 109 051 VAT Registration # 4850 196 108 CPT 02) 535 3150 Aank and Branch | Standard Bank - The Glen - antech.co.zs KZN 03) 309 7686 Branch Code 051 001';

describe('bank details on an invoice', () => {
  it('reads them off real invoices', () => {
    expect(bankFromText(COMMUNICA, ['4090109978'])).toEqual({ bankName: 'Nedbank', accountNumber: '1084804371', branchCode: '186786', accountType: 'Business', swift: null });
    expect(bankFromText(ACDC, ['4440264614'])).toEqual({ bankName: 'Nedbank', accountNumber: '1028893787', branchCode: '128842', accountType: null, swift: null });
    expect(bankFromText(MANTECH, ['4850196108'])).toEqual({ bankName: 'Standard Bank', accountNumber: '253109051', branchCode: '051001', accountType: null, swift: null });
  });
  it("finds them past the buyer's own account box, far up the page", () => {
    const page = `Account Number TRAST ${'1 x CABLE TIE BLACK 12.00 '.repeat(25)} ${MANTECH.slice(MANTECH.indexOf('BANKING'))}`;
    expect(bankFromText(page)?.accountNumber).toBe('253109051');
  });
  it("never takes the buyer's account, the VAT number, or a number with no bank beside it", () => {
    expect(bankFromText('Your A/c No.: 12345678 Total R100')).toBeNull();
    expect(bankFromText('Bank details: Account number 4090109978', ['4090109978'])).toBeNull();
    expect(bankFromText('Account number 1084804371')).toBeNull();
    expect(bankFromText('Tax invoice. Thank you for your business')).toBeNull();
  });
  it("takes a reader's own bank object when it has a usable account number", () => {
    expect(tidyInvoiceBank({ bankName: ' FNB ', accountNumber: '6201 234 5678', branchCode: '250 655', swift: 'firnzajj' }))
      .toEqual({ bankName: 'FNB', accountNumber: '62012345678', branchCode: '250655', accountType: null, swift: 'FIRNZAJJ' });
    expect(tidyInvoiceBank({ bankName: 'FNB' })).toBeNull();
    expect(invoiceBank({ text: MANTECH, supplierVatNumber: '4850196108' })?.accountNumber).toBe('253109051');
    expect(describeBank(bankFromText(COMMUNICA))).toBe('Nedbank · a/c 1084804371 · branch 186786 · Business');
  });
});
