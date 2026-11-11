// Groups rows by the calendar month of a date field, newest month first,
// for the collapsible month sections in document lists (bills, …).
// Rows keep their incoming order inside a month; rows with no usable date
// land in a final "No date" group.

export interface MonthGroup<T> {
  key: string;   // "2026-11", or "none"
  label: string; // "November 2026"
  items: T[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function groupByMonth<T>(rows: T[], dateOf: (row: T) => string | null | undefined): MonthGroup<T>[] {
  const groups = new Map<string, MonthGroup<T>>();
  for (const row of rows) {
    const m = /^(\d{4})-(\d{2})/.exec(String(dateOf(row) || ''));
    const month = m ? Number(m[2]) : 0;
    const key = m && month >= 1 && month <= 12 ? `${m[1]}-${m[2]}` : 'none';
    let g = groups.get(key);
    if (!g) {
      g = { key, label: key === 'none' ? 'No date' : `${MONTHS[month - 1]} ${m![1]}`, items: [] };
      groups.set(key, g);
    }
    g.items.push(row);
  }
  return [...groups.values()].sort((a, b) =>
    a.key === 'none' ? 1 : b.key === 'none' ? -1 : b.key.localeCompare(a.key));
}
