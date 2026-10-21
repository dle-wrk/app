// Footprints for items that have none, read from what the item already says
// (its Size and Package fields, then its description and name): "CHIP LED
// 0402 RED SMD" is 0402, "MOSFET 100V 13A TO-252" is TO-252. Kit Booking and
// the BOM reel picker only treat two parts as equivalent (T2) when their
// footprints match (./kitMatch), so a blank footprint keeps a part out.
//
// Only a single, clear package is offered: none when the text names two, and
// never a size followed by METRIC ("0603 METRIC" is imperial 0201). The name
// is written as the footprints already in use spell it where one matches
// ("SOT23" -> "SOT-23").
// The rules (no database here); the routes are in ./footprintFill.

export interface FootprintItem { serial_number: string; name?: string | null; description?: string | null; size?: string | null; package?: string | null; footprint?: string | null }
export interface FootprintProposal { serialNumber: string; name: string; footprint: string; from: string }

const BLANK = /^(|N\/?A|NA|-|NONE|TBD|UNKNOWN)$/i;
export const hasNoFootprint = (fp: unknown) => BLANK.test(String(fp ?? '').trim());

// Imperial chip sizes; a 4-digit number is only taken as one of these.
const CHIP = ['01005', '0201', '0402', '0603', '0805', '1008', '1206', '1210', '1806', '1812', '2010', '2220', '2512', '2920'];

// [pattern, canonical name]. Longer forms first so SOT-23-5 wins over SOT-23.
const PACKAGES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/\bSOT-?23-?([356])L?\b/i, (m) => `SOT-23-${m[1]}`],
  [/\bSOT-?(223|323|363|353|563|666|89|143|23)\b/i, (m) => `SOT-${m[1]}`],
  [/\bSOD-?(123F?|323F?|523|923|80)\b/i, (m) => `SOD-${m[1].toUpperCase()}`],
  [/\bDO-?214(A[ABC])\b/i, (m) => `DO-214${m[1].toUpperCase()}`],
  [/\bDO-?(41|35|201AD|15)\b/i, (m) => `DO-${m[1].toUpperCase()}`],
  [/\bTO-?(252|263|220|247|92|126|251|3P)\b/i, (m) => `TO-${m[1].toUpperCase()}`],
  [/\bD2PAK\b/i, () => 'D2PAK'],
  [/\bDPAK\b/i, () => 'DPAK'],
  [/\b(SOIC|SOP|SSOP|TSSOP|MSOP|QFN|DFN|LQFP|TQFP|QFP|VQFN|WSON|SON|BGA|DIP|PDIP)-?(\d{1,3})\b/i, (m) => `${m[1].toUpperCase()}-${m[2]}`],
];

const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The packages a text names, canonical; a size followed by METRIC is skipped. */
export function packagesIn(text: string): string[] {
  const found = new Set<string>();
  const t = String(text ?? '');
  for (const size of CHIP) {
    // On its own (not inside a part number or a value like 1206.5), and not
    // a metric size ("0603 METRIC") or a length ("1206 MM").
    const re = new RegExp(`(?<![A-Z0-9.,])${size}(?![0-9.,])(?!\\s*\\(?\\s*METRIC)(?!\\s*MM\\b)`, 'i');
    if (re.test(t)) found.add(size);
  }
  for (const [re, name] of PACKAGES) {
    const m = t.match(re);
    if (m) found.add(name(m));
  }
  // DPAK is TO-252 and D2PAK is TO-263: one package, not two.
  if (found.has('DPAK') && found.has('TO-252')) found.delete('TO-252');
  if (found.has('D2PAK') && found.has('TO-263')) found.delete('TO-263');
  // SOT-23-5 also matched as SOT-23.
  for (const f of [...found]) if (/^SOT-23-\d$/.test(f)) found.delete('SOT-23');
  return [...found];
}

/** What to fill for one item, or null when its fields don't name exactly one package. */
export function proposeFootprint(item: FootprintItem, inUse: string[] = []): FootprintProposal | null {
  if (!hasNoFootprint(item.footprint)) return null;
  const sources: Array<[string, string | null | undefined]> = [['Size', item.size], ['Package', item.package], ['description', item.description], ['name', item.name]];
  for (const [label, text] of sources) {
    if (!text || hasNoFootprint(text)) continue;
    const found = packagesIn(text);
    if (found.length > 1) return null; // names two: a person decides
    if (found.length === 1) {
      // As already spelled: the same name, else the one footprint in use that
      // contains it ("SOT-23-5" -> "SOT-23-5L", "DO-214AB" -> "SMC(DO-214AB)").
      const k = alnum(found[0]);
      const containing = /^\d+$/.test(k) ? [] : inUse.filter((f) => alnum(f).includes(k));
      const spelled = inUse.find((f) => alnum(f) === k) ?? (containing.length === 1 ? containing[0] : found[0]);
      return { serialNumber: item.serial_number, name: String(item.name ?? ''), footprint: spelled, from: label };
    }
  }
  return null;
}

