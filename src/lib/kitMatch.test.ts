import { describe, expect, it } from 'vitest';
import { itemColour, matchTier } from './kitMatch';
import { detectLedSwatch } from './ledColor';

// The LED rows as they are in stock (Colour field, description).
const led = (serial_number: string, color: string, description: string, footprint = '0603') => ({ serial_number, name: 'LED', footprint, color, description });
const LED005 = led('LED-005', 'orange', '20MA 315MCD COLORLESS TRANSPARENT LENS 600NM~610NM POSITIVE STICK ORANGE');
const LED006 = led('LED-006', '', '20MA 315MCD COLORLESS TRANSPARENT LENS 600NM~610NM POSITIVE STICK ORANGE');
const LED002 = led('LED-002', 'yellow', '20MA 450MCD COLORLESS TRANSPARENT LENS 585NM~595NM POSITIVE STICK YELLOW');
const LED008 = led('LED-008', 'green', 'YELLOW GREEN 575NM LED INDICATION - DISCRETE 2.2V 0603');
const LED003 = led('LED-003', 'green', '25MA 60MCD 570NM~575NM YELLOW-GREEN 120 55MW 2.2V 0603 LED INDIC');
const LED004 = led('LED-004', 'red', '20MA 225MCD COLORLESS TRANSPARENT LENS 620NM~630NM RED');
const LED012 = led('LED-012', 'orange', 'CHIP LED 0402 ORANGE SMD', '');
const none = new Set<string>();

describe('T2 for an LED is the same Name + Footprint + Colour', () => {
  it('offers the other orange 0603 as T2 and drops the yellow and yellow-green ones to T3 (LED-005)', () => {
    expect(matchTier(LED005, LED005, none).tier).toBe(1);
    expect(matchTier(LED005, LED006, none)).toEqual({ tier: 2, note: 'Equivalent — same Name + Footprint + Colour' });
    expect(matchTier(LED005, LED002, none)).toEqual({ tier: 3, note: 'Same Name + Footprint, different colour (Yellow, not Orange) — verify' });
    expect(matchTier(LED005, LED008, none).tier).toBe(3);
    expect(matchTier(LED005, LED012, none)).toEqual({ tier: 3, note: 'Same Name, footprint differs — verify' });
  });

  it('reads the finer shade from the description, so yellow-greens match each other and not green', () => {
    expect([LED005, LED006, LED002, LED008, LED003, LED004].map(itemColour)).toEqual(['Orange', 'Orange', 'Yellow', 'Yellow-green', 'Yellow-green', 'Red']);
    expect(matchTier(LED008, LED003, none).tier).toBe(2);
    expect(itemColour(led('LED-007', 'green', 'PMNT ROUND GREEN LED PILOT LIGHT'))).toBe('Green');
  });

  it('a "colorless lens" is not a white LED', () => {
    expect(detectLedSwatch({ name: 'LED', description: LED004.description })?.label).toBe('Red');
    expect(detectLedSwatch({ name: 'LED', description: 'COLORLESS 0603' })?.label).toBe('White');
  });

  it('an unknown colour against a known one is not equivalent; parts without colour match on Name + Footprint', () => {
    expect(matchTier(LED005, led('LED-099', '', 'CHIP LED 0603'), none).tier).toBe(3);
    const cap = (serial_number: string) => ({ serial_number, name: '100nF 50V', footprint: '0603', color: '', description: 'MLCC X7R' });
    expect(matchTier(cap('CAP-001'), cap('CAP-002'), none)).toEqual({ tier: 2, note: 'Equivalent — same Name + Footprint' });
  });

  it('an approved alternative stays T2 whatever its colour', () => {
    expect(matchTier(LED005, LED002, new Set(['LED-002'])).tier).toBe(2);
  });
});
