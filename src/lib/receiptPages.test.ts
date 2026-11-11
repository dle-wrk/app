import { describe, expect, it } from 'vitest';
import { dataUrlToBlob, receiptPages } from './receiptPages';

const a = 'data:image/jpeg;base64,/9j/AA==';
const b = 'data:image/png;base64,iVBORw0=';

describe('receipt pages', () => {
  it('reads one page (a bare data URL) and several pages (a JSON array)', () => {
    expect(receiptPages(a)).toEqual([a]);
    expect(receiptPages(JSON.stringify([a, b]))).toEqual([a, b]); // was used whole as an image address before
  });

  it('ignores nothing-there, broken JSON and anything that is not an image', () => {
    expect(receiptPages(null)).toEqual([]);
    expect(receiptPages('')).toEqual([]);
    expect(receiptPages('[not json')).toEqual([]);
    expect(receiptPages(JSON.stringify([a, 'javascript:alert(1)', 5]))).toEqual([a]);
    expect(receiptPages('https://example.com/x.jpg')).toEqual([]);
  });

  it('turns a page into a blob of the right type, to open in its own tab', async () => {
    const blob = dataUrlToBlob(a);
    expect(blob.type).toBe('image/jpeg');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0x00]));
  });
});
