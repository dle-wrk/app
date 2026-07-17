import { Item, Transaction, Supplier, ProductionKit, SystemConfig, Project, BOMItem, PickPlaceItem } from './types';

export const CSV_HEADER = `serial_number;name;description;value;size;package;tolerance;type;footprint;comment;datasheet;project;packaging;stock;qty_per_pcb;low_stock_lvl;current_cost_dollar;bulk_price_usd;bulk_price_zar;last_order_qty;last_order_date;status;man_pn_1;man_pn_2;man_pn_3;man_pn_4;man_pn_5;sup_pn_1;sup_pn_2;sup_pn_3;sup_pn_4;sup_pn_5;weblink_1;weblink_2;weblink_3;weblink_4;weblink_5`;

export function itemToCsvRow(item: Item): string {
  const e = (v: string) => v.includes(';') || v.includes('\n') ? `"${v}"` : v;
  const manPns = item.manPns || [];
  const supPns = item.supPns || [];
  const weblinks = item.weblinks || [];
  return [
    item.partNumber,
    e(item.name),
    e(item.description || ''),
    e(item.value || ''),
    e(item.size || ''),
    e(item.packageName || ''),
    e(item.tolerance || ''),
    e(item.itemType || ''),
    e(item.footprint || ''),
    e(item.comment || ''),
    e(item.datasheet || ''),
    e(item.project || ''),
    e(item.packaging || ''),
    item.stockLevel,
    '',
    item.lowStockLvl ?? 50,
    item.price,
    item.bulkPriceUsd || 0,
    item.bulkPriceZar || 0,
    item.lastOrderQty ?? 0,
    item.lastOrderDate || '',
    item.status || 'ACTIVE',
    e(manPns[0] || ''),
    e(manPns[1] || ''),
    e(manPns[2] || ''),
    e(manPns[3] || ''),
    e(manPns[4] || ''),
    e(supPns[0] || ''),
    e(supPns[1] || ''),
    e(supPns[2] || ''),
    e(supPns[3] || ''),
    e(supPns[4] || ''),
    e(weblinks[0] || ''),
    e(weblinks[1] || ''),
    e(weblinks[2] || ''),
    e(weblinks[3] || ''),
    e(weblinks[4] || ''),
  ].join(';');
}

export function generateCSVFromItems(items: Item[]): string {
  return CSV_HEADER + items.map(itemToCsvRow).join('\n');
}

// BOM and Pick&Place parsers kept for static embedded data
const RAW_PP_BOM_CSV = `project_name;stock_code;comment;description;designator;footprint;libref;quantity
3;CAP-018;100uF, 35V;Polarized Capacitor;C1, C6;CAP ELV D;Cap Pol;2
3;CAP-009;100N 100V 10% X7R;0603 0.90mm 100N 100V 10% X7R;C2, C3, C4, C8;CAPC1608X09N;C0603 100N 100V 10% X7R;4
2;CAP-032;10uF;;C1, C2, C17, C18, C19;C_0603;Capacitor;5
1;CAP-009;100nF;Capacitor;C17, C18, C19, C6, C7;C0603;Cap;5`;

const RAW_DB_BOM_CSV = `project_name;internal_stock_number;qty_per_unit;ref_des
1;CAP-019;1;C34
1;RES-033;18;R135, R137, R138
1;CAP-009;21;C17, C18, C19, C6, C7`;

export function parsePPBoms(): PickPlaceItem[] {
  const lines = RAW_PP_BOM_CSV.trim().split('\n');
  const result: PickPlaceItem[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(';');
    if (cols.length < 8) continue;
    result.push({
      id: `PP-${i}-${cols[1]}`,
      projectId: parseInt(cols[0]) || 1,
      stockCode: cols[1] || '',
      comment: cols[2] || '',
      description: cols[3] || '',
      designator: cols[4] || '',
      footprint: cols[5] || '',
      libref: cols[6] || '',
      quantity: parseInt(cols[7]) || 1,
    });
  }
  return result;
}

export function parseDBBoms(): BOMItem[] {
  const lines = RAW_DB_BOM_CSV.trim().split('\n');
  const result: BOMItem[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(';');
    if (cols.length < 4) continue;
    result.push({
      id: `BOM-${i}-${cols[1]}`,
      projectId: parseInt(cols[0]) || 1,
      stockCode: cols[1] || '',
      comment: '',
      description: '',
      designator: cols[3] || '',
      footprint: '',
      libref: '',
      quantity: parseInt(cols[2]) || 1,
    });
  }
  return result;
}

// Empty placeholders - populated from Neon DB on app mount
export const INITIAL_ITEMS: Item[] = [];
export const INITIAL_PROJECTS: Project[] = [];
export const INITIAL_SUPPLIERS: Supplier[] = [];
export const INITIAL_PP_BOM_ITEMS: PickPlaceItem[] = parsePPBoms();
export const INITIAL_BOM_ITEMS: BOMItem[] = parseDBBoms();

export const INITIAL_TRANSACTIONS: Transaction[] = [
  {
    id: 'TRX-9821',
    itemPartNumber: 'ESP32',
    itemName: 'ESP32 Transceiver Module',
    type: 'INBOUND',
    qtyChange: 250,
    reference: 'PO-882910-A',
    performedBy: 'Alexander Wright',
    performedByAvatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuD0_EYGPOE6kTvh7y2delA9HonD0T7oWPUppR8ZSXEaOciXPkCacuJ0pqCHkeWDEe19lPJwuSKU_cN3LEGUKuhGesoPz4KXoLh-ay0p_1OxYur0IP-e8NpeCzB8VUDXMs0K2i014V73ZbQvkpioC98lBifcXbNv0kRGn5iWAI_cJSd2HdRqt0tyYWAZtVe4YAmUyQwwnq-LbvxLYQB9-KWZN1xBFX9ImCue1HyaUYtO-liGB266NP5EVAVa1c8HFwaW1_j3wVnJ7mc',
    dateTime: 'Jun 10, 05:22',
  },
  {
    id: 'TRX-9819',
    itemPartNumber: 'CAP-009',
    itemName: '100nF Ceramic Capacitor',
    type: 'OUTBOUND',
    qtyChange: -1202,
    reference: 'SO-44512-B',
    performedBy: 'M. Smith',
    performedByAvatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuB3xys8yCygeLd5U4OgGORR0fXudpbDwQUDvNhyYtAjsEDJ4Mw_ScRHHPCPZs37ZcfBnhCLN_sg1Wc_vBYq0Bzxm29HvpO5FUH2I1ndC3SRaeIZRuMp-gF4lbKrxYDhXUD0AOTr3h8aoL0Pd5ojNtEOmjfIy_veFcWDdIbaLWGM-d5soI4xT3xq3QHxlb1eTfaWJKQMTYMe_zxh15h4UzE1c0-hjkEaC_nh6h2wDEwWYH1PtMygyqcF6Wi7k5iTQeZy9_1nbVymQYM',
    dateTime: 'Jun 10, 03:45',
  },
  {
    id: 'TRX-9818',
    itemPartNumber: 'ANT-001',
    itemName: 'Fiberglass Antenna',
    type: 'INBOUND',
    qtyChange: 20,
    reference: 'PO-882908-F',
    performedBy: 'Alexander Wright',
    performedByAvatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuB0OOpXRySvOsM679on3CuzpFeSyyRtOFApeYhuL69DgAQvSG1jURif5vqo-5GOiegdQf3B1U3y4kaxzzY3waR1yV5eVvoAo5BzXhygtBsUSb4U0NdeeANgjneamJwrtbSXJqBIQBS_CPxvhNZkqnAEvCLMRHoX9LoczbPykY1AmHhh25wjr2JGut35kFvFp8_BQ7XwM3qu14mq2u_Sn2t-6HQTRIxU_nw0nCg-e3aV9nIV2a2IeL5HgK5oorDTUphsidqezksVa5s',
    dateTime: 'Jun 09, 11:10',
  },
];

export const INITIAL_PRODUCTION_KITS: ProductionKit[] = [
  {
    kitId: 'KT-9001-A',
    skuReference: 'TCU06 PCB Assemble',
    status: 'READY',
    qtyAvailable: 450,
    assemblyLine: 'LINE_A_NORTH',
    lastUpdated: '2026-06-10 04:32',
  },
  {
    kitId: 'KT-9002-B',
    skuReference: 'WLD01 Assembly',
    status: 'STAGING',
    qtyAvailable: 120,
    assemblyLine: 'LINE_B_SOUTH',
    lastUpdated: '2026-06-10 02:15',
  },
  {
    kitId: 'KT-9015-X',
    skuReference: 'NCU04 RF Breakout',
    status: 'BLOCKED',
    qtyAvailable: 0,
    assemblyLine: 'OFFLINE',
    lastUpdated: '2026-06-09 09:00',
  },
];

export const INITIAL_SYSTEM_CONFIG: SystemConfig = {
  appName: 'Tracklab Nexus',
  defaultLanguage: 'English',
  timezone: 'UTC (Coordinated Universal Time)',
  connectionString: '',
  syncFrequency: 'LIVE',
  autoStatusSync: true,
  lowStockAlert: true,
  systemLatencyWarning: true,
  transactionSummaries: true,
  visualTheme: 'dark',
  highDensityMode: true,
  primaryTint: '#2563EB',
};
