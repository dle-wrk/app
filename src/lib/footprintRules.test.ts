import { describe, expect, it } from 'vitest';
import { packagesIn, proposeFootprint } from './footprintRules';

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
