// Each person's own preferences, kept with their account so they follow them
// to any PC or browser (the shared `settings` table holds one value for
// everyone). For now just the display size (see ./displaySize).
//
//   GET /api/me/preferences   the signed-in user's preferences
//   PUT /api/me/preferences   {displaySize} — only the caller's own row

import type { Express } from 'express';
import { z } from 'zod';
import { exec, query, queryOne } from './db';
import { DISPLAY_SIZE_KEYS } from './displaySize';

export async function ensureUserPrefsSchema(run: (sql: string) => Promise<void> = exec): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INTEGER PRIMARY KEY,
    prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

const PrefsSchema = z.object({
  displaySize: z.enum(DISPLAY_SIZE_KEYS).optional(),
}).strict();

export function registerUserPrefsRoutes(app: Express): void {
  app.get('/api/me/preferences', async (req: any, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Sign in required' });
    try {
      const row = await queryOne<{ prefs: any }>(`SELECT prefs FROM user_preferences WHERE user_id = $1`, [req.user.id]);
      res.json(row?.prefs ?? {});
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/me/preferences', async (req: any, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Sign in required' });
    const parsed = PrefsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Unknown preference or value.' });
    try {
      const { rows } = await query<{ prefs: any }>(
        `INSERT INTO user_preferences (user_id, prefs, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (user_id) DO UPDATE SET prefs = user_preferences.prefs || EXCLUDED.prefs, updated_at = now()
         RETURNING prefs`,
        [req.user.id, JSON.stringify(parsed.data)]
      );
      res.json(rows[0]?.prefs ?? parsed.data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
