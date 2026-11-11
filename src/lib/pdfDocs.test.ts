import { describe, expect, it } from 'vitest';
import { fitInto } from './pdfDocs';

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
