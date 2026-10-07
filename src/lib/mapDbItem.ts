import { Item } from '../types';
import { preferredSupplier } from './partNumbers';

// Maps a raw inventory row from the API (serial_number, stock, man_pn_1, ...)
// onto the frontend Item shape (partNumber, stockLevel, manufacturer, ...).
// Every place that refetches /api/items MUST run rows through this — putting
// raw rows into items state renders the whole app with undefined fields.
export function mapDbRowToItem(record: any): Item {
  const partNumber = record['serial_number'] || '';
  const stockLevel = parseInt(record['stock'] || '0', 10) || 0;
  const lowStockLvl = parseInt(record['low_stock_lvl'] || '50', 10) || 50;
  const price = parseFloat(record['current_cost_dollar'] || record['bulk_price_usd'] || '0') || 0;

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

  // Status is a user-controlled lifecycle flag that lives in the DB — it must NOT
  // be derived from stock. Deriving it here silently discarded whatever the user
  // saved (every item below its low-stock level reappeared as INACTIVE on reload).
  // Stock health is a separate dimension with its own filter; keep them separate.
  const rawStatus = String(record['status'] ?? '').trim().toUpperCase();
  const status: Item['status'] =
    rawStatus === 'ACTIVE' || rawStatus === 'INACTIVE' || rawStatus === 'BOOKED OUT' || rawStatus === 'DISCONTINUED'
      ? rawStatus
      : 'ACTIVE';

  const manPns = [record['man_pn_1'], record['man_pn_2'], record['man_pn_3'], record['man_pn_4'], record['man_pn_5']].filter(v => !!v && String(v).trim() !== '');
  const supPns = [record['sup_pn_1'], record['sup_pn_2'], record['sup_pn_3'], record['sup_pn_4'], record['sup_pn_5']].filter(v => !!v && String(v).trim() !== '');
  const weblinks = [record['weblink_1'], record['weblink_2'], record['weblink_3'], record['weblink_4'], record['weblink_5']].filter(v => !!v && String(v).trim() !== '');

  return {
    partNumber,
    name: record['name'] || 'Unnamed Item',
    description: record['description'] || '',
    manufacturer: manPns[0] || record['manufacturer'] || 'Generic',
    // The supplier field, else a supplier name the item form used to keep in
    // the supplier part-number fields; never a part number (see ./partNumbers).
    supplier: preferredSupplier(record['supplier'], supPns) || 'N/A',
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
    color: record['color'] || '',
  };
}

// The reverse: an Item as the inventory columns the item routes accept
// (create, PUT, bulk upsert). Undefined and null fields are left out.
export function mapItemToPayload(item: Item): Record<string, any> {
  const payload: Record<string, any> = {
    serial_number: item.partNumber,
    name: item.name,
    description: item.description,
    value: item.value,
    size: item.size,
    package: item.packageName,
    tolerance: item.tolerance,
    type: item.itemType || item.category,
    footprint: item.footprint,
    comment: item.comment,
    datasheet: item.datasheet,
    project: item.project,
    packaging: item.packaging,
    color: item.color || '',
    stock: item.stockLevel,
    low_stock_lvl: item.lowStockLvl,
    current_cost_dollar: item.price,
    bulk_price_usd: item.bulkPriceUsd,
    bulk_price_zar: item.bulkPriceZar,
    last_order_qty: item.lastOrderQty,
    last_order_date: item.lastOrderDate,
    status: item.status,
    man_pn_1: item.manPns?.[0] || item.manufacturer,
    man_pn_2: item.manPns?.[1] || '',
    man_pn_3: item.manPns?.[2] || '',
    man_pn_4: item.manPns?.[3] || '',
    man_pn_5: item.manPns?.[4] || '',
    // The supplier has its own field. (It used to fill sup_pn_1 when there
    // was no supplier part number, so suppliers were asked for a part called
    // "Digi-Key Corp".)
    supplier: item.supplier && item.supplier.trim().toUpperCase() !== 'N/A' ? item.supplier.trim() : '',
    sup_pn_1: item.supPns?.[0] || '',
    sup_pn_2: item.supPns?.[1] || '',
    sup_pn_3: item.supPns?.[2] || '',
    sup_pn_4: item.supPns?.[3] || '',
    sup_pn_5: item.supPns?.[4] || '',
    weblink_1: item.weblinks?.[0] || '',
    weblink_2: item.weblinks?.[1] || '',
    weblink_3: item.weblinks?.[2] || '',
    weblink_4: item.weblinks?.[3] || '',
    weblink_5: item.weblinks?.[4] || '',
  };
  Object.keys(payload).forEach((k) => (payload[k] === undefined || payload[k] === null) && delete payload[k]);
  return payload;
}

// Rows can arrive as a plain array (GET /api/items) or wrapped ({ data: [...] }
// when paginated). Normalize either shape and drop malformed rows.
export function mapDbRowsToItems(payload: any): Item[] {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return rows.filter((r: any) => r && r['serial_number']).map(mapDbRowToItem);
}
