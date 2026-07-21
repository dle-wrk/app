import { exec, query, queryOne } from './db';

export async function ensurePhase5Tables() {
  // Quality & Compliance tables
  await exec(`CREATE TABLE IF NOT EXISTS qa_inspections (
    id SERIAL PRIMARY KEY,
    inspection_type TEXT NOT NULL,
    component_id TEXT NOT NULL,
    batch_id TEXT,
    inspector_id TEXT NOT NULL,
    status TEXT CHECK (status IN ('SCHEDULED', 'IN_PROGRESS', 'PASSED', 'FAILED', 'HOLD')) DEFAULT 'SCHEDULED',
    scheduled_date TIMESTAMP,
    completed_date TIMESTAMP,
    sample_size INTEGER,
    defects_found INTEGER DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await exec(`CREATE TABLE IF NOT EXISTS defects (
    id SERIAL PRIMARY KEY,
    qa_inspection_id INTEGER REFERENCES qa_inspections(id),
    defect_code TEXT NOT NULL,
    severity TEXT CHECK (severity IN ('CRITICAL', 'MAJOR', 'MINOR')) NOT NULL,
    description TEXT NOT NULL,
    root_cause TEXT,
    detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    status TEXT CHECK (status IN ('OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED')) DEFAULT 'OPEN',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await exec(`CREATE TABLE IF NOT EXISTS non_conformance_reports (
    id SERIAL PRIMARY KEY,
    ncr_number TEXT UNIQUE NOT NULL,
    component_id TEXT NOT NULL,
    supplier_id TEXT,
    issue_description TEXT NOT NULL,
    severity TEXT CHECK (severity IN ('CRITICAL', 'MAJOR', 'MINOR')) NOT NULL,
    reported_by TEXT NOT NULL,
    reported_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT CHECK (status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')) DEFAULT 'OPEN',
    assigned_to TEXT,
    due_date TIMESTAMP,
    resolution_notes TEXT,
    resolved_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await exec(`CREATE TABLE IF NOT EXISTS compliance_checkpoints (
    id SERIAL PRIMARY KEY,
    checkpoint_name TEXT NOT NULL,
    compliance_standard TEXT NOT NULL,
    stage TEXT NOT NULL,
    required_documentation JSONB DEFAULT '[]'::jsonb,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await exec(`CREATE TABLE IF NOT EXISTS compliance_records (
    id SERIAL PRIMARY KEY,
    compliance_checkpoint_id INTEGER REFERENCES compliance_checkpoints(id),
    project_id INTEGER,
    batch_id TEXT,
    status TEXT CHECK (status IN ('PENDING', 'COMPLIANT', 'NON_COMPLIANT', 'WAIVED')) DEFAULT 'PENDING',
    verified_by TEXT,
    verified_date TIMESTAMP,
    documentation JSONB DEFAULT '{}'::jsonb,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await exec(`CREATE TABLE IF NOT EXISTS quality_metrics (
    id SERIAL PRIMARY KEY,
    metric_date DATE NOT NULL,
    component_id TEXT,
    total_inspections INTEGER DEFAULT 0,
    passed_inspections INTEGER DEFAULT 0,
    failed_inspections INTEGER DEFAULT 0,
    defect_rate NUMERIC(5, 2),
    critical_defects INTEGER DEFAULT 0,
    major_defects INTEGER DEFAULT 0,
    minor_defects INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(metric_date, component_id)
  )`);

  // Advanced Automation tables
  await exec(`CREATE TABLE IF NOT EXISTS ml_models (
    id SERIAL PRIMARY KEY,
    model_name TEXT NOT NULL UNIQUE,
    model_type TEXT NOT NULL,
    model_version TEXT NOT NULL,
    status TEXT CHECK (status IN ('TRAINING', 'ACTIVE', 'ARCHIVED')) DEFAULT 'TRAINING',
    accuracy NUMERIC(5, 4),
    last_trained_at TIMESTAMP,
    last_used_at TIMESTAMP,
    model_metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await exec(`CREATE TABLE IF NOT EXISTS predictive_orders (
    id SERIAL PRIMARY KEY,
    component_id TEXT NOT NULL,
    predicted_quantity INTEGER NOT NULL,
    predicted_date TIMESTAMP NOT NULL,
    confidence_score NUMERIC(5, 4),
    model_id INTEGER REFERENCES ml_models(id),
    status TEXT CHECK (status IN ('PENDING', 'RECOMMENDED', 'CREATED', 'FULFILLED')) DEFAULT 'PENDING',
    auto_po_created BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await exec(`CREATE TABLE IF NOT EXISTS anomaly_detection_rules (
    id SERIAL PRIMARY KEY,
    rule_name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    anomaly_type TEXT NOT NULL,
    condition_json JSONB NOT NULL,
    threshold NUMERIC(10, 2),
    is_active BOOLEAN DEFAULT true,
    alert_channel TEXT,
    severity TEXT CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')) DEFAULT 'MEDIUM',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await exec(`CREATE TABLE IF NOT EXISTS detected_anomalies (
    id SERIAL PRIMARY KEY,
    rule_id INTEGER REFERENCES anomaly_detection_rules(id),
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    anomaly_value NUMERIC(15, 4),
    severity TEXT NOT NULL,
    status TEXT CHECK (status IN ('DETECTED', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'FALSE_POSITIVE')) DEFAULT 'DETECTED',
    description TEXT,
    detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    acknowledged_at TIMESTAMP,
    acknowledged_by TEXT,
    resolution_notes TEXT,
    resolved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await exec(`CREATE TABLE IF NOT EXISTS supplier_intelligence (
    id SERIAL PRIMARY KEY,
    supplier_id TEXT NOT NULL,
    performance_score NUMERIC(5, 2),
    on_time_delivery_pct NUMERIC(5, 2),
    quality_score NUMERIC(5, 2),
    responsiveness_score NUMERIC(5, 2),
    pricing_competitiveness NUMERIC(5, 2),
    last_assessed_date TIMESTAMP,
    notes TEXT,
    is_preferred BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(supplier_id)
  )`);

  await exec(`CREATE TABLE IF NOT EXISTS demand_forecasts (
    id SERIAL PRIMARY KEY,
    component_id TEXT NOT NULL,
    forecast_date DATE NOT NULL,
    forecast_quantity INTEGER NOT NULL,
    confidence_level NUMERIC(5, 4),
    forecast_method TEXT,
    actual_quantity INTEGER,
    accuracy_rating NUMERIC(5, 4),
    model_id INTEGER REFERENCES ml_models(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(component_id, forecast_date)
  )`);

  await exec(`CREATE TABLE IF NOT EXISTS quality_gates (
    id SERIAL PRIMARY KEY,
    process_stage TEXT NOT NULL,
    gate_name TEXT NOT NULL,
    auto_trigger_condition JSONB,
    required_approvals INTEGER DEFAULT 1,
    bypass_allowed BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await exec(`CREATE TABLE IF NOT EXISTS quality_gate_executions (
    id SERIAL PRIMARY KEY,
    quality_gate_id INTEGER REFERENCES quality_gates(id),
    batch_id TEXT NOT NULL,
    status TEXT CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'BYPASSED')) DEFAULT 'PENDING',
    triggered_by TEXT,
    triggered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    approved_by TEXT,
    approved_at TIMESTAMP,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
}
