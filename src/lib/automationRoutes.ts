// Automation surface: rules, scheduled jobs, notifications, the event log.
//
//   GET    /api/automation/options               what a rule can watch and how often it can run
//   GET    /api/automation-rules                 every rule, with its last run
//   POST   /api/automation-rules                 {ruleName, triggerEvent, conditions?: {prefix}, action: {type, to?}, every?, isActive?}
//   PUT    /api/automation-rules/:id             the same fields, any of them
//   DELETE /api/automation-rules/:id
//   GET    /api/automation-rules/:id/preview     what it would find now (changes nothing)
//   POST   /api/automation-rules/:id/run         run it now
//   GET    /api/automation-rules/:id/runs        its last runs
//   GET    /api/scheduled-jobs                   the app's background jobs (./scheduledJobs)
//   PUT    /api/scheduled-jobs/:key/toggle       {active}
//   POST   /api/scheduled-jobs/:key/run          run it now
//   GET    /api/notifications?mine=1&status=     the inbox: for everyone, the user's role, or the user
//   GET    /api/notifications/unread-count       the user's unread
//   PUT    /api/notifications/:id/mark-read
//   PUT    /api/notifications/mark-all-read      the user's
//   GET    /api/event-log?type=&status=&q=&before=&limit=
//   GET    /api/event-log/types
//   alert subscriptions and send-alert (below), and enrich-missing-suppliers.
// Rules run by ./automationEngine. Writes need automation.create / .delete (./writeAccess).

import type { Express } from 'express';
import { query, queryOne } from './db';
import { TRIGGERS, EVERY, isTrigger, actionOf, recipientOf, runRule, type Action, type Trigger } from './automationEngine';
import { listJobs, runJob, setJobActive } from './scheduledJobs';
import { draftAutoPos } from './autoPoRoutes';

const httpError = (res: any, err: any) => res.status(err.status || 500).json({ error: err.message });

const mapRule = (row: any) => ({
  id: row.id,
  ruleName: row.rule_name,
  ruleType: row.rule_type,
  description: row.description,
  triggerEvent: row.trigger_event,
  triggerLabel: isTrigger(row.trigger_event) ? TRIGGERS[row.trigger_event as Trigger].label : null,
  conditions: row.conditions ?? {},
  action: actionOf(row.actions),
  every: row.every ?? null,
  isActive: row.is_active !== false,
  priority: row.priority,
  lastRunAt: row.last_run_at ?? null,
  lastResult: row.last_result ?? null,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** A rule's fields from a request; `partial` for an edit. Returns an error message or the columns to set. */
function ruleFields(b: any, partial: boolean): Record<string, unknown> | string {
  const out: Record<string, unknown> = {};
  if (!partial || b.ruleName !== undefined) {
    const name = String(b.ruleName ?? '').trim();
    if (!name) return 'Give the rule a name.';
    out.rule_name = name.slice(0, 120);
  }
  if (b.description !== undefined) out.description = String(b.description ?? '').trim() || null;
  if (!partial || b.triggerEvent !== undefined) {
    if (!isTrigger(b.triggerEvent)) return 'Choose what the rule watches.';
    out.trigger_event = b.triggerEvent;
  }
  if (b.conditions !== undefined) {
    const prefix = String(b.conditions?.prefix ?? '').trim().toUpperCase();
    out.conditions = JSON.stringify(prefix ? { prefix } : {});
  }
  if (!partial || b.action !== undefined) {
    const t = b.action?.type;
    if (t !== 'NOTIFY' && t !== 'DRAFT_PO') return 'Choose what the rule does.';
    const action: Action = t === 'DRAFT_PO' ? { type: 'DRAFT_PO' } : { type: 'NOTIFY', to: recipientOf(b.action?.to) };
    const trigger = out.trigger_event ?? b.currentTrigger;
    if (action.type === 'DRAFT_PO' && trigger !== undefined && trigger !== 'AUTO_PO_DUE') return 'Drafting purchase orders goes with watching the Auto-PO items (it orders them back up to their minimum level).';
    out.actions = JSON.stringify(action);
    out.rule_type = action.type;
  }
  if (b.every !== undefined) {
    if (b.every !== null && b.every !== '' && !Object.hasOwn(EVERY, String(b.every))) return 'Choose how often it runs.';
    out.every = b.every || null;
  } else if (!partial) out.every = 'day';
  if (b.isActive !== undefined) out.is_active = !!b.isActive;
  if (b.priority !== undefined) out.priority = Number(b.priority) || 0;
  return out;
}

export function registerAutomationRoutes(app: Express): void {
  app.get('/api/automation/options', (_req, res) => {
    res.json({
      triggers: Object.entries(TRIGGERS).map(([key, t]) => ({ key, label: t.label, items: t.items })),
      every: Object.entries(EVERY).map(([key, label]) => ({ key, label })),
    });
  });

  // ---------------------------------------------------------------------------
  // Automation Rules
  // ---------------------------------------------------------------------------
  app.get('/api/automation-rules', async (req, res) => {
    const isActive = req.query.isActive as string | undefined;
    try {
      const { rows } = await query(`SELECT * FROM automation_rules${isActive !== undefined ? ' WHERE is_active = $1' : ''} ORDER BY priority DESC, rule_name`,
        isActive !== undefined ? [isActive === 'true'] : []);
      res.json(rows.map(mapRule));
    } catch (err) { httpError(res, err); }
  });

  app.post('/api/automation-rules', async (req: any, res) => {
    const f = ruleFields(req.body ?? {}, false);
    if (typeof f === 'string') return res.status(400).json({ error: f });
    try {
      const fields: Record<string, unknown> = { ...f, is_active: f.is_active ?? true, created_by: req.user?.email ?? null };
      const cols = Object.keys(fields);
      const row = await queryOne(`INSERT INTO automation_rules (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, Object.values(fields));
      res.status(201).json(mapRule(row));
    } catch (err) { httpError(res, err); }
  });

  app.put('/api/automation-rules/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const current = await queryOne(`SELECT trigger_event FROM automation_rules WHERE id = $1`, [id]);
      if (!current) return res.status(404).json({ error: 'Rule not found.' });
      const f = ruleFields({ ...(req.body ?? {}), currentTrigger: current.trigger_event }, true);
      if (typeof f === 'string') return res.status(400).json({ error: f });
      // Watching something else: it starts afresh, so everything it finds is new.
      if (f.trigger_event !== undefined && f.trigger_event !== current.trigger_event) await query(`DELETE FROM automation_rule_hits WHERE rule_id = $1`, [id]);
      const cols = Object.keys(f);
      if (!cols.length) return res.status(400).json({ error: 'Nothing to change.' });
      const row = await queryOne(`UPDATE automation_rules SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`, [...Object.values(f), id]);
      res.json(mapRule(row));
    } catch (err) { httpError(res, err); }
  });

  app.delete('/api/automation-rules/:id', async (req, res) => {
    try {
      const { rowCount } = await query(`DELETE FROM automation_rules WHERE id = $1`, [parseInt(req.params.id)]);
      if (!rowCount) return res.status(404).json({ error: 'Rule not found.' });
      res.json({ ok: true });
    } catch (err) { httpError(res, err); }
  });

  app.get('/api/automation-rules/:id/preview', async (req: any, res) => {
    try { res.json(await runRule(parseInt(req.params.id), req.user?.email ?? 'unknown', { preview: true })); }
    catch (err) { httpError(res, err); }
  });

  app.post('/api/automation-rules/:id/run', async (req: any, res) => {
    try { res.json(await runRule(parseInt(req.params.id), req.user?.email ?? 'unknown', { draftPos: draftAutoPos })); }
    catch (err) { httpError(res, err); }
  });

  app.get('/api/automation-rules/:id/runs', async (req, res) => {
    try {
      const { rows } = await query(`SELECT id, triggered_by, status, result_data, error_message, execution_time_ms, executed_at FROM automation_executions WHERE rule_id = $1 ORDER BY id DESC LIMIT 20`, [parseInt(req.params.id)]);
      res.json(rows);
    } catch (err) { httpError(res, err); }
  });

  // ---------------------------------------------------------------------------
  // Scheduled Jobs: the app's own background jobs.
  // ---------------------------------------------------------------------------
  app.get('/api/scheduled-jobs', async (_req, res) => {
    try { res.json(await listJobs()); } catch (err) { httpError(res, err); }
  });

  app.put('/api/scheduled-jobs/:key/toggle', async (req, res) => {
    try { await setJobActive(req.params.key, req.body?.active !== false); res.json({ ok: true }); } catch (err) { httpError(res, err); }
  });

  app.post('/api/scheduled-jobs/:key/run', async (req: any, res) => {
    try {
      const job = (await listJobs()).find((j) => j.key === req.params.key);
      if (!job) return res.status(404).json({ error: 'No such job.' });
      if (!job.runNow) return res.status(400).json({ error: `${job.name} is run from its own page.` });
      res.json(await runJob(job.key, req.user?.email ?? 'unknown'));
    } catch (err) { httpError(res, err); }
  });

  // ---------------------------------------------------------------------------
  // Notifications: the in-app inbox.
  // ---------------------------------------------------------------------------
  // Whose a notification is: everyone's, the user's role's, or the user's own.
  const mine = (req: any, params: any[]) => {
    params.push(['everyone', `role:${req.user?.role ?? ''}`, String(req.user?.email ?? '').toLowerCase()]);
    return `LOWER(recipient) = ANY($${params.length}::text[])`;
  };
  const mapNotification = (row: any) => ({
    id: row.id, notificationType: row.notification_type, recipient: row.recipient, subject: row.subject, message: row.message,
    data: row.data, status: row.status, read: row.status === 'READ', readAt: row.read_at, createdAt: row.created_at,
  });

  app.get('/api/notifications', async (req: any, res) => {
    const params: any[] = []; const where: string[] = [];
    if (req.query.mine) where.push(mine(req, params));
    if (req.query.userId) { params.push(req.query.userId); where.push(`recipient = $${params.length}`); }
    if (req.query.status === 'unread') where.push(`status <> 'READ'`);
    else if (req.query.status) { params.push(req.query.status); where.push(`status = $${params.length}`); }
    try {
      const { rows } = await query(`SELECT * FROM notifications${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT 100`, params);
      res.json(rows.map(mapNotification));
    } catch (err) { httpError(res, err); }
  });

  app.get('/api/notifications/unread-count', async (req: any, res) => {
    const params: any[] = [];
    try { const row = await queryOne(`SELECT COUNT(*)::int AS n FROM notifications WHERE status <> 'READ' AND ${mine(req, params)}`, params); res.json({ unread: row?.n ?? 0 }); }
    catch (err) { httpError(res, err); }
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
      res.status(201).json(mapNotification(row));
    } catch (err) { httpError(res, err); }
  });

  app.put('/api/notifications/mark-all-read', async (req: any, res) => {
    const params: any[] = [];
    try { const { rowCount } = await query(`UPDATE notifications SET status = 'READ', read_at = now() WHERE status <> 'READ' AND ${mine(req, params)}`, params); res.json({ marked: rowCount }); }
    catch (err) { httpError(res, err); }
  });

  app.put('/api/notifications/:id/mark-read', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const row = await queryOne(`UPDATE notifications SET status = 'READ', read_at = now() WHERE id = $1 RETURNING *`, [id]);
      if (!row) return res.status(404).json({ error: 'Notification not found' });
      res.json(mapNotification(row));
    } catch (err) { httpError(res, err); }
  });

  // ---------------------------------------------------------------------------
  // Event Log
  // ---------------------------------------------------------------------------
  app.get('/api/event-log', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
    const params: any[] = []; const where: string[] = [];
    const type = (req.query.type ?? req.query.eventType) as string | undefined;
    if (type) { params.push(type); where.push(`event_type = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); where.push(`status = $${params.length}`); }
    if (req.query.q) {
      params.push(`%${String(req.query.q).trim()}%`);
      where.push(`(event_type ILIKE $${params.length} OR entity_id ILIKE $${params.length} OR action ILIKE $${params.length} OR user_id ILIKE $${params.length} OR error_message ILIKE $${params.length} OR details::text ILIKE $${params.length})`);
    }
    if (req.query.before) { params.push(parseInt(req.query.before as string)); where.push(`id < $${params.length}`); }
    params.push(limit);
    try {
      const { rows } = await query(`SELECT * FROM event_log${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${params.length}`, params);
      res.json(rows.map((row: any) => ({
        id: row.id, eventType: row.event_type, entityType: row.entity_type, entityId: row.entity_id, action: row.action,
        userId: row.user_id, details: row.details, status: row.status, errorMessage: row.error_message, createdAt: row.created_at,
      })));
    } catch (err) { httpError(res, err); }
  });

  app.get('/api/event-log/types', async (_req, res) => {
    try { const { rows } = await query(`SELECT event_type, COUNT(*)::int AS n FROM event_log GROUP BY 1 ORDER BY 1`); res.json(rows.map((r: any) => ({ type: r.event_type, count: r.n }))); }
    catch (err) { httpError(res, err); }
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
      res.status(201).json({ id: row?.id, eventType: row?.event_type, status: row?.status, createdAt: row?.created_at });
    } catch (err) { httpError(res, err); }
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

  // Items with no supplier part number, for the Pricing page's button. This
  // used to answer with made-up AliExpress search links; it now says which
  // items need one (Items > part-number fill-in and the supplier lookups fill them).
  app.post('/api/automation/enrich-missing-suppliers', async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT serial_number, name FROM inventory WHERE deleted IS NOT TRUE
           AND ${[1, 2, 3, 4, 5].map((i) => `COALESCE(TRIM(sup_pn_${i}), '') = ''`).join(' AND ')} ORDER BY serial_number`);
      await query(`INSERT INTO event_log (event_type, entity_type, action, status, details) VALUES ('MISSING_SUPPLIER_CHECK', 'INVENTORY', 'CHECK', 'SUCCESS', $1)`,
        [JSON.stringify({ missing: rows.length })]).catch(() => {});
      res.json({ itemsProcessed: 0, missing: rows.length, items: rows.slice(0, 200).map((r: any) => ({ serialNumber: r.serial_number, name: r.name })) });
    } catch (err) { httpError(res, err); }
  });
}
