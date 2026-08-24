import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, ExternalLink, Plus, Pencil, Trash2, Save, X } from 'lucide-react';

interface DocLink {
  id: number;
  title: string;
  description: string;
  url: string;
  sortOrder: number;
  updatedAt: string;
  updatedBy?: string | null;
}

interface DocumentationViewProps {
  currentUserRole?: string;
  triggerToast: (msg: string, type?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
}

// A simple registry of documentation links. Anyone can browse; admins can
// add, edit, or remove entries. Each row opens the linked doc in a new tab —
// the target can be anything: a static HTML page in /public, a Notion doc,
// a PDF on a Fly Volume, an internal wiki URL.
export const DocumentationView: React.FC<DocumentationViewProps> = ({ currentUserRole, triggerToast }) => {
  const isAdmin = (currentUserRole || '').toLowerCase() === 'admin';
  const [docs, setDocs] = useState<DocLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ mode: 'create' | 'edit'; doc?: DocLink } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/docs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDocs(await res.json());
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load docs', 'ERROR');
    } finally {
      setLoading(false);
    }
  }, [triggerToast]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (doc: DocLink) => {
    if (!confirm(`Remove "${doc.title}" from the docs page? The linked file itself is not touched.`)) return;
    try {
      const res = await fetch(`/api/docs/${doc.id}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      triggerToast('Doc removed.', 'SUCCESS');
      await load();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to remove', 'ERROR');
    }
  };

  const openLink = (url: string) => {
    const w = window.open(url, '_blank', 'noopener,noreferrer');
    if (!w) window.location.href = url;
  };

  return (
    <div className="p-container-margin max-w-5xl mx-auto w-full">
      <div className="flex flex-col md:flex-row md:justify-between md:items-end gap-md mb-lg">
        <div className="min-w-0">
          <h3 className="font-headline-sm text-lg text-on-surface flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-primary" /> Documentation
          </h3>
          <p className="text-on-surface-variant font-body-sm">
            {isAdmin
              ? 'Curate the list of docs your team should read. Point each entry at wherever the doc lives.'
              : 'Curated links to guides and reference material.'}
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => setEditing({ mode: 'create' })}
            className="bg-primary text-on-primary px-3 py-1.5 rounded-lg font-bold text-xs shadow-md hover:brightness-110 active:scale-95 transition-all flex items-center gap-1.5 self-start md:self-auto"
          >
            <Plus className="w-3.5 h-3.5" /> Add doc
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-xs text-on-surface-variant italic p-4">Loading…</div>
      ) : docs.length === 0 ? (
        <div className="bg-surface-container border border-dashed border-outline-variant/60 rounded-xl p-8 text-center">
          <BookOpen className="w-8 h-8 text-outline mx-auto mb-2" />
          <p className="text-sm text-on-surface-variant">No docs yet.</p>
          {isAdmin && (
            <p className="text-xs text-outline mt-1">Click <span className="font-bold">Add doc</span> to link the first one.</p>
          )}
        </div>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-md">
          {docs.map(doc => (
            <li key={doc.id} className="bg-surface-container border border-outline-variant rounded-xl p-md hover:border-primary/40 transition-colors group">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                  <BookOpen className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <button
                    onClick={() => openLink(doc.url)}
                    className="text-left w-full"
                  >
                    <div className="font-bold text-on-surface text-sm group-hover:text-primary transition-colors flex items-center gap-1.5">
                      {doc.title}
                      <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-70 transition-opacity" />
                    </div>
                    {doc.description && (
                      <p className="text-xs text-on-surface-variant mt-0.5 line-clamp-2">{doc.description}</p>
                    )}
                    <div className="text-[10px] text-outline mt-1 font-mono truncate" title={doc.url}>
                      {doc.url}
                    </div>
                  </button>
                </div>
                {isAdmin && (
                  <div className="flex flex-col gap-1 shrink-0">
                    <button
                      onClick={() => setEditing({ mode: 'edit', doc })}
                      className="p-1 text-on-surface-variant hover:text-primary hover:bg-primary/10 rounded"
                      title="Edit"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(doc)}
                      className="p-1 text-on-surface-variant hover:text-error hover:bg-error/10 rounded"
                      title="Remove"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <DocLinkEditor
          mode={editing.mode}
          doc={editing.doc}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
          triggerToast={triggerToast}
        />
      )}
    </div>
  );
};

interface DocLinkEditorProps {
  mode: 'create' | 'edit';
  doc?: DocLink;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  triggerToast: (msg: string, type?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
}

const DocLinkEditor: React.FC<DocLinkEditorProps> = ({ mode, doc, onClose, onSaved, triggerToast }) => {
  const [title, setTitle] = useState(doc?.title || '');
  const [description, setDescription] = useState(doc?.description || '');
  const [url, setUrl] = useState(doc?.url || '');
  const [sortOrder, setSortOrder] = useState<number>(doc?.sortOrder ?? 100);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !url.trim()) {
      triggerToast('Title and URL are required', 'ERROR');
      return;
    }
    setSaving(true);
    try {
      const payload = { title: title.trim(), description: description.trim(), url: url.trim(), sortOrder };
      const endpoint = mode === 'create' ? '/api/docs' : `/api/docs/${doc!.id}`;
      const method = mode === 'create' ? 'POST' : 'PUT';
      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      triggerToast(mode === 'create' ? 'Doc added' : 'Doc updated', 'SUCCESS');
      await onSaved();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to save', 'ERROR');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center pt-[10vh] px-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg bg-surface border border-outline-variant rounded-xl shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="font-headline-sm text-lg font-black text-on-surface">
            {mode === 'create' ? 'Add doc link' : 'Edit doc link'}
          </h2>
          <button onClick={onClose} className="p-1 text-on-surface-variant hover:text-on-surface rounded" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={submit} className="p-lg space-y-md">
          <div>
            <label className="block text-[10px] font-bold uppercase text-outline mb-1">Title</label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Complete User Guide"
              required autoFocus
              className="w-full bg-surface-container-high border border-outline-variant rounded px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase text-outline mb-1">Description (optional)</label>
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="One-line summary shown under the title"
              className="w-full bg-surface-container-high border border-outline-variant rounded px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase text-outline mb-1">Link URL</label>
            <input
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://…  or  /file-in-public.html"
              required
              className="w-full bg-surface-container-high border border-outline-variant rounded px-3 py-2 text-sm font-mono outline-none focus:border-primary"
            />
            <p className="text-[10px] text-outline mt-1">
              External URL (Notion, Google Doc, etc.) or a path served by the app (e.g. <span className="font-mono">/tracklab-complete-guide.html</span>).
            </p>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase text-outline mb-1">Sort order (lower = higher in list)</label>
            <input
              type="number" min={0} max={9999}
              value={sortOrder}
              onChange={e => setSortOrder(parseInt(e.target.value) || 0)}
              className="w-32 bg-surface-container-high border border-outline-variant rounded px-3 py-2 text-sm font-mono outline-none focus:border-primary"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-outline-variant/40">
            <button type="button" onClick={onClose}
                    className="text-xs px-3 py-2 rounded bg-surface-container-high hover:bg-surface-container-highest border border-outline-variant font-bold">
              Cancel
            </button>
            <button type="submit" disabled={saving || !title.trim() || !url.trim()}
                    className="text-xs px-3 py-2 rounded bg-primary text-on-primary font-bold hover:brightness-110 disabled:opacity-50 flex items-center gap-1.5">
              <Save className="w-3.5 h-3.5" />
              {saving ? 'Saving…' : mode === 'create' ? 'Add doc' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
