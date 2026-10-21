import { describe, expect, it } from 'vitest';
import { packageKey, packagesIn, proposeFootprint, spellingGroups } from './footprintRules';

const item = (serial_number: string, description: string, extra: Record<string, string> = {}) => ({ serial_number, name: serial_number, description, footprint: '', ...extra });
const IN_USE = ['0603', '0402', 'SOT-23', 'SOT-23-5L', 'SMC(DO-214AB)', 'DO-214AA (SMB)', 'TO-252', 'DPAK', 'SOT-363'];

describe('filling a missing footprint from what the item says', () => {
  it('reads the package from real descriptions, spelled as the footprints in use', () => {
    const cases: Array<[string, string]> = [
      ['CHIP LED 0402 ORANGE SMD', '0402'],
      ['RES 49,9 OHM 1% 1/10W 0603 100PPM', '0603'],
      ['25 MOHMS 1% 3W CHIP RESISTOR 2512 (6432 METRIC) AUTOMOTIVE', '2512'],
      ['MOSFET 2P-CH 50V 0.13A SOT363', 'SOT-363'],
      ['IC PWR SWITCH N-CHAN 1:1 SOT23-5', 'SOT-23-5L'],
      ['TVS DIODE 28VWM 45.4VC DO-214AB(SMC)', 'SMC(DO-214AB)'],
      ['P-CHANNEL 100V 13A 66W SURFACE MOUNT DPAK(TO-252AA)', 'DPAK'],
      ['MOSFET N-CH 85V 100A TO-252', 'TO-252'],
    ];
    for (const [d, fp] of cases) expect(proposeFootprint(item('X', d), IN_USE)?.footprint, d).toBe(fp);
  });

  it('takes the Size field first, and says where it came from', () => {
    expect(proposeFootprint(item('CHP-050', 'ARM Cortex-M4 MCU', { size: 'LQFP-64' }), IN_USE)).toEqual({ serialNumber: 'CHP-050', name: 'CHP-050', footprint: 'LQFP-64', from: 'Size' });
  });

  it('leaves it when the text names two packages, a metric size, a length, or nothing', () => {
    expect(proposeFootprint(item('X', 'ADAPTER 0603 TO 0805'), IN_USE)).toBeNull();
    expect(packagesIn('CAP 1UF 0603 METRIC')).toEqual([]); // that is imperial 0201
    expect(packagesIn('STANDOFF 1206 MM')).toEqual([]);
    expect(packagesIn('RC0402FR-0710KL')).toEqual([]); // inside a part number
    expect(proposeFootprint(item('TUL-001', 'SIDE CUTTERS 125MM'), IN_USE)).toBeNull();
  });

  it('never replaces a footprint that is set', () => {
    expect(proposeFootprint({ ...item('X', 'CHIP LED 0402'), footprint: '0603' }, IN_USE)).toBeNull();
    expect(proposeFootprint({ ...item('X', 'CHIP LED 0402'), footprint: 'N/A' }, IN_USE)?.footprint).toBe('0402');
  });
});

describe('one package, several spellings', () => {
  const rows = (pairs: Array<[string, number]>) => pairs.flatMap(([fp, n]) => Array.from({ length: n }, (_, i) => ({ serial_number: `${fp}-${i}`, footprint: fp })));

  it('groups the spellings in use, most-used first (your data, 21 Oct)', () => {
    const groups = spellingGroups(rows([
      ['DPAK', 5], ['DPAK-3 (TO-252-3)', 1], ['TO-252', 1], ['SOT-223', 2], ['SOT-223-4', 5], ['SOT-23', 5], ['SOT-23-3 (TO-236)', 2],
      ['SOT-23-5', 1], ['SOT-23-5L', 3], ['SOT-23-6', 2], ['TSOP-6', 1], ['SOT-363', 6], ['SOT323-6L', 1], ['SMA', 5], ['SMA(DO-214AC)', 3],
      ['SOIC-8', 4], ['SOIC8', 1], ['8SOIC', 2], ['SOIC-8-208MIL', 1], ['4-SOIC (0.173, 4.40MM WIDTH)', 2], ['0603', 80], ['SMC(DO-214AB)', 2], ['N/A', 9],
    ]));
    expect(groups.map((g) => [g.package, g.spellings.map((s) => `${s.footprint}:${s.count}`)])).toEqual([
      ['DO-214AC', ['SMA:5', 'SMA(DO-214AC):3']],
      ['SOIC-8', ['SOIC-8:4', '8SOIC:2', 'SOIC8:1']], // not the 208 mil one: it's wider
      ['SOT-223', ['SOT-223-4:5', 'SOT-223:2']],
      ['SOT-23', ['SOT-23:5', 'SOT-23-3 (TO-236):2']],
      ['SOT-23-5', ['SOT-23-5L:3', 'SOT-23-5:1']],
      ['SOT-23-6', ['SOT-23-6:2', 'TSOP-6:1']],
      ['SOT-363', ['SOT-363:6', 'SOT323-6L:1']],
      ['TO-252', ['DPAK:5', 'DPAK-3 (TO-252-3):1', 'TO-252:1']],
    ]);
  });

  it('never puts different packages together', () => {
    expect(packageKey('SOIC-8-208MIL')).toBeNull();
    expect(packageKey('SOT-23-5')).not.toBe(packageKey('SOT-23'));
    expect(packageKey('SOT-23-6')).not.toBe(packageKey('SOT-363'));
    expect(packageKey('TO-263-2')).not.toBe(packageKey('TO-252'));
    expect(packageKey('SMB')).not.toBe(packageKey('SMA'));
  });
});
