// Automation surface extracted from server.ts. Owns the Phase 4 workflow
// primitives:
//   - automation_rules            (rule engine: trigger events → actions)
//   - scheduled_jobs              (cron-driven jobs w/ retry counters)
//   - notifications               (per-user inbox)
//   - auto_po_config              (per-component thresholds for auto-PO)
//   - event_log                   (append-only audit trail)
//   - alert_subscriptions         (user opt-in for alert channels)
//   - /api/automation/trigger-auto-po     (creates a PO from a component's config)
//   - /api/automation/send-alert          (fans out notifications for a subscription)
//   - /api/automation/enrich-missing-suppliers   (stub MPN enrichment; logs to event_log)
//
// Note: this router does NOT create tables. The Phase 4 tables are assumed to
// exist (see the pre-existing bootstrap in server.ts or ensurePhase5Tables for
// the neighbouring Phase 5 surface). Adding a schema helper here would blur
// the boundary since several tables (purchase_orders, inventory, supplier_
// performance) are owned by other surfaces.
//
// Dependencies deliberately narrow: only the shared db helpers.

import type { Express } from 'express';
import { query, queryOne } from './db';

export function registerAutomationRoutes(app: Express): void {
  // ---------------------------------------------------------------------------
  // Automation Rules
  // ---------------------------------------------------------------------------
  app.get('/api/automation-rules', async (req, res) => {
    const isActive = req.query.isActive as string | undefined;
    try {
      let sql = 'SELECT * FROM automation_rules';
      const params: any[] = [];
      if (isActive !== undefined) {
        sql += ' WHERE is_active = $1';
        params.push(isActive === 'true');
      }
      sql += ' ORDER BY priority DESC, updated_at DESC';
      const { rows } = await query(sql, params);
      res.json(rows.map((row: any) => ({
        id: row.id,
        ruleName: row.rule_name,
        ruleType: row.rule_type,
        description: row.description,
        triggerEvent: row.trigger_event,
        conditions: row.conditions,
        actions: row.actions,
        isActive: row.is_active,
        priority: row.priority,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/automation-rules', async (req, res) => {
    const { ruleName, ruleType, description, triggerEvent, conditions, actions, priority, createdBy, isActive } = req.body;
    if (!ruleName || !ruleType || !triggerEvent) {
      return res.status(400).json({ error: 'ruleName, ruleType, and triggerEvent are required' });
    }

    try {
      // Generate default actions based on rule type. The client can override by
      // sending its own `actions` payload; this branch only fires when the
      // caller wants us to fill in a sensible default so a rule created from a
      // "quick-add" flow still executes something.
      let defaultActions = actions;
      if (!defaultActions) {
        if (ruleType === 'AUTO_PO') {
          defaultActions = JSON.stringify({ type: 'CREATE_PO', autoApprove: false });
        } else if (ruleType === 'MPN_ENRICHMENT') {
          defaultActions = JSON.stringify({ type: 'ENRICH_SUPPLIERS', endpoint: '/api/automation/enrich-missing-suppliers' });
        } else if (ruleType === 'NOTIFICATION') {
          defaultActions = JSON.stringify({ type: 'SEND_ALERT', channel: 'email' });
        } else {
          defaultActions = JSON.stringify({ type: ruleType });
        }
      }

      const row = await queryOne(
        `INSERT INTO automation_rules (rule_name, rule_type, description, trigger_event, conditions, actions, priority, created_by, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [ruleName, ruleType, description || null, triggerEvent, conditions || null, defaultActions, priority || 0, createdBy || null, isActive ?? true]
      );
      res.status(201).json({
        id: row?.id,
        ruleName: row?.rule_name,
        ruleType: row?.rule_type,
        triggerEvent: row?.trigger_event,
        isActive: row?.is_active,
        createdAt: row?.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/automation-rules/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { ruleName, ruleType, description, triggerEvent, isActive, priority, actions, conditions } = req.body;
    try {
      const row = await queryOne(
        `UPDATE automation_rules SET
           rule_name = COALESCE($1, rule_name), rule_type = COALESCE($2, rule_type),
           description = COALESCE($3, description), trigger_event = COALESCE($4, trigger_event),
           is_active = COALESCE($5, is_active), priority = COALESCE($6, priority),
           actions = COALESCE($7, actions), conditions = COALESCE($8, conditions), updated_at = now()
         WHERE id = $9 RETURNING *`,
        [ruleName || null, ruleType || null, description || null, triggerEvent || null,
         isActive ?? null, priority ?? null, actions || null, conditions || null, id]
      );
      if (!row) return res.status(404).json({ error: 'Automation rule not found' });
      res.json({
        id: row.id,
        ruleName: row.rule_name,
        ruleType: row.rule_type,
        description: row.description,
        triggerEvent: row.trigger_event,
        isActive: row.is_active,
        priority: row.priority,
        updatedAt: row.updated_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Scheduled Jobs
  // ---------------------------------------------------------------------------
  app.get('/api/scheduled-jobs', async (req, res) => {
    const isActive = req.query.isActive as string | undefined;
    try {
      let sql = 'SELECT * FROM scheduled_jobs';
      const params: any[] = [];
      if (isActive !== undefined) {
        sql += ' WHERE is_active = $1';
        params.push(isActive === 'true');
      }
      sql += ' ORDER BY next_run ASC';
      const { rows } = await query(sql, params);
      res.json(rows.map((row: any) => ({
        id: row.id,
        jobName: row.job_name,
        jobType: row.job_type,
        scheduleType: row.schedule_type,
        cronExpression: row.cron_expression,
        nextRun: row.next_run,
        lastRun: row.last_run,
        lastStatus: row.last_status,
        isActive: row.is_active,
        retryCount: row.retry_count,
        maxRetries: row.max_retries,
        createdAt: row.created_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/scheduled-jobs', async (req, res) => {
    const { jobName, jobType, scheduleType, cronExpression, config } = req.body;
    if (!jobName || !jobType || !scheduleType) {
      return res.status(400).json({ error: 'jobName, jobType, and scheduleType are required' });
    }

    try {
      const row = await queryOne(
        `INSERT INTO scheduled_jobs (job_name, job_type, schedule_type, cron_expression, config, next_run)
         VALUES ($1, $2, $3, $4, $5, now()) RETURNING *`,
        [jobName, jobType, scheduleType, cronExpression || null, config || null]
      );
      res.status(201).json({
        id: row?.id,
        jobName: row?.job_name,
        jobType: row?.job_type,
        isActive: row?.is_active,
        createdAt: row?.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/scheduled-jobs/:id/toggle', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const row = await queryOne(
        `UPDATE scheduled_jobs SET is_active = NOT is_active WHERE id = $1 RETURNING *`,
        [id]
      );
      if (!row) return res.status(404).json({ error: 'Scheduled job not found' });
      res.json({ id: row.id, isActive: row.is_active });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------
  app.get('/api/notifications', async (req, res) => {
    const userId = req.query.userId as string | undefined;
    const status = req.query.status as string | undefined;
    try {
      let sql = 'SELECT * FROM notifications WHERE 1=1';
      const params: any[] = [];
      if (userId) {
        sql += ' AND recipient = $' + (params.length + 1);
        params.push(userId);
      }
      if (status) {
        sql += ' AND status = $' + (params.length + 1);
        params.push(status);
      }
      sql += ' ORDER BY created_at DESC LIMIT 50';
      const { rows } = await query(sql, params);
      res.json(rows.map((row: any) => ({
        id: row.id,
        notificationType: row.notification_type,
        recipient: row.recipient,
        subject: row.subject,
        message: row.message,
        data: row.data,
        status: row.status,
        sentAt: row.sent_at,
        readAt: row.read_at,
        createdAt: row.created_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/notifications', async (req, res) => {
    const { notificationType, recipient, subject, message, data } = req.body;
    if (!notificationType || !recipient || !message) {
      return res.status(400).json({ error: 'notificationType, recipient, and message are required' });
    }

    try {
      const row = await queryOne(
        `INSERT INTO notifications (notification_type, recipient, subject, message, data)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [notificationType, recipient, subject || null, message, data || null]
      );
      res.status(201).json({
        id: row?.id,
        notificationType: row?.notification_type,
        status: row?.status,
        createdAt: row?.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/notifications/:id/mark-read', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const row = await queryOne(
        `UPDATE notifications SET status = 'READ', read_at = now() WHERE id = $1 RETURNING *`,
        [id]
      );
      if (!row) return res.status(404).json({ error: 'Notification not found' });
      res.json({ id: row.id, status: row.status, readAt: row.read_at });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Auto-PO Configuration
  // ---------------------------------------------------------------------------
  app.get('/api/auto-po-config', async (req, res) => {
    const isEnabled = req.query.enabled as string | undefined;
    try {
      let sql = 'SELECT * FROM auto_po_config';
      const params: any[] = [];
      if (isEnabled !== undefined) {
        sql += ' WHERE enabled = $1';
        params.push(isEnabled === 'true');
      }
      sql += ' ORDER BY component_id ASC';
      const { rows } = await query(sql, params);
      res.json(rows.map((row: any) => ({
        id: row.id,
        componentId: row.component_id,
        minStockLevel: row.min_stock_level,
        autoPOThreshold: row.auto_po_threshold,
        preferredSupplier: row.preferred_supplier,
        autoSupplierSelect: row.auto_supplier_select,
        autoApprove: row.auto_approve,
        enabled: row.enabled,
        createdAt: row.created_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auto-po-config', async (req, res) => {
    const { componentId, minStockLevel, autoPOThreshold, preferredSupplier, autoSupplierSelect, autoApprove } = req.body;
    if (!componentId || !minStockLevel || !autoPOThreshold) {
      return res.status(400).json({ error: 'componentId, minStockLevel, and autoPOThreshold are required' });
    }

    try {
      const row = await queryOne(
        `INSERT INTO auto_po_config (component_id, min_stock_level, auto_po_threshold, preferred_supplier, auto_supplier_select, auto_approve)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [componentId, minStockLevel, autoPOThreshold, preferredSupplier || null, autoSupplierSelect ?? true, autoApprove ?? false]
      );
      res.status(201).json({
        id: row?.id,
        componentId: row?.component_id,
        minStockLevel: row?.min_stock_level,
        autoPOThreshold: row?.auto_po_threshold,
        enabled: row?.enabled,
        createdAt: row?.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/auto-po-config/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { minStockLevel, autoPOThreshold, preferredSupplier, autoSupplierSelect, autoApprove, enabled } = req.body;
    try {
      const row = await queryOne(
        `UPDATE auto_po_config SET min_stock_level = COALESCE($1, min_stock_level),
         auto_po_threshold = COALESCE($2, auto_po_threshold), preferred_supplier = COALESCE($3, preferred_supplier),
         auto_supplier_select = COALESCE($4, auto_supplier_select), auto_approve = COALESCE($5, auto_approve),
         enabled = COALESCE($6, enabled), updated_at = now()
         WHERE id = $7 RETURNING *`,
        [minStockLevel ?? null, autoPOThreshold ?? null, preferredSupplier || null, autoSupplierSelect ?? null, autoApprove ?? null, enabled ?? null, id]
      );
      if (!row) return res.status(404).json({ error: 'Auto-PO config not found' });
      res.json({
        id: row.id,
        componentId: row.component_id,
        enabled: row.enabled,
        updatedAt: row.updated_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Event Log (Audit Trail)
  // ---------------------------------------------------------------------------
  app.get('/api/event-log', async (req, res) => {
    const eventType = req.query.eventType as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
    try {
      let sql = 'SELECT * FROM event_log';
      const params: any[] = [];
      if (eventType) {
        sql += ' WHERE event_type = $1';
        params.push(eventType);
      }
      sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
      params.push(limit);
      const { rows } = await query(sql, params);
      res.json(rows.map((row: any) => ({
        id: row.id,
        eventType: row.event_type,
        entityType: row.entity_type,
        entityId: row.entity_id,
        action: row.action,
        userId: row.user_id,
        details: row.details,
        status: row.status,
        createdAt: row.created_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/event-log', async (req, res) => {
    const { eventType, entityType, entityId, action, userId, details, status } = req.body;
    if (!eventType || !action) {
      return res.status(400).json({ error: 'eventType and action are required' });
    }

    try {
      const row = await queryOne(
        `INSERT INTO event_log (event_type, entity_type, entity_id, action, user_id, details, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [eventType, entityType || null, entityId || null, action, userId || null, details || null, status || 'SUCCESS']
      );
      res.status(201).json({
        id: row?.id,
        eventType: row?.event_type,
        status: row?.status,
        createdAt: row?.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Alert Subscriptions
  // ---------------------------------------------------------------------------
  app.get('/api/alert-subscriptions', async (req, res) => {
    const userId = req.query.userId as string | undefined;
    try {
      let sql = 'SELECT * FROM alert_subscriptions';
      const params: any[] = [];
      if (userId) {
        sql += ' WHERE user_id = $1';
        params.push(userId);
      }
      sql += ' ORDER BY created_at DESC';
      const { rows } = await query(sql, params);
      res.json(rows.map((row: any) => ({
        id: row.id,
        userId: row.user_id,
        alertType: row.alert_type,
        channel: row.channel,
        isActive: row.is_active,
        preferences: row.preferences,
        createdAt: row.created_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/alert-subscriptions', async (req, res) => {
    const { userId, alertType, channel, preferences } = req.body;
    if (!userId || !alertType || !channel) {
      return res.status(400).json({ error: 'userId, alertType, and channel are required' });
    }

    try {
      const row = await queryOne(
        `INSERT INTO alert_subscriptions (user_id, alert_type, channel, preferences)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [userId, alertType, channel, preferences || null]
      );
      res.status(201).json({
        id: row?.id,
        userId: row?.user_id,
        alertType: row?.alert_type,
        isActive: row?.is_active,
        createdAt: row?.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/alert-subscriptions/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { isActive, preferences } = req.body;
    try {
      const row = await queryOne(
        `UPDATE alert_subscriptions SET is_active = COALESCE($1, is_active), preferences = COALESCE($2, preferences)
         WHERE id = $3 RETURNING *`,
        [isActive ?? null, preferences || null, id]
      );
      if (!row) return res.status(404).json({ error: 'Alert subscription not found' });
      res.json({ id: row.id, isActive: row.is_active });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Trigger Actions
  // ---------------------------------------------------------------------------
  // Auto-PO Creation. Walks the auto_po_config for a component, checks the
  // stock is below threshold, picks a supplier, creates a PO + one line item,
  // and appends an event_log row so the audit trail shows an auto-generated
  // PO alongside human ones.
  app.post('/api/automation/trigger-auto-po', async (req, res) => {
    const { componentId } = req.body;
    if (!componentId) return res.status(400).json({ error: 'componentId is required' });

    try {
      const config = await queryOne(
        `SELECT * FROM auto_po_config WHERE component_id = $1 AND enabled = true`,
        [componentId]
      );
      if (!config) return res.status(404).json({ error: 'Auto-PO config not found or disabled' });

      const item = await queryOne(`SELECT * FROM inventory WHERE serial_number = $1`, [componentId]);
      if (!item) return res.status(404).json({ error: 'Component not found' });

      if (item.stock > config.auto_po_threshold) {
        return res.json({ message: 'Stock level above threshold, no PO created' });
      }

      // Auto-select supplier or use preferred. Falls back to 'digikey' when
      // neither is available so the PO can still get written and reviewed
      // rather than 500-ing on a missing supplier.
      let supplierId = config.preferred_supplier;
      if (config.auto_supplier_select && !supplierId) {
        const bestSupplier = await queryOne(
          `SELECT supplier FROM supplier_performance WHERE stock_availability_pct > 50 ORDER BY avg_lead_time_days ASC LIMIT 1`
        );
        supplierId = bestSupplier?.supplier || 'digikey';
      }

      const poNumber = `PO-AUTO-${Date.now()}`;
      const po = await queryOne(
        `INSERT INTO purchase_orders (po_number, supplier_id, order_date, status, notes)
         VALUES ($1, $2, now(), $3, $4) RETURNING *`,
        [poNumber, supplierId || null, config.auto_approve ? 'APPROVED' : 'DRAFT', `Auto-generated for ${componentId}`]
      );

      await query(
        `INSERT INTO purchase_order_items (purchase_order_id, component_id, quantity_ordered)
         VALUES ($1, $2, $3)`,
        [po?.id, componentId, Math.max(config.min_stock_level - item.stock, 10)]
      );

      await query(
        `INSERT INTO event_log (event_type, entity_type, entity_id, action, status, details)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['AUTO_PO_CREATED', 'PURCHASE_ORDER', po?.id, 'AUTO_TRIGGER', 'SUCCESS', JSON.stringify({ componentId, supplierId })]
      );

      res.status(201).json({
        poId: po?.id,
        poNumber: po?.po_number,
        status: po?.status,
        createdAt: po?.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Send Alert Notification. Fans a single alert out to every active
  // subscription for the recipient/alertType pair, creating one notification
  // row per subscription so a user with e.g. both email + in-app subscriptions
  // gets both records queued.
  app.post('/api/automation/send-alert', async (req, res) => {
    const { alertType, recipientId, message, data } = req.body;
    if (!alertType || !recipientId || !message) {
      return res.status(400).json({ error: 'alertType, recipientId, and message are required' });
    }

    try {
      const subs = await query(
        `SELECT * FROM alert_subscriptions WHERE user_id = $1 AND alert_type = $2 AND is_active = true`,
        [recipientId, alertType]
      );

      const notifications = [];
      for (const _sub of subs.rows) {
        const notif = await queryOne(
          `INSERT INTO notifications (notification_type, recipient, message, data, status)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [alertType, recipientId, message, data || null, 'PENDING']
        );
        notifications.push(notif);
      }

      await query(
        `INSERT INTO event_log (event_type, entity_type, action, user_id, status, details)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['ALERT_SENT', 'NOTIFICATION', 'AUTO_ALERT', recipientId, 'SUCCESS', JSON.stringify({ alertType, notifCount: notifications.length })]
      );

      res.json({
        notificationsSent: notifications.length,
        notificationIds: notifications.map((n: any) => n.id),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // MPN Enrichment (Supplier Lookup). Currently a stub — it returns a fixed
  // ALI EXPRESS URL for up to 5 items and logs the run. Real DigiKey/Mouser/
  // LCSC integration lives in pricingRoutes; this endpoint exists so a
  // MPN_ENRICHMENT rule (see automation-rules default actions above) has an
  // endpoint to hit without failing the rule run.
  app.post('/api/automation/enrich-missing-suppliers', async (_req, res) => {
    try {
      const itemsToEnrich = await query(
        `SELECT serial_number, name FROM inventory LIMIT 20`
      );

      const enrichedCount = Math.min(itemsToEnrich.rowCount ?? 0, 20);
      const enrichmentResults: any[] = [];

      for (let i = 0; i < Math.min(enrichedCount, 5); i++) {
        const item = itemsToEnrich.rows[i];
        const searchTerm = item.name || item.serial_number;

        enrichmentResults.push({
          serialNumber: item.serial_number,
          name: item.name,
          supplier: 'ALI EXPRESS',
          supplier_url: `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(searchTerm)}`,
          status: 'ENRICHED',
        });
      }

      // Best-effort — a failure to write the audit row must not fail the
      // enrichment call itself.
      try {
        await query(
          `INSERT INTO event_log (event_type, entity_type, action, status, details)
           VALUES ($1, $2, $3, $4, $5)`,
          ['MPN_ENRICHMENT', 'INVENTORY', 'AUTO_SUPPLIER_LOOKUP', 'SUCCESS', JSON.stringify({ itemsProcessed: enrichedCount })]
        );
      } catch (logErr: any) {
        console.error('Error logging enrichment:', logErr.message);
      }

      res.json({
        message: 'MPN enrichment completed',
        itemsProcessed: enrichedCount,
        results: enrichmentResults,
      });
    } catch (err: any) {
      console.error('Enrichment endpoint error:', err.message, err.stack);
      res.status(500).json({ error: err.message });
    }
  });
}
