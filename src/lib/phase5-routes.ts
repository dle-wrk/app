import { Router } from 'express';
import { query, queryOne } from './db';
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
async function loadTransactions() {
  const { rows } = await query(`SELECT itempartnumber, itemname, qtychange, datetime, type FROM transactions`);
  return rows;
}

// ============================================================================
// QUALITY & COMPLIANCE ENDPOINTS
// ============================================================================

// QA Inspections
router.get('/api/qa-inspections', async (req, res) => {
  try {
    const status = req.query.status as string;
    let sql = 'SELECT * FROM qa_inspections ORDER BY created_at DESC LIMIT 100';
    if (status) {
      sql = `SELECT * FROM qa_inspections WHERE status = $1 ORDER BY created_at DESC LIMIT 100`;
      const result = await query(sql, [status]);
      return res.json(result.rows);
    }
    const result = await query(sql);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/qa-inspections', async (req, res) => {
  try {
    const {
      inspection_type,
      component_id,
      batch_id,
      inspector_id,
      scheduled_date,
      sample_size,
      notes
    } = req.body;

    const result = await queryOne(
      `INSERT INTO qa_inspections (inspection_type, component_id, batch_id, inspector_id, scheduled_date, sample_size, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'SCHEDULED')
       RETURNING *`,
      [inspection_type, component_id, batch_id, inspector_id, scheduled_date, sample_size, notes]
    );
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/qa-inspections/:id', async (req, res) => {
  try {
    const { status, defects_found, notes, completed_date } = req.body;
    const result = await queryOne(
      `UPDATE qa_inspections SET status = $1, defects_found = $2, notes = $3, completed_date = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 RETURNING *`,
      [status, defects_found, notes, completed_date, req.params.id]
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Defects
router.get('/api/defects', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM defects ORDER BY created_at DESC LIMIT 100`);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/defects', async (req, res) => {
  try {
    const { qa_inspection_id, defect_code, severity, description } = req.body;
    const result = await queryOne(
      `INSERT INTO defects (qa_inspection_id, defect_code, severity, description, status)
       VALUES ($1, $2, $3, $4, 'OPEN')
       RETURNING *`,
      [qa_inspection_id, defect_code, severity, description]
    );
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/defects/:id', async (req, res) => {
  try {
    const { status, root_cause, resolution_notes, resolved_at } = req.body;
    const result = await queryOne(
      `UPDATE defects SET status = $1, root_cause = $2, resolution_notes = $3, resolved_at = $4
       WHERE id = $5 RETURNING *`,
      [status, root_cause, resolution_notes, resolved_at, req.params.id]
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Non-Conformance Reports
router.get('/api/ncr', async (req, res) => {
  try {
    const status = req.query.status as string;
    let sql = 'SELECT * FROM non_conformance_reports ORDER BY created_at DESC LIMIT 100';
    if (status) {
      sql = `SELECT * FROM non_conformance_reports WHERE status = $1 ORDER BY created_at DESC LIMIT 100`;
      const result = await query(sql, [status]);
      return res.json(result.rows);
    }
    const result = await query(sql);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/ncr', async (req, res) => {
  try {
    const { component_id, supplier_id, issue_description, severity, reported_by } = req.body;
    const ncr_number = `NCR-${Date.now()}`;

    const result = await queryOne(
      `INSERT INTO non_conformance_reports (ncr_number, component_id, supplier_id, issue_description, severity, reported_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'OPEN')
       RETURNING *`,
      [ncr_number, component_id, supplier_id, issue_description, severity, reported_by]
    );
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/ncr/:id', async (req, res) => {
  try {
    const { status, assigned_to, due_date, resolution_notes } = req.body;
    const result = await queryOne(
      `UPDATE non_conformance_reports SET status = $1, assigned_to = $2, due_date = $3, resolution_notes = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 RETURNING *`,
      [status, assigned_to, due_date, resolution_notes, req.params.id]
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Compliance Checkpoints
router.get('/api/compliance-checkpoints', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM compliance_checkpoints WHERE is_active = true ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/compliance-checkpoints', async (req, res) => {
  try {
    const { checkpoint_name, compliance_standard, stage, required_documentation } = req.body;
    const result = await queryOne(
      `INSERT INTO compliance_checkpoints (checkpoint_name, compliance_standard, stage, required_documentation)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [checkpoint_name, compliance_standard, stage, JSON.stringify(required_documentation || [])]
    );
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Compliance Records
router.get('/api/compliance-records', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM compliance_records ORDER BY created_at DESC LIMIT 100`);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/compliance-records', async (req, res) => {
  try {
    const { compliance_checkpoint_id, project_id, batch_id, status, verified_by, notes } = req.body;
    const result = await queryOne(
      `INSERT INTO compliance_records (compliance_checkpoint_id, project_id, batch_id, status, verified_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [compliance_checkpoint_id, project_id, batch_id, status, verified_by, notes]
    );
    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Quality Metrics
router.get('/api/quality-metrics', async (req, res) => {
  try {
    const component_id = req.query.component_id as string;
    let sql = 'SELECT * FROM quality_metrics ORDER BY metric_date DESC LIMIT 100';
    if (component_id) {
      sql = `SELECT * FROM quality_metrics WHERE component_id = $1 ORDER BY metric_date DESC LIMIT 100`;
      const result = await query(sql, [component_id]);
      return res.json(result.rows);
    }
    const result = await query(sql);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ADVANCED AUTOMATION ENDPOINTS
// ============================================================================

// ML Models
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
    const { model_name, model_type, model_version, accuracy, model_metadata } = req.body;
    const result = await queryOne(
      `INSERT INTO ml_models (model_name, model_type, model_version, status, accuracy, model_metadata)
       VALUES ($1, $2, $3, 'TRAINING', $4, $5)
       RETURNING *`,
      [model_name, model_type, model_version, accuracy, JSON.stringify(model_metadata || {})]
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
router.get('/api/anomalies', async (req, res) => {
  try {
    const status = req.query.status as string;
    let sql = 'SELECT * FROM detected_anomalies ORDER BY detected_at DESC LIMIT 100';
    if (status) {
      sql = `SELECT * FROM detected_anomalies WHERE status = $1 ORDER BY detected_at DESC LIMIT 100`;
      const result = await query(sql, [status]);
      return res.json(result.rows);
    }
    const result = await query(sql);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/anomalies/:id', async (req, res) => {
  try {
    const { status, acknowledged_by, resolution_notes } = req.body;
    const result = await queryOne(
      `UPDATE detected_anomalies SET status = $1, acknowledged_by = $2, acknowledged_at = CURRENT_TIMESTAMP, resolution_notes = $3
       WHERE id = $4 RETURNING *`,
      [status, acknowledged_by, resolution_notes, req.params.id]
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Supplier Intelligence
router.get('/api/supplier-intelligence', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM supplier_intelligence ORDER BY performance_score DESC`);
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

// Anomaly scan — writes findings to detected_anomalies and returns them.
router.post('/api/analytics/scan-anomalies', async (req, res) => {
  try {
    const persist = req.body?.persist !== false;
    const [items, transactions] = await Promise.all([loadInventory(), loadTransactions()]);
    const findings = detectAnomalies(items, transactions);

    let persisted = 0;
    if (persist && findings.length) {
      // Clear prior open machine-generated findings so a rescan reflects
      // current state rather than stacking duplicates. Anything a human has
      // acknowledged or resolved is preserved.
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

    const bySeverity = findings.reduce((acc: Record<string, number>, f) => {
      acc[f.severity] = (acc[f.severity] || 0) + 1; return acc;
    }, {});
    const byType = findings.reduce((acc: Record<string, number>, f) => {
      acc[f.anomalyType] = (acc[f.anomalyType] || 0) + 1; return acc;
    }, {});

    res.json({
      scanned: items.length,
      found: findings.length,
      persisted,
      bySeverity,
      byType,
      findings: findings.slice(0, 200),
    });
  } catch (err: any) {
    console.error('[ANALYTICS] anomaly scan failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Demand forecast generation. Parts without enough history are reported as
// skipped rather than being given an invented forecast.
router.post('/api/analytics/generate-forecasts', async (req, res) => {
  try {
    const horizonDays = Math.max(1, parseInt(String(req.body?.horizonDays ?? 30), 10) || 30);
    const modelId = req.body?.modelId ?? null;
    const transactions = await loadTransactions();
    const stats = computeConsumptionStats(transactions);

    const generated: any[] = [];
    const skipped: any[] = [];
    const forecastDate = new Date(Date.now() + horizonDays * 86_400_000).toISOString().slice(0, 10);

    for (const stat of stats.values()) {
      const f = forecastDemand(stat, horizonDays);
      if (f.insufficientData) {
        skipped.push({ partNumber: f.partNumber, reason: f.note });
        continue;
      }
      await query(
        `INSERT INTO demand_forecasts (component_id, forecast_date, forecast_quantity, confidence_level, forecast_method, model_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (component_id, forecast_date) DO UPDATE
           SET forecast_quantity = EXCLUDED.forecast_quantity,
               confidence_level = EXCLUDED.confidence_level,
               forecast_method = EXCLUDED.forecast_method`,
        [f.partNumber, forecastDate, f.forecastQuantity, f.confidence, f.method, modelId]
      );
      generated.push(f);
    }

    res.json({
      horizonDays,
      forecastDate,
      generated: generated.length,
      skipped: skipped.length,
      forecasts: generated,
      skippedDetail: skipped,
      note: generated.length === 0
        ? 'No part has enough movement history to support a forecast yet. Forecasts need at least 3 outbound movements spanning 7+ days.'
        : undefined,
    });
  } catch (err: any) {
    console.error('[ANALYTICS] forecast generation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Reorder recommendations, computed live (demand-based where history allows,
// threshold-based otherwise — each row states which basis was used).
router.get('/api/analytics/reorder-recommendations', async (req, res) => {
  try {
    const leadTimeDays = parseInt(String(req.query.leadTimeDays ?? 14), 10) || 14;
    const safetyDays = parseInt(String(req.query.safetyDays ?? 7), 10) || 7;
    const [items, transactions] = await Promise.all([loadInventory(), loadTransactions()]);
    const recs = computeReorderRecommendations(items, transactions, { leadTimeDays, safetyDays });
    res.json({
      leadTimeDays,
      safetyDays,
      count: recs.length,
      demandBased: recs.filter(r => r.dailyRate > 0).length,
      recommendations: recs.slice(0, 200),
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
