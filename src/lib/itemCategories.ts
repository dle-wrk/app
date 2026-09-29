// Canonical list of inventory categories. Both the Add SKU form (in
// App.tsx) and the Edit form (in ItemDetailModal.tsx) render from
// this array so a new category never has to be added twice — one
// import keeps the two dropdowns in lock-step.
//
// The Edit form additionally lets an operator type a fresh category
// inline ("+ Add") which lives only in that modal's local state and
// is written back on save. That flow is unchanged.
export const ITEM_CATEGORIES = [
  'Resistor',
  'Capacitor',
  'IC (Integrated Circuit)',
  'Diode',
  'Transistor',
  'Connector',
  'LED',
  'Inductor',
  'Crystal / Oscillator',
  'Button / Tactile Switch',
  'Sensors',
  'Hardware / Other',
  'Antenna',
  'Sub-Assembly',
  'Battery',
  'Box',
  'Bracket',
  'Kit',
  'Buzzer',
  'Cable / Flylead',
  'Coax',
  'Jumper',
  'Fibre',
  'Ethernet',
  'Product',
  'Consumable',
  'Tool',
] as const;
