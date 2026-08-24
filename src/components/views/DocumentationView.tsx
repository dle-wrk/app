import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { BookOpen, Plus, Pencil, Trash2, Save, X, FileText, ChevronRight } from 'lucide-react';

interface DocSummary {
  id: number;
  slug: string;
  title: string;
  category: string;
  sortOrder: number;
  updatedAt: string;
}

interface Doc extends DocSummary {
  content: string;
  updatedBy?: string | null;
}

interface DocumentationViewProps {
  currentUserRole?: string;
  triggerToast: (msg: string, type?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
}

// In-app documentation. Everyone can read; admins get the editor overlays.
// Kept intentionally simple — a list on the left, rendered markdown on the
// right, and one modal for create/edit. No heavy CMS features; if we outgrow
// this shape we swap for a proper docs static-site generator.
export const DocumentationView: React.FC<DocumentationViewProps> = ({ currentUserRole, triggerToast }) => {
  const isAdmin = (currentUserRole || '').toLowerCase() === 'admin';

  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [current, setCurrent] = useState<Doc | null>(null);
  const [loading, setLoading] = useState(true);
  const [contentLoading, setContentLoading] = useState(false);
  const [editorOpen, setEditorOpen] = useState<{ mode: 'create' | 'edit'; doc?: Doc } | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/docs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = (await res.json()) as DocSummary[];
      setDocs(list);
      // Auto-select the first doc when nothing's picked so the empty state
      // isn't the default view when docs already exist.
      setSelectedSlug(prev => prev ?? (list[0]?.slug || null));
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load docs', 'ERROR');
    } finally {
      setLoading(false);
    }
  }, [triggerToast]);

  const loadDoc = useCallback(async (slug: string) => {
    setContentLoading(true);
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCurrent(await res.json());
    } catch (err: any) {
      setCurrent(null);
      triggerToast(err.message || 'Failed to load doc', 'ERROR');
    } finally {
      setContentLoading(false);
    }
  }, [triggerToast]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => {
    if (selectedSlug) loadDoc(selectedSlug); else setCurrent(null);
  }, [selectedSlug, loadDoc]);

  const grouped = useMemo(() => {
    const byCategory = new Map<string, DocSummary[]>();
    for (const doc of docs) {
      const cat = doc.category || 'General';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(doc);
    }
    return Array.from(byCategory.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [docs]);

  const handleDelete = async (doc: Doc) => {
    if (!confirm(`Delete "${doc.title}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/docs/${doc.id}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      triggerToast(`Deleted "${doc.title}"`, 'SUCCESS');
      setSelectedSlug(null);
      setCurrent(null);
      await loadList();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to delete doc', 'ERROR');
    }
  };

  return (
    <div className="p-container-margin max-w-7xl mx-auto w-full">
      <div className="flex flex-col md:flex-row md:justify-between md:items-end gap-md mb-lg">
        <div className="min-w-0">
          <h3 className="font-headline-sm text-lg text-on-surface flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-primary" /> Documentation
          </h3>
          <p className="text-on-surface-variant font-body-sm">
            Team-editable knowledge base. {isAdmin ? 'Admins can add, edit, and remove pages.' : 'Read-only for viewers.'}
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => setEditorOpen({ mode: 'create' })}
            className="bg-primary text-on-primary px-3 py-1.5 rounded-lg font-bold text-xs shadow-md hover:brightness-110 active:scale-95 transition-all flex items-center gap-1.5 self-start md:self-auto"
          >
            <Plus className="w-3.5 h-3.5" /> New page
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-lg">
        {/* Left rail: categories → docs */}
        <aside className="bg-surface-container border border-outline-variant rounded-xl p-3 h-fit md:sticky md:top-4 overflow-y-auto max-h-[75vh]">
          {loading ? (
            <div className="text-xs text-on-surface-variant italic p-3">Loading…</div>
          ) : docs.length === 0 ? (
            <div className="text-xs text-on-surface-variant italic p-3">
              No pages yet.{isAdmin ? ' Click "New page" to add the first one.' : ' Ask an admin to add some.'}
            </div>
          ) : (
            grouped.map(([category, items]) => (
              <div key={category} className="mb-3">
                <div className="text-[10px] font-bold uppercase tracking-wider text-outline px-2 mb-1">{category}</div>
                <ul className="space-y-0.5">
                  {items.map(doc => {
                    const active = doc.slug === selectedSlug;
                    return (
                      <li key={doc.id}>
                        <button
                          onClick={() => setSelectedSlug(doc.slug)}
                          className={`w-full text-left flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
                            active
                              ? 'bg-primary/15 text-primary font-bold'
                              : 'text-on-surface-variant hover:bg-surface-variant/40 hover:text-on-surface'
                          }`}
                        >
                          <FileText className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate flex-1">{doc.title}</span>
                          {active && <ChevronRight className="w-3 h-3 shrink-0" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </aside>

        {/* Right pane: rendered doc */}
        <section className="bg-surface-container border border-outline-variant rounded-xl p-lg min-h-[60vh]">
          {contentLoading ? (
            <div className="text-xs text-on-surface-variant italic">Loading page…</div>
          ) : !current ? (
            <div className="text-center text-on-surface-variant text-sm mt-8">
              {docs.length === 0
                ? 'No documentation yet.'
                : 'Pick a page from the left to read it.'}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-md mb-md pb-md border-b border-outline-variant/40">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-outline font-bold">{current.category}</div>
                  <h2 className="font-headline-md text-xl md:text-2xl font-black text-on-surface mt-0.5">{current.title}</h2>
                  <div className="text-[10px] text-outline mt-1">
                    Updated {new Date(current.updatedAt).toLocaleString()}
                    {current.updatedBy && ` · by ${current.updatedBy}`}
                  </div>
                </div>
                {isAdmin && (
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => setEditorOpen({ mode: 'edit', doc: current })}
                      className="text-xs bg-surface-container-high hover:bg-surface-container-highest border border-outline-variant px-2.5 py-1.5 rounded font-bold flex items-center gap-1"
                    >
                      <Pencil className="w-3.5 h-3.5" /> Edit
                    </button>
                    <button
                      onClick={() => handleDelete(current)}
                      className="text-xs bg-error/10 hover:bg-error/20 text-error border border-error/30 px-2.5 py-1.5 rounded font-bold flex items-center gap-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Delete
                    </button>
                  </div>
                )}
              </div>
              <article className="prose-doc">
                {current.content.trim() ? (
                  <ReactMarkdown>{current.content}</ReactMarkdown>
                ) : (
                  <p className="text-sm text-on-surface-variant italic">This page has no content yet.</p>
                )}
              </article>
            </>
          )}
        </section>
      </div>

      {editorOpen && (
        <DocEditor
          mode={editorOpen.mode}
          doc={editorOpen.doc}
          existingCategories={Array.from(new Set(docs.map(d => d.category))).sort()}
          onClose={() => setEditorOpen(null)}
          onSaved={async (saved) => {
            setEditorOpen(null);
            await loadList();
            setSelectedSlug(saved.slug);
          }}
          triggerToast={triggerToast}
        />
      )}
    </div>
  );
};

interface DocEditorProps {
  mode: 'create' | 'edit';
  doc?: Doc;
  existingCategories: string[];
  onClose: () => void;
  onSaved: (doc: Doc) => void | Promise<void>;
  triggerToast: (msg: string, type?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
}

const DocEditor: React.FC<DocEditorProps> = ({ mode, doc, existingCategories, onClose, onSaved, triggerToast }) => {
  const [title, setTitle] = useState(doc?.title || '');
  const [slug, setSlug] = useState(doc?.slug || '');
  const [category, setCategory] = useState(doc?.category || 'General');
  const [content, setContent] = useState(doc?.content || '');
  const [sortOrder, setSortOrder] = useState<number>(doc?.sortOrder ?? 100);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  // Track whether the user has hand-edited the slug — if not, auto-derive
  // from the title as they type. Once they touch the slug field we back off.
  const [slugDirty, setSlugDirty] = useState(mode === 'edit');

  const autoSlug = useMemo(() => title.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, ''), [title]);

  useEffect(() => {
    if (!slugDirty) setSlug(autoSlug);
  }, [autoSlug, slugDirty]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      triggerToast('Title is required', 'ERROR');
      return;
    }
    setSaving(true);
    try {
      const payload = { title, slug: slug || autoSlug, category, content, sortOrder };
      const url = mode === 'create' ? '/api/docs' : `/api/docs/${doc!.id}`;
      const method = mode === 'create' ? 'POST' : 'PUT';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      triggerToast(mode === 'create' ? 'Page created' : 'Page updated', 'SUCCESS');
      await onSaved(body);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to save', 'ERROR');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center pt-[5vh] px-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-4xl bg-surface border border-outline-variant rounded-xl shadow-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between shrink-0">
          <h2 className="font-headline-sm text-lg font-black text-on-surface">
            {mode === 'create' ? 'New documentation page' : 'Edit page'}
          </h2>
          <button onClick={onClose} className="p-1 text-on-surface-variant hover:text-on-surface rounded hover:bg-surface-variant/40" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={submit} className="p-lg overflow-y-auto flex-1 space-y-md">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
            <div>
              <label className="block text-[10px] font-bold uppercase text-outline mb-1">Title</label>
              <input value={title} onChange={e => setTitle(e.target.value)} required autoFocus
                     className="w-full bg-surface-container-high border border-outline-variant rounded px-3 py-2 text-sm outline-none focus:border-primary" />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase text-outline mb-1">Slug (URL path)</label>
              <input value={slug} onChange={e => { setSlug(e.target.value); setSlugDirty(true); }}
                     placeholder="auto-generated from title" pattern="[a-z0-9]+(-[a-z0-9]+)*"
                     className="w-full bg-surface-container-high border border-outline-variant rounded px-3 py-2 text-sm font-mono outline-none focus:border-primary" />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase text-outline mb-1">Category</label>
              <input list="doc-cats" value={category} onChange={e => setCategory(e.target.value)}
                     className="w-full bg-surface-container-high border border-outline-variant rounded px-3 py-2 text-sm outline-none focus:border-primary" />
              <datalist id="doc-cats">
                {existingCategories.map(c => <option key={c} value={c} />)}
              </datalist>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase text-outline mb-1">Sort order (lower = higher in list)</label>
              <input type="number" min={0} max={9999} value={sortOrder}
                     onChange={e => setSortOrder(parseInt(e.target.value) || 0)}
                     className="w-full bg-surface-container-high border border-outline-variant rounded px-3 py-2 text-sm font-mono outline-none focus:border-primary" />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-[10px] font-bold uppercase text-outline">Content (Markdown)</label>
              <button type="button" onClick={() => setPreview(p => !p)}
                      className="text-[10px] text-primary hover:underline">
                {preview ? 'Show editor' : 'Preview'}
              </button>
            </div>
            {preview ? (
              <div className="prose-doc bg-surface-container-high border border-outline-variant rounded p-md min-h-[240px]">
                {content.trim() ? <ReactMarkdown>{content}</ReactMarkdown> : <em className="text-on-surface-variant text-xs">Nothing to preview yet.</em>}
              </div>
            ) : (
              <textarea value={content} onChange={e => setContent(e.target.value)}
                        placeholder={"# Heading\n\nBody text with **markdown** and [links](https://example.com)."}
                        className="w-full bg-surface-container-high border border-outline-variant rounded px-3 py-2 text-sm font-mono outline-none focus:border-primary min-h-[240px] resize-y" />
            )}
          </div>
        </form>

        <div className="px-lg py-md border-t border-outline-variant flex justify-end gap-2 shrink-0">
          <button type="button" onClick={onClose}
                  className="text-xs px-3 py-2 rounded bg-surface-container-high hover:bg-surface-container-highest border border-outline-variant font-bold">
            Cancel
          </button>
          <button type="submit" onClick={submit} disabled={saving || !title.trim()}
                  className="text-xs px-3 py-2 rounded bg-primary text-on-primary font-bold hover:brightness-110 disabled:opacity-50 flex items-center gap-1.5">
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving…' : mode === 'create' ? 'Create page' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
};
