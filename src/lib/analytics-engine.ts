// Analytics engine for the automation / "ML" surface.
//
// Context: the ml_models, demand_forecasts, predictive_orders and
// detected_anomalies tables previously only ever held hand-entered rows — a
// "model" was a name plus a typed-in accuracy (every row said 0.8500 and had
// last_trained_at = NULL). Nothing computed anything.
//
// These functions compute from the real inventory and transaction ledger, and
// deliberately report insufficient-data rather than manufacturing a number.
// Honest confidence matters more than an impressive-looking score: with only a
// handful of movements, a forecast is not trustworthy and says so.

export interface RawTxn {
  itempartnumber?: string; itemPartNumber?: string;
  itemname?: string; itemName?: string;
  qtychange?: number | string; qtyChange?: number | string;
  datetime?: string; dateTime?: string;
  type?: string;
}

export interface RawItem {
  serial_number?: string; partNumber?: string;
  name?: string;
  stock?: number | string; stockLevel?: number | string;
  low_stock_lvl?: number | string; lowStockLvl?: number | string;
  current_cost_dollar?: number | string; price?: number | string;
}

const num = (v: any, d = 0): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : d;
};

const txPart = (t: RawTxn) => String(t.itempartnumber ?? t.itemPartNumber ?? '');
const txName = (t: RawTxn) => String(t.itemname ?? t.itemName ?? '');
const txQty = (t: RawTxn) => num(t.qtychange ?? t.qtyChange, 0);
const txDate = (t: RawTxn) => String(t.datetime ?? t.dateTime ?? '');

const itemPart = (i: RawItem) => String(i.serial_number ?? i.partNumber ?? '');
const itemStock = (i: RawItem) => num(i.stock ?? i.stockLevel, 0);
const itemLow = (i: RawItem) => num(i.low_stock_lvl ?? i.lowStockLvl, 50);
const itemCost = (i: RawItem) => num(i.current_cost_dollar ?? i.price, 0);

const MS_PER_DAY = 86_400_000;

export interface ConsumptionStat {
  partNumber: string;
  itemName: string;
  totalConsumed: number;
  movements: number;
  firstSeen: number | null;   // epoch ms
  lastSeen: number | null;
  observedDays: number;       // span of history actually observed
  dailyRate: number;          // units/day over the observed span
  perMovement: number[];      // consumption per movement, for variability
  mean: number;
  stdDev: number;
  /** History is too short/sparse for the rate to mean anything. */
  insufficientData: boolean;
  dataNote: string;
}

/**
 * Per-part consumption statistics from the ledger (outbound movements only).
 *
 * A rate is only considered meaningful with >= MIN_MOVEMENTS movements spanning
 * >= MIN_SPAN_DAYS. Five book-outs inside one afternoon describe a single
 * kitting session, not a daily demand rate — extrapolating that would produce
 * wildly overstated forecasts.
 */
export function computeConsumptionStats(transactions: RawTxn[]): Map<string, ConsumptionStat> {
  const MIN_MOVEMENTS = 3;
  const MIN_SPAN_DAYS = 7;
  const byPart = new Map<string, ConsumptionStat>();

  for (const t of transactions) {
    const qty = txQty(t);
    if (qty >= 0) continue;              // outbound only
    const part = txPart(t);
    if (!part) continue;

    const ts = new Date(txDate(t)).getTime();
    const valid = Number.isFinite(ts);

    let s = byPart.get(part);
    if (!s) {
      s = {
        partNumber: part, itemName: txName(t), totalConsumed: 0, movements: 0,
        firstSeen: null, lastSeen: null, observedDays: 0, dailyRate: 0,
        perMovement: [], mean: 0, stdDev: 0, insufficientData: true, dataNote: '',
      };
      byPart.set(part, s);
    }
    const used = Math.abs(qty);
    s.totalConsumed += used;
    s.movements += 1;
    s.perMovement.push(used);
    if (!s.itemName && txName(t)) s.itemName = txName(t);
    if (valid) {
      s.firstSeen = s.firstSeen === null ? ts : Math.min(s.firstSeen, ts);
      s.lastSeen = s.lastSeen === null ? ts : Math.max(s.lastSeen, ts);
    }
  }

  for (const s of byPart.values()) {
    const spanDays = s.firstSeen !== null && s.lastSeen !== null
      ? (s.lastSeen - s.firstSeen) / MS_PER_DAY
      : 0;
    s.observedDays = spanDays;

    s.mean = s.perMovement.length ? s.totalConsumed / s.perMovement.length : 0;
    const variance = s.perMovement.length > 1
      ? s.perMovement.reduce((acc, v) => acc + (v - s.mean) ** 2, 0) / (s.perMovement.length - 1)
      : 0;
    s.stdDev = Math.sqrt(variance);

    if (s.movements < MIN_MOVEMENTS) {
      s.insufficientData = true;
      s.dataNote = `Only ${s.movements} outbound movement${s.movements === 1 ? '' : 's'} on record (need ${MIN_MOVEMENTS}).`;
      s.dailyRate = 0;
    } else if (spanDays < MIN_SPAN_DAYS) {
      s.insufficientData = true;
      s.dataNote = `All ${s.movements} movements fall within ${spanDays < 1 ? 'a single day' : `${spanDays.toFixed(1)} days`} (need ${MIN_SPAN_DAYS} days of history).`;
      s.dailyRate = 0;
    } else {
      s.insufficientData = false;
      s.dailyRate = s.totalConsumed / spanDays;
      s.dataNote = `${s.movements} movements over ${spanDays.toFixed(0)} days.`;
    }
  }

  return byPart;
}

export interface ForecastResult {
  partNumber: string;
  itemName: string;
  horizonDays: number;
  forecastQuantity: number;
  confidence: number;          // 0..1, honestly derived
  method: string;
  insufficientData: boolean;
  note: string;
}

/**
 * Demand forecast over a horizon, using the observed daily rate.
 *
 * Confidence is derived from how much history backs the rate and how stable
 * that history is — not assigned a flattering constant. Parts without enough
 * history return insufficientData with confidence 0 instead of a made-up number.
 */
export function forecastDemand(stat: ConsumptionStat, horizonDays: number): ForecastResult {
  if (stat.insufficientData) {
    return {
      partNumber: stat.partNumber, itemName: stat.itemName, horizonDays,
      forecastQuantity: 0, confidence: 0, method: 'INSUFFICIENT_DATA',
      insufficientData: true, note: stat.dataNote,
    };
  }

  const qty = Math.ceil(stat.dailyRate * horizonDays);

  // More movements over a longer span => more confidence.
  const volumeScore = Math.min(1, stat.movements / 12);
  const spanScore = Math.min(1, stat.observedDays / 90);
  // Lower relative variability => more confidence.
  const cv = stat.mean > 0 ? stat.stdDev / stat.mean : 1;
  const stabilityScore = 1 / (1 + cv);

  const confidence = Math.max(0.05, Math.min(0.95,
    volumeScore * 0.4 + spanScore * 0.3 + stabilityScore * 0.3));

  return {
    partNumber: stat.partNumber, itemName: stat.itemName, horizonDays,
    forecastQuantity: qty,
    confidence: Number(confidence.toFixed(4)),
    method: 'MOVING_AVERAGE_RATE',
    insufficientData: false,
    note: `${stat.dailyRate.toFixed(2)} units/day observed over ${stat.observedDays.toFixed(0)} days.`,
  };
}

export interface AnomalyFinding {
  entityType: 'INVENTORY';
  entityId: string;
  anomalyType: string;
  value: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
}

/**
 * Detect anomalies against live stock plus ledger history.
 *
 * Unlike the forecast path these checks work well today: they read current
 * stock levels, which exist for every item, rather than needing long history.
 */
export function detectAnomalies(
  items: RawItem[],
  transactions: RawTxn[],
  opts: { deadStockValueThreshold?: number } = {}
): AnomalyFinding[] {
  const deadStockValueThreshold = opts.deadStockValueThreshold ?? 500;
  const stats = computeConsumptionStats(transactions);
  const everMoved = new Set<string>();
  for (const t of transactions) {
    const p = txPart(t);
    if (p) everMoved.add(p);
  }

  const findings: AnomalyFinding[] = [];

  for (const item of items) {
    const part = itemPart(item);
    if (!part) continue;
    const stock = itemStock(item);
    const low = itemLow(item);
    const value = stock * itemCost(item);
    const stat = stats.get(part);

    // 1. Negative stock — always a data-integrity fault.
    if (stock < 0) {
      findings.push({
        entityType: 'INVENTORY', entityId: part, anomalyType: 'NEGATIVE_STOCK',
        value: stock, severity: 'CRITICAL',
        description: `${part} has negative stock (${stock}). Indicates an over-issue or a double-booked movement.`,
      });
      continue;
    }

    // 2. Zero stock on a part with real consumption history.
    if (stock === 0 && stat && stat.totalConsumed > 0) {
      findings.push({
        entityType: 'INVENTORY', entityId: part, anomalyType: 'STOCKOUT_WITH_DEMAND',
        value: stat.totalConsumed, severity: 'CRITICAL',
        description: `${part} is out of stock but has consumed ${stat.totalConsumed} units historically.`,
      });
      continue;
    }

    // 3. Below reorder level, graded by how far below.
    if (stock > 0 && low > 0 && stock < low) {
      const ratio = stock / low;
      const severity = ratio < 0.25 ? 'HIGH' : ratio < 0.6 ? 'MEDIUM' : 'LOW';
      findings.push({
        entityType: 'INVENTORY', entityId: part, anomalyType: 'BELOW_REORDER_LEVEL',
        value: stock, severity,
        description: `${part} at ${stock} units is below its reorder level of ${low} (${Math.round(ratio * 100)}% of threshold).`,
      });
    }

    // 4. Dead stock — meaningful capital tied up in something that has never moved.
    if (!everMoved.has(part) && value >= deadStockValueThreshold) {
      findings.push({
        entityType: 'INVENTORY', entityId: part, anomalyType: 'DEAD_STOCK',
        value: Number(value.toFixed(2)),
        severity: value >= deadStockValueThreshold * 10 ? 'MEDIUM' : 'LOW',
        description: `${part} holds $${value.toFixed(2)} of stock with no recorded movement.`,
      });
    }
  }

  // 5. Consumption spikes: a movement far outside that part's own norm.
  for (const stat of stats.values()) {
    if (stat.perMovement.length < 4 || stat.stdDev <= 0) continue;
    const max = Math.max(...stat.perMovement);
    const z = (max - stat.mean) / stat.stdDev;
    if (z >= 2.5) {
      findings.push({
        entityType: 'INVENTORY', entityId: stat.partNumber, anomalyType: 'CONSUMPTION_SPIKE',
        value: max, severity: z >= 4 ? 'HIGH' : 'MEDIUM',
        description: `${stat.partNumber} had a ${max}-unit book-out, ${z.toFixed(1)} standard deviations above its ${stat.mean.toFixed(1)}-unit average.`,
      });
    }
  }

  const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export interface ReorderRecommendation {
  partNumber: string;
  itemName: string;
  currentStock: number;
  reorderLevel: number;
  dailyRate: number;
  daysOfCover: number | null;      // null when demand is unknown
  projectedStockoutDate: string | null;
  suggestedOrderQty: number;
  urgency: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  basis: string;
}

/**
 * Reorder recommendations.
 *
 * Where consumption history supports it, quantities are demand-based
 * (lead-time cover + safety stock). Otherwise it falls back to topping up to
 * the configured reorder level and says so in `basis`, rather than implying a
 * demand calculation that did not happen.
 */
export function computeReorderRecommendations(
  items: RawItem[],
  transactions: RawTxn[],
  opts: { leadTimeDays?: number; safetyDays?: number } = {}
): ReorderRecommendation[] {
  const leadTimeDays = opts.leadTimeDays ?? 14;
  const safetyDays = opts.safetyDays ?? 7;
  const stats = computeConsumptionStats(transactions);
  const out: ReorderRecommendation[] = [];

  for (const item of items) {
    const part = itemPart(item);
    if (!part) continue;
    const stock = itemStock(item);
    const low = itemLow(item);
    const stat = stats.get(part);
    const rate = stat && !stat.insufficientData ? stat.dailyRate : 0;

    const needsAttention = stock <= 0 || (low > 0 && stock < low) || (rate > 0 && stock / rate < leadTimeDays);
    if (!needsAttention) continue;

    const daysOfCover = rate > 0 ? stock / rate : null;
    const projectedStockoutDate = daysOfCover !== null
      ? new Date(Date.now() + daysOfCover * MS_PER_DAY).toISOString().slice(0, 10)
      : null;

    let suggestedOrderQty: number;
    let basis: string;
    if (rate > 0) {
      const target = rate * (leadTimeDays + safetyDays);
      suggestedOrderQty = Math.max(0, Math.ceil(target - stock));
      basis = `Demand-based: ${rate.toFixed(2)} units/day x ${leadTimeDays}d lead + ${safetyDays}d safety.`;
    } else {
      suggestedOrderQty = Math.max(0, Math.ceil(low - stock));
      basis = stat
        ? `Threshold-based top-up to reorder level (${stat.dataNote})`
        : 'Threshold-based top-up to reorder level (no consumption history).';
    }
    if (suggestedOrderQty <= 0) continue;

    const urgency: ReorderRecommendation['urgency'] =
      stock <= 0 ? 'CRITICAL'
      : daysOfCover !== null && daysOfCover < leadTimeDays ? 'HIGH'
      : low > 0 && stock < low * 0.5 ? 'HIGH'
      : low > 0 && stock < low ? 'MEDIUM'
      : 'LOW';

    out.push({
      partNumber: part,
      itemName: String(item.name ?? ''),
      currentStock: stock,
      reorderLevel: low,
      dailyRate: Number(rate.toFixed(4)),
      daysOfCover: daysOfCover === null ? null : Number(daysOfCover.toFixed(1)),
      projectedStockoutDate,
      suggestedOrderQty,
      urgency,
      basis,
    });
  }

  const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
  return out.sort((a, b) => rank[a.urgency] - rank[b.urgency] || b.suggestedOrderQty - a.suggestedOrderQty);
}

export interface BacktestResult {
  accuracy: number | null;      // null when history cannot support a test
  samples: number;
  method: string;
  note: string;
}

/**
 * Walk-forward backtest: fit the rate on the earlier half of a part's history
 * and score it against the later half, scoring 1 - MAPE (floored at 0).
 *
 * Returns accuracy: null when the ledger cannot support a real test, so a model
 * can be marked "needs more data" instead of being stamped with a fake score.
 */
export function backtestForecast(transactions: RawTxn[]): BacktestResult {
  const outbound = transactions
    .filter(t => txQty(t) < 0 && txPart(t))
    .map(t => ({ part: txPart(t), qty: Math.abs(txQty(t)), ts: new Date(txDate(t)).getTime() }))
    .filter(r => Number.isFinite(r.ts))
    .sort((a, b) => a.ts - b.ts);

  const byPart = new Map<string, { qty: number; ts: number }[]>();
  for (const r of outbound) {
    if (!byPart.has(r.part)) byPart.set(r.part, []);
    byPart.get(r.part)!.push({ qty: r.qty, ts: r.ts });
  }

  const errors: number[] = [];
  for (const rows of byPart.values()) {
    if (rows.length < 6) continue;                       // need enough to split
    const mid = Math.floor(rows.length / 2);
    const train = rows.slice(0, mid);
    const test = rows.slice(mid);
    const trainSpan = (train[train.length - 1].ts - train[0].ts) / MS_PER_DAY;
    const testSpan = (test[test.length - 1].ts - test[0].ts) / MS_PER_DAY;
    if (trainSpan < 1 || testSpan < 1) continue;         // no real time axis

    const rate = train.reduce((a, r) => a + r.qty, 0) / trainSpan;
    const predicted = rate * testSpan;
    const actual = test.reduce((a, r) => a + r.qty, 0);
    if (actual <= 0) continue;
    errors.push(Math.abs(predicted - actual) / actual);
  }

  if (!errors.length) {
    return {
      accuracy: null,
      samples: 0,
      method: 'WALK_FORWARD_MAPE',
      note: 'Not enough movement history to backtest: no part has 6+ outbound movements spanning more than a day on each side of the split.',
    };
  }

  const mape = errors.reduce((a, e) => a + e, 0) / errors.length;
  return {
    accuracy: Number(Math.max(0, 1 - mape).toFixed(4)),
    samples: errors.length,
    method: 'WALK_FORWARD_MAPE',
    note: `Backtested ${errors.length} part-series; mean absolute percentage error ${(mape * 100).toFixed(1)}%.`,
  };
}
