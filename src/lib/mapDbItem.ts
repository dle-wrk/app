import { Item } from '../types';

// Maps a raw inventory row from the API (serial_number, stock, man_pn_1, ...)
// onto the frontend Item shape (partNumber, stockLevel, manufacturer, ...).
// Every place that refetches /api/items MUST run rows through this — putting
// raw rows into items state renders the whole app with undefined fields.
export function mapDbRowToItem(record: any): Item {
  const partNumber = record['serial_number'] || '';
  const stockLevel = parseInt(record['stock'] || '0', 10) || 0;
  const lowStockLvl = parseInt(record['low_stock_lvl'] || '50', 10) || 50;
  const price = parseFloat(record['current_cost_dollar'] || record['bulk_price_usd'] || '0') || 0.05;

  // Use the database 'type' as primary category, fallback to SKU prefix only if missing
  let category = record['type'];
  if (!category || category === 'Components' || category === 'Unknown') {
    if (partNumber.startsWith('ANT-')) category = 'Antennas';
    else if (partNumber.startsWith('CAP-')) category = 'Capacitors';
    else if (partNumber.startsWith('RES-')) category = 'Resistors';
    else if (partNumber.startsWith('CHP-')) category = 'ICs';
    else if (partNumber.startsWith('CON-')) category = 'Connectors';
    else if (partNumber.startsWith('LED')) category = 'LEDs';
    else if (partNumber.startsWith('TRA-')) category = 'Transistors';
    else if (partNumber.startsWith('ZEN-')) category = 'Zeners';
    else if (partNumber.startsWith('DIO-')) category = 'Diodes';
    else if (partNumber.startsWith('TUL-')) category = 'Tools';
    else if (partNumber.startsWith('ASS-')) category = 'Sub-Assemblies';
    else if (partNumber.startsWith('BAT-')) category = 'Batteries';
    else category = category || 'Components';
  }

  let status: any = 'ACTIVE';
  if (stockLevel === 0) status = 'BOOKED OUT';
  else if (stockLevel < lowStockLvl) status = 'INACTIVE';
  if (record['description']?.toLowerCase().includes('discontinued')) status = 'DISCONTINUED';

  const manPns = [record['man_pn_1'], record['man_pn_2'], record['man_pn_3'], record['man_pn_4'], record['man_pn_5']].filter(v => !!v && String(v).trim() !== '');
  const supPns = [record['sup_pn_1'], record['sup_pn_2'], record['sup_pn_3'], record['sup_pn_4'], record['sup_pn_5']].filter(v => !!v && String(v).trim() !== '');
  const weblinks = [record['weblink_1'], record['weblink_2'], record['weblink_3'], record['weblink_4'], record['weblink_5']].filter(v => !!v && String(v).trim() !== '');

  return {
    partNumber,
    name: record['name'] || 'Unnamed Item',
    description: record['description'] || '',
    manufacturer: manPns[0] || record['manufacturer'] || 'Generic',
    supplier: supPns[0] || record['supplier'] || 'N/A',
    stockLevel,
    price,
    category,
    status,
    value: record['value'] || '',
    size: record['size'] || '',
    packageName: record['package'] || '',
    tolerance: record['tolerance'] || '',
    itemType: record['type'] || '',
    footprint: record['footprint'] || '',
    comment: record['comment'] || '',
    datasheet: record['datasheet'] || '',
    project: record['project'] || '',
    packaging: record['packaging'] || '',
    lowStockLvl,
    bulkPriceUsd: parseFloat(record['bulk_price_usd'] || '0') || undefined,
    bulkPriceZar: parseFloat(record['bulk_price_zar'] || '0') || undefined,
    lastOrderQty: parseInt(record['last_order_qty'] || '0', 10) || undefined,
    lastOrderDate: record['last_order_date'] || '',
    manPns: manPns.length ? manPns : undefined,
    supPns: supPns.length ? supPns : undefined,
    weblinks: weblinks.length ? weblinks : undefined,
  };
}

// Rows can arrive as a plain array (GET /api/items) or wrapped ({ data: [...] }
// when paginated). Normalize either shape and drop malformed rows.
export function mapDbRowsToItems(payload: any): Item[] {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return rows.filter((r: any) => r && r['serial_number']).map(mapDbRowToItem);
}
