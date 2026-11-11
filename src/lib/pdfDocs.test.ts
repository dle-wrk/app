import { describe, expect, it } from 'vitest';
import { docFileName, fitInto } from './pdfDocs';

describe('naming a saved bill PDF', () => {
  it('is the bill number then the supplier, in capitals with underscores', () => {
    expect(docFileName('BILL-2026-0009', 'ACDC EXPRESS')).toBe('BILL-2026-0009_ACDC_EXPRESS');
    expect(docFileName('BILL-2026-0003', 'New World Menlyn')).toBe('BILL-2026-0003_NEW_WORLD_MENLYN');
  });

  it('drops characters a file name cannot hold, and copes with no supplier', () => {
    expect(docFileName('BILL-2026-0011', 'Smith & Sons (Pty) Ltd.')).toBe('BILL-2026-0011_SMITH_AND_SONS_PTY_LTD');
    expect(docFileName('BILL-2026-0012', 'Café/Bistro: "Nº1"')).toBe('BILL-2026-0012_CAFE_BISTRO_NO1');
    expect(docFileName('BILL-2026-0013', null)).toBe('BILL-2026-0013');
    expect(docFileName('BILL-2026-0014', '   ')).toBe('BILL-2026-0014');
  });
});

describe('fitting an attachment onto a PDF page', () => {
  it('keeps the shape: a tall receipt fills the height, a wide one the width', () => {
    expect(fitInto(1000, 3000, 180, 260)).toEqual({ w: 260 / 3, h: 260 });
    expect(fitInto(4000, 1000, 180, 260)).toEqual({ w: 180, h: 45 });
  });

  it('grows a small image to fill the box and copes with a missing size', () => {
    expect(fitInto(90, 130, 180, 260)).toEqual({ w: 180, h: 260 });
    expect(fitInto(0, 0, 180, 260)).toEqual({ w: 180, h: 260 });
  });
});
