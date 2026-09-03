// Documentation-link registry extracted from server.ts. A simple set of
// clickable docs (title, description, URL, optional uploaded file). Everyone
// can list; only admins can mutate. Not a CMS — the URL points wherever the
// doc actually lives (Notion, Google Doc, static HTML, PDF stored inline).
//
// Depends on requireAdmin from authRoutes so the admin-gate contract stays in
// one place. Shares DocLinkSchema/mapDocLink/parseDataUrl from serverUtils so
// the wire format is testable without booting Express.

import type { Express } from 'express';
import { z } from 'zod';
import { query, queryOne } from './db';
import { DocLinkSchema, mapDocLink, parseDataUrl, validateBody } from './serverUtils';
import { requireAdmin } from './authRoutes';

export function registerDocsRoutes(app: Express): void {
  app.get('/api/docs', async (_req, res) => {
    try {
      // NB: don't select file_data — it can be 10MB per row. Only the file
      // presence flag comes back for the list.
      const { rows } = await query(
        `SELECT id, title, description, url, file_name, file_mime,
                (file_data IS NOT NULL) AS has_data,
                sort_order, updated_at, updated_by
           FROM app_docs
          ORDER BY sort_order ASC, title ASC`
      );
      res.json(rows.map((r: any) => mapDocLink({ ...r, file_data: r.has_data ? '1' : null })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Streams a stored attachment back with its recorded content type.
  app.get('/api/docs/:id/file', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const row = await queryOne<any>(
        `SELECT file_name, file_mime, file_data FROM app_docs WHERE id = $1`, [id]);
      if (!row || !row.file_data) return res.status(404).json({ error: 'No file for this doc' });
      const buf = Buffer.from(row.file_data, 'base64');
      res.setHeader('Content-Type', row.file_mime || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${(row.file_name || 'file').replace(/"/g, '')}"`);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(buf);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/docs', requireAdmin, validateBody(DocLinkSchema), async (req: any, res) => {
    const body = req.body as z.infer<typeof DocLinkSchema>;
    let fileName: string | null = null;
    let fileMime: string | null = null;
    let fileData: string | null = null;
    if (body.file) {
      const parsed = parseDataUrl(body.file.data);
      if (!parsed) return res.status(400).json({ error: 'File must be a data:<mime>;base64,<data> URL' });
      fileName = body.file.name;
      fileMime = body.file.mime || parsed.mime;
      fileData = parsed.body;
    }
    try {
      const { rows } = await query(
        `INSERT INTO app_docs (title, description, url, sort_order, updated_by, file_name, file_mime, file_data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, title, description, url, sort_order, updated_at, updated_by, file_name, file_mime,
                     (file_data IS NOT NULL) AS has_data`,
        [body.title, body.description, body.url || null, body.sortOrder ?? 100, req.user?.email || null,
         fileName, fileMime, fileData]
      );
      const r = rows[0];
      res.status(201).json(mapDocLink({ ...r, file_data: r.has_data ? '1' : null }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/docs/:id', requireAdmin, validateBody(DocLinkSchema), async (req: any, res) => {
    const id = parseInt(req.params.id);
    const body = req.body as z.infer<typeof DocLinkSchema>;
    try {
      // Three cases: attach a fresh file, drop the existing file, or leave the
      // attachment untouched. Doing it as one UPDATE keeps it atomic and avoids
      // two separate round trips.
      let sqlText: string;
      let params: any[];
      if (body.file) {
        const parsed = parseDataUrl(body.file.data);
        if (!parsed) return res.status(400).json({ error: 'File must be a data:<mime>;base64,<data> URL' });
        sqlText = `UPDATE app_docs
                      SET title = $1, description = $2, url = $3, sort_order = $4,
                          updated_at = CURRENT_TIMESTAMP, updated_by = $5,
                          file_name = $6, file_mime = $7, file_data = $8
                    WHERE id = $9
                    RETURNING id, title, description, url, sort_order, updated_at, updated_by,
                              file_name, file_mime, (file_data IS NOT NULL) AS has_data`;
        params = [body.title, body.description, body.url || null, body.sortOrder ?? 100,
                  req.user?.email || null, body.file.name, body.file.mime || parsed.mime, parsed.body, id];
      } else if (body.removeFile) {
        sqlText = `UPDATE app_docs
                      SET title = $1, description = $2, url = $3, sort_order = $4,
                          updated_at = CURRENT_TIMESTAMP, updated_by = $5,
                          file_name = NULL, file_mime = NULL, file_data = NULL
                    WHERE id = $6
                    RETURNING id, title, description, url, sort_order, updated_at, updated_by,
                              file_name, file_mime, (file_data IS NOT NULL) AS has_data`;
        params = [body.title, body.description, body.url || null, body.sortOrder ?? 100,
                  req.user?.email || null, id];
      } else {
        sqlText = `UPDATE app_docs
                      SET title = $1, description = $2, url = $3, sort_order = $4,
                          updated_at = CURRENT_TIMESTAMP, updated_by = $5
                    WHERE id = $6
                    RETURNING id, title, description, url, sort_order, updated_at, updated_by,
                              file_name, file_mime, (file_data IS NOT NULL) AS has_data`;
        params = [body.title, body.description, body.url || null, body.sortOrder ?? 100,
                  req.user?.email || null, id];
      }
      const { rows } = await query(sqlText, params);
      if (rows.length === 0) return res.status(404).json({ error: 'Doc not found' });
      const r = rows[0];
      res.json(mapDocLink({ ...r, file_data: r.has_data ? '1' : null }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/docs/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const { rowCount } = await query(`DELETE FROM app_docs WHERE id = $1`, [id]);
      if (rowCount === 0) return res.status(404).json({ error: 'Doc not found' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
