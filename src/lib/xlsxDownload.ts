// One Excel workbook from a list of sheets (rows of cells, column widths),
// downloaded in the browser. Shared by the Kit Booking preset export and the
// order files' workbook. Sheet names are made safe for Excel.

import type { Sheet } from './kitShortageWorkbook';
import { safeSheetNames } from './kitShortageWorkbook';

/** The workbook as bytes (also used by the tests to read it back). */
export async function workbookBytes(sheets: Sheet[]): Promise<ArrayBuffer> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const names = safeSheetNames(sheets.map((s) => s.name));
  sheets.forEach((sh, i) => {
    const ws = XLSX.utils.aoa_to_sheet(sh.rows);
    ws['!cols'] = sh.widths.map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, names[i]);
  });
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
}

export async function downloadWorkbook(sheets: Sheet[], filename: string): Promise<void> {
  const blob = new Blob([await workbookBytes(sheets)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
