import { Router } from 'express';
import { query, queryOne } from './db';
import { loadMeasuredLeadTimes } from './suppliersRoutes';
import { leadTimeForSupplierName, slowestSlotLeadTime, type MeasuredLeadTime } from './supplierLeadTime';
import { scoreSupplier, MIN_RECEIVED } from './supplierScore';
import {
  computeConsumptionStats,
  forecastDemand,
  detectAnomalies,
  computeReorderRecommendations,
  backtestForecast,
} from './analytics-engine';

const router = Router();

// Shared loaders for the analytics endpoints below.
async function loadInventory() {
  const { rows } = await query(`SELECT serial_number, name, stock, low_stock_lvl, current_cost_dollar FROM inventory WHERE deleted != true`);
  return rows;
}
// For reordering: only items still in use (not Inactive, Do Not Use or
// Discontinued), with what a supplier order file needs.
async function loadReorderableInventory() {
  const { rows } = await query(
    `SELECT serial_number, name, stock, low_stock_lvl, current_cost_dollar, description, footprint, supplier,
            sup_pn_1, sup_pn_2, sup_pn_3, sup_pn_4, sup_pn_5
       FROM inventory
      WHERE deleted != true AND UPPER(COALESCE(TRIM(status), 'ACTIVE')) NOT IN ('INACTIVE', 'DO NOT USE', 'DISCONTINUED')`
  );
  return rows;
}
async function loadTransactions() {
  const { rows } = await query(`SELECT itempartnumber, itemname, qtychange, datetime, type FROM transactions`);
  return rows;
}

// Quality & compliance endpoints: ./qualityRoutes.

// ============================================================================
// ADVANCED AUTOMATION ENDPOINTS
// ============================================================================

// ML Models
const MODEL_TYPES = ['DEMAND_FORECAST', 'ANOMALY_DETECTION', 'SUPPLIER_RANKING', 'DEFECT_PREDICTION'];
router.get('/api/ml-models', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM ml_models ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/ml-models', async (req, res) => {
  try {
    // Accuracy is only ever measured (Train), never typed in.
    const { model_name, model_type, model_version } = req.body;
    if (!String(model_name ?? '').trim()) return res.status(400).json({ error: 'Give the model a name.' });
    if (!MODEL_TYPES.includes(model_type)) return res.status(400).json({ error: 'Choose what the model does.' });
    const result = await queryOne(
      `INSERT INTO ml_models (model_name, model_type, model_version, status, accuracy, model_metadata)
       VALUES ($1, $2, $3, 'NEEDS_DATA', NULL, '{"note":"Not trained yet."}')
       RETURNING *`,
      [String(model_name).trim(), model_type, String(model_version ?? '1.0.0').trim() || '1.0.0']
    );
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/ml-models/:id', async (req, res) => {
  try {
    const { status, accuracy, last_trained_at } = req.body;
    const result = await queryOne(
      `UPDATE ml_models SET status = $1, accuracy = $2, last_trained_at = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 RETURNING *`,
      [status, accuracy, last_trained_at, req.params.id]
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Predictive Orders
router.get('/api/predictive-orders', async (req, res) => {
  try {
    const status = req.query.status as string;
    let sql = 'SELECT * FROM predictive_orders ORDER BY predicted_date DESC LIMIT 100';
    if (status) {
      sql = `SELECT * FROM predictive_orders WHERE status = $1 ORDER BY predicted_date DESC LIMIT 100`;
      const result = await query(sql, [status]);
      return res.json(result.rows);
    }
    const result = await query(sql);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/predictive-orders', async (req, res) => {
  try {
    const { component_id, predicted_quantity, predicted_date, confidence_score, model_id } = req.body;
    const result = await queryOne(
      `INSERT INTO predictive_orders (component_id, predicted_quantity, predicted_date, confidence_score, model_id, status)
       VALUES ($1, $2, $3, $4, $5, 'PENDING')
       RETURNING *`,
      [component_id, predicted_quantity, predicted_date, confidence_score, model_id]
    );
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Anomaly Detection Rules
router.get('/api/anomaly-rules', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM anomaly_detection_rules WHERE is_active = true ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/anomaly-rules', async (req, res) => {
  try {
    const { rule_name, entity_type, anomaly_type, condition_json, threshold, alert_channel, severity } = req.body;
    const result = await queryOne(
      `INSERT INTO anomaly_detection_rules (rule_name, entity_type, anomaly_type, condition_json, threshold, alert_channel, severity)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [rule_name, entity_type, anomaly_type, JSON.stringify(condition_json), threshold, alert_channel, severity]
    );
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Detected Anomalies
// ?status=open (DETECTED, ACKNOWLEDGED, INVESTIGATING) | a status; ?severity=; ?type= (the [TYPE] its description starts with).
router.get('/api/anomalies', async (req, res) => {
  try {
    const params: any[] = []; const where: string[] = [];
    const status = String(req.query.status ?? '');
    if (status === 'open') where.push(`status IN ('DETECTED', 'ACKNOWLEDGED', 'INVESTIGATING')`);
    else if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (req.query.severity) { params.push(req.query.severity); where.push(`severity = $${params.length}`); }
    if (req.query.type) { params.push(`[${req.query.type}]%`); where.push(`description LIKE $${params.length}`); }
    const result = await query(
      `SELECT a.*, i.name AS item_name FROM detected_anomalies a LEFT JOIN inventory i ON a.entity_type = 'INVENTORY' AND i.serial_number = a.entity_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, detected_at DESC LIMIT 500`, params);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const ANOMALY_STATUSES = ['DETECTED', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'FALSE_POSITIVE'];
router.put('/api/anomalies/:id', async (req: any, res) => {
  try {
    const { status, resolution_notes } = req.body;
    if (!ANOMALY_STATUSES.includes(status)) return res.status(400).json({ error: "That isn't an anomaly status." });
    const result = await queryOne(
      `UPDATE detected_anomalies SET status = $1, acknowledged_by = COALESCE(acknowledged_by, $2), acknowledged_at = COALESCE(acknowledged_at, CURRENT_TIMESTAMP),
         resolution_notes = COALESCE($3, resolution_notes), resolved_at = CASE WHEN $1 IN ('RESOLVED', 'FALSE_POSITIVE') THEN CURRENT_TIMESTAMP ELSE NULL END
       WHERE id = $4 RETURNING *`,
      [status, req.user?.email ?? null, resolution_notes ? String(resolution_notes).trim() : null, req.params.id]
    );
    if (!result) return res.status(404).json({ error: 'Anomaly not found.' });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Supplier Intelligence
router.get('/api/supplier-intelligence', async (req, res) => {
  try {
    const result = await query(`SELECT si.*, s.name AS supplier_name FROM supplier_intelligence si LEFT JOIN suppliers s ON s.id::text = si.supplier_id
      ORDER BY si.performance_score DESC NULLS LAST, s.name`);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/supplier-intelligence', async (req, res) => {
  try {
    const { supplier_id, performance_score, on_time_delivery_pct, quality_score, responsiveness_score, pricing_competitiveness } = req.body;
    const result = await queryOne(
      `INSERT INTO supplier_intelligence (supplier_id, performance_score, on_time_delivery_pct, quality_score, responsiveness_score, pricing_competitiveness)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (supplier_id) DO UPDATE SET
         performance_score = $2,
         on_time_delivery_pct = $3,
         quality_score = $4,
         responsiveness_score = $5,
         pricing_competitiveness = $6,
         last_assessed_date = CURRENT_TIMESTAMP
       RETURNING *`,
      [supplier_id, performance_score, on_time_delivery_pct, quality_score, responsiveness_score, pricing_competitiveness]
    );
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Demand Forecasts
router.get('/api/demand-forecasts', async (req, res) => {
  try {
    const component_id = req.query.component_id as string;
    let sql = 'SELECT * FROM demand_forecasts ORDER BY forecast_date DESC LIMIT 100';
    if (component_id) {
      sql = `SELECT * FROM demand_forecasts WHERE component_id = $1 ORDER BY forecast_date DESC LIMIT 100`;
      const result = await query(sql, [component_id]);
      return res.json(result.rows);
    }
    const result = await query(sql);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/demand-forecasts', async (req, res) => {
  try {
    const { component_id, forecast_date, forecast_quantity, confidence_level, forecast_method, model_id } = req.body;
    const result = await queryOne(
      `INSERT INTO demand_forecasts (component_id, forecast_date, forecast_quantity, confidence_level, forecast_method, model_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [component_id, forecast_date, forecast_quantity, confidence_level, forecast_method, model_id]
    );
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Quality Gates
router.get('/api/quality-gates', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM quality_gates WHERE is_active = true ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/quality-gates', async (req, res) => {
  try {
    const { process_stage, gate_name, auto_trigger_condition, required_approvals } = req.body;
    const result = await queryOne(
      `INSERT INTO quality_gates (process_stage, gate_name, auto_trigger_condition, required_approvals)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [process_stage, gate_name, JSON.stringify(auto_trigger_condition || {}), required_approvals]
    );
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ANALYTICS ENGINE ENDPOINTS
//
// These compute from live inventory + ledger data. Previously the ML tables
// only held hand-entered rows, so nothing in this area produced a result.
// Where the data cannot support a conclusion these endpoints report that
// explicitly instead of emitting a fabricated number.
// ============================================================================

// Anomaly scan: writes findings to detected_anomalies. A rescan replaces the
// open machine findings, but doesn't raise again what someone has already
// acknowledged, is investigating or marked a false positive.
export async function scanAnomalies(persist = true) {
  const [items, transactions] = await Promise.all([loadInventory(), loadTransactions()]);
  const all = detectAnomalies(items, transactions);
  const { rows: handled } = await query(
    `SELECT entity_id, description FROM detected_anomalies WHERE status IN ('ACKNOWLEDGED', 'INVESTIGATING', 'FALSE_POSITIVE')`);
  const seen = new Set(handled.map((r: any) => `${r.entity_id}|${String(r.description ?? '').match(/^\[([A-Z_]+)\]/)?.[1] ?? ''}`));
  const findings = all.filter((f) => !seen.has(`${f.entityId}|${f.anomalyType}`));
  let persisted = 0;
  if (persist) {
    await query(`DELETE FROM detected_anomalies WHERE status = 'DETECTED' AND rule_id IS NULL`);
    for (const f of findings) {
      await query(
        `INSERT INTO detected_anomalies (entity_type, entity_id, anomaly_value, severity, status, description)
         VALUES ($1, $2, $3, $4, 'DETECTED', $5)`,
        [f.entityType, f.entityId, f.value, f.severity, `[${f.anomalyType}] ${f.description}`]
      );
      persisted++;
    }
  }
  const count = (key: 'severity' | 'anomalyType') => findings.reduce((acc: Record<string, number>, f) => { acc[f[key]] = (acc[f[key]] || 0) + 1; return acc; }, {});
  return { scanned: items.length, found: findings.length, alreadyHandled: all.length - findings.length, persisted, bySeverity: count('severity'), byType: count('anomalyType'), findings: findings.slice(0, 200) };
}

router.post('/api/analytics/scan-anomalies', async (req, res) => {
  try { res.json(await scanAnomalies(req.body?.persist !== false)); }
  catch (err: any) {
    console.error('[ANALYTICS] anomaly scan failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Demand forecasts. Parts without enough history are reported as skipped
// rather than being given an invented forecast.
export async function generateForecasts(horizonDays = 30, modelId: number | null = null) {
  const transactions = await loadTransactions();
  const stats = computeConsumptionStats(transactions);
  const generated: any[] = [];
  const skipped: any[] = [];
  const forecastDate = new Date(Date.now() + horizonDays * 86_400_000).toISOString().slice(0, 10);
  for (const stat of stats.values()) {
    const f = forecastDemand(stat, horizonDays);
    if (f.insufficientData) { skipped.push({ partNumber: f.partNumber, reason: f.note }); continue; }
    await query(
      `INSERT INTO demand_forecasts (component_id, forecast_date, forecast_quantity, confidence_level, forecast_method, model_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (component_id, forecast_date) DO UPDATE
         SET forecast_quantity = EXCLUDED.forecast_quantity, confidence_level = EXCLUDED.confidence_level, forecast_method = EXCLUDED.forecast_method`,
      [f.partNumber, forecastDate, f.forecastQuantity, f.confidence, f.method, modelId]
    );
    generated.push(f);
  }
  return {
    horizonDays, forecastDate, generated: generated.length, skipped: skipped.length, forecasts: generated, skippedDetail: skipped,
    note: generated.length === 0
      ? 'No part has enough movement history to support a forecast yet. Forecasts need at least 3 outbound movements spanning 7+ days.'
      : undefined,
  };
}

router.post('/api/analytics/generate-forecasts', async (req, res) => {
  try {
    const horizonDays = Math.max(1, parseInt(String(req.body?.horizonDays ?? 30), 10) || 30);
    res.json(await generateForecasts(horizonDays, req.body?.modelId ?? null));
  } catch (err: any) {
    console.error('[ANALYTICS] forecast generation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// The forecasts still ahead, with the item's name.
router.get('/api/analytics/forecasts', async (_req, res) => {
  try {
    const { rows } = await query(`SELECT f.component_id, i.name, to_char(f.forecast_date, 'YYYY-MM-DD') AS forecast_date, f.forecast_quantity, f.confidence_level, f.forecast_method, f.created_at
      FROM demand_forecasts f LEFT JOIN inventory i ON i.serial_number = f.component_id
      WHERE f.forecast_date >= CURRENT_DATE ORDER BY f.forecast_date, f.forecast_quantity DESC LIMIT 300`);
    res.json(rows);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Supplier assessment: each supplier with orders or NCRs scored from them
// (./supplierScore), saved to supplier_intelligence.
export async function assessSuppliers() {
  const { rows } = await query(`SELECT s.id::text AS id, s.name,
      COUNT(po.id)::int AS orders,
      COUNT(po.id) FILTER (WHERE po.status = 'RECEIVED')::int AS received,
      COUNT(po.id) FILTER (WHERE po.status = 'RECEIVED' AND po.received_at IS NOT NULL AND po.expected_date IS NOT NULL)::int AS timed,
      COUNT(po.id) FILTER (WHERE po.status = 'RECEIVED' AND po.received_at IS NOT NULL AND po.expected_date IS NOT NULL AND po.received_at::date <= po.expected_date)::int AS on_time,
      (SELECT COUNT(*)::int FROM non_conformance_reports n WHERE n.supplier_id = s.id::text) AS ncrs
    FROM suppliers s LEFT JOIN purchase_orders po ON po.supplier_id::text = s.id::text GROUP BY s.id, s.name`);
  const measured = await loadMeasuredLeadTimes().catch(() => new Map<string, MeasuredLeadTime>());
  const active = (rows as any[]).filter((r) => r.orders || r.ncrs);
  let scored = 0;
  for (const r of active) {
    const sc = scoreSupplier({ orders: r.orders, received: r.received, timed: r.timed, onTime: r.on_time, ncrs: r.ncrs, leadDays: measured.get(r.id)?.days ?? null });
    if (sc.score !== null) scored++;
    await query(
      `INSERT INTO supplier_intelligence (supplier_id, performance_score, on_time_delivery_pct, quality_score, last_assessed_date, notes)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5)
       ON CONFLICT (supplier_id) DO UPDATE SET performance_score = $2, on_time_delivery_pct = $3, quality_score = $4, last_assessed_date = CURRENT_TIMESTAMP, notes = $5, updated_at = CURRENT_TIMESTAMP`,
      [r.id, sc.score, sc.onTimePct, sc.qualityScore, sc.note]);
  }
  return { assessed: active.length, scored };
}

router.post('/api/analytics/assess-suppliers', async (_req, res) => {
  try { res.json(await assessSuppliers()); } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Reorder recommendations, computed live (demand-based where history allows,
// threshold-based otherwise — each row states which basis was used).
router.get('/api/analytics/reorder-recommendations', async (req, res) => {
  try {
    const leadTimeDays = parseInt(String(req.query.leadTimeDays ?? 14), 10) || 14;
    const safetyDays = parseInt(String(req.query.safetyDays ?? 7), 10) || 7;
    const [items, transactions, suppliers, measured] = await Promise.all([
      loadReorderableInventory(), loadTransactions(),
      query<any>(`SELECT id, name, lead_time FROM suppliers`).then((r) => r.rows),
      loadMeasuredLeadTimes().catch(() => new Map<string, MeasuredLeadTime>()),
    ]);
    // Each item's lead time is its supplier's (measured from received orders, else typed):
    // its Supplier field's, else the slowest of those it has part numbers for (../supplierLeadTime).
    const leadTimeFor = (item: any) => {
      const own = leadTimeForSupplierName(item.supplier, suppliers, measured);
      const l = own ?? slowestSlotLeadTime([item.sup_pn_1, item.sup_pn_2, item.sup_pn_3], suppliers, measured);
      if (!l) return null;
      const m = measured.get(String(suppliers.find((s: any) => s.name === l.supplier)?.id));
      const how = l.source === 'measured' ? `measured over ${m?.orders ?? 0} order${m?.orders === 1 ? '' : 's'}` : 'as typed';
      return { days: l.days, note: own ? `${l.supplier}, ${how}` : `slowest of its suppliers: ${l.supplier}, ${how}` };
    };
    const recs = computeReorderRecommendations(items, transactions, { leadTimeDays, safetyDays, leadTimeFor });
    const byPart = new Map(items.map((i: any) => [String(i.serial_number), i]));
    res.json({
      leadTimeDays,
      safetyDays,
      count: recs.length,
      demandBased: recs.filter(r => r.dailyRate > 0).length,
      recommendations: recs.slice(0, 200),
      // Every recommendation, as lines for the supplier order files (../supplierBom).
      orderLines: recs.map((r) => {
        const i: any = byPart.get(r.partNumber) ?? {};
        return {
          stockCode: r.partNumber,
          description: String(i.description || r.itemName || ''),
          footprint: String(i.footprint || ''),
          supPns: [i.sup_pn_1, i.sup_pn_2, i.sup_pn_3, i.sup_pn_4, i.sup_pn_5].map((v) => String(v ?? '')),
          qty: r.suggestedOrderQty,
          urgency: r.urgency,
        };
      }),
    });
  } catch (err: any) {
    console.error('[ANALYTICS] reorder recommendations failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Train a model: runs a real walk-forward backtest over the ledger and records
// the measured accuracy. If the data cannot support a test the model is marked
// NEEDS_DATA rather than being stamped with an unearned score.
router.post('/api/ml-models/:id/train', async (req, res) => {
  try {
    const model = await queryOne(`SELECT * FROM ml_models WHERE id = $1`, [req.params.id]);
    if (!model) return res.status(404).json({ error: 'model not found' });
    // Only a demand forecast has an accuracy to measure (a backtest). The
    // others run what they are and say so, with no score.
    const settle = async (status: string, note: string) => {
      await query(`UPDATE ml_models SET status = $1, accuracy = NULL, last_trained_at = CASE WHEN $1 = 'ACTIVE' THEN CURRENT_TIMESTAMP ELSE last_trained_at END,
        updated_at = CURRENT_TIMESTAMP, model_metadata = $2 WHERE id = $3`, [status, JSON.stringify({ note, lastAttempt: new Date().toISOString() }), req.params.id]);
      return res.json({ trained: status === 'ACTIVE', accuracy: null, samples: 0, method: model.model_type, note });
    };
    if (model.model_type === 'ANOMALY_DETECTION') {
      const scan = await scanAnomalies(true);
      return settle('ACTIVE', `Rule checks over stock and the ledger (no accuracy to measure): ${scan.found} found in ${scan.scanned} items.`);
    }
    if (model.model_type === 'SUPPLIER_RANKING') {
      const r = await assessSuppliers();
      return r.scored
        ? settle('ACTIVE', `${r.scored} of ${r.assessed} suppliers scored from their orders and NCRs.`)
        : settle('NEEDS_DATA', `No supplier has ${MIN_RECEIVED} received orders yet, so none can be scored (${r.assessed} have orders).`);
    }
    if (model.model_type === 'DEFECT_PREDICTION') {
      const row = await queryOne(`SELECT COUNT(*)::int AS n FROM qa_inspections WHERE status IN ('PASSED', 'FAILED', 'HOLD')`);
      return settle('NEEDS_DATA', `Needs a history of inspection results to learn from: ${row?.n ?? 0} completed so far, 30 or more wanted. Record inspection results under Quality.`);
    }

    const transactions = await loadTransactions();
    const result = backtestForecast(transactions);

    if (result.accuracy === null) {
      await query(
        `UPDATE ml_models SET status = 'NEEDS_DATA', accuracy = NULL, updated_at = CURRENT_TIMESTAMP,
           model_metadata = $1 WHERE id = $2`,
        [JSON.stringify({ lastAttempt: new Date().toISOString(), method: result.method, note: result.note }), req.params.id]
      );
      return res.json({ trained: false, accuracy: null, samples: 0, method: result.method, note: result.note });
    }

    await query(
      `UPDATE ml_models SET status = 'ACTIVE', accuracy = $1, last_trained_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP, model_metadata = $2 WHERE id = $3`,
      [result.accuracy, JSON.stringify({ method: result.method, samples: result.samples, note: result.note }), req.params.id]
    );
    res.json({ trained: true, accuracy: result.accuracy, samples: result.samples, method: result.method, note: result.note });
  } catch (err: any) {
    console.error('[ANALYTICS] training failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// True anomaly totals. GET /api/anomalies caps at 100 rows, so counting
// severities from that response under-reports whenever more exist.
router.get('/api/analytics/anomaly-summary', async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT status, severity, COUNT(*)::int AS count
         FROM detected_anomalies GROUP BY status, severity`
    );
    const bySeverity: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let total = 0;
    let open = 0;
    for (const r of rows as any[]) {
      total += r.count;
      byStatus[r.status] = (byStatus[r.status] || 0) + r.count;
      if (r.status === 'DETECTED') {
        open += r.count;
        bySeverity[r.severity] = (bySeverity[r.severity] || 0) + r.count;
      }
    }
    res.json({ total, open, bySeverity, byStatus });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Consumption summary used by the dashboard's overview cards.
router.get('/api/analytics/consumption-summary', async (_req, res) => {
  try {
    const transactions = await loadTransactions();
    const stats = [...computeConsumptionStats(transactions).values()];
    res.json({
      partsWithHistory: stats.length,
      partsForecastable: stats.filter(s => !s.insufficientData).length,
      totalConsumed: stats.reduce((a, s) => a + s.totalConsumed, 0),
      parts: stats
        .sort((a, b) => b.totalConsumed - a.totalConsumed)
        .slice(0, 50)
        .map(s => ({
          partNumber: s.partNumber, itemName: s.itemName, totalConsumed: s.totalConsumed,
          movements: s.movements, dailyRate: Number(s.dailyRate.toFixed(4)),
          forecastable: !s.insufficientData, note: s.dataNote,
        })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
