import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutDashboard, Boxes, TableProperties, Tag, Factory, Receipt, Calculator, Database,
  ArrowLeftRight, ClipboardList, Zap, Settings, Shield, Brain, Activity, User,
  Users, FileText, Wallet, Truck, CreditCard, Landmark, Wrench, BarChart3,
  Search, ArrowUp, ArrowDown, CornerDownLeft, X,
} from 'lucide-react';
import { Item, Client, Supplier } from '../types';
import {
  CommandRoute, CommandTarget, ROUTES,
  scoreRoute, fuzzyScore, getRecent, pushRecent,
} from '../lib/commandPalette';

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  LayoutDashboard, Boxes, TableProperties, Tag, Factory, Receipt, Calculator, Database,
  ArrowLeftRight, ClipboardList, Zap, Settings, Shield, Brain, Activity, User,
  Users, FileText, Wallet, Truck, CreditCard, Landmark, Wrench, BarChart3,
};

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (target: CommandTarget) => void;
  items: Item[];
  clients: Client[];
  suppliers: Supplier[];
}

interface DisplayResult {
  key: string;
  label: string;
  path: string;
  group: string;
  icon: string;
  target: CommandTarget;
}

const MAX_PER_GROUP = 8;

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open, onClose, onNavigate, items, clients, suppliers,
}) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveIndex(0);
      return;
    }
    // Small timeout lets the modal mount before focus so the caret lands.
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  const results = useMemo<DisplayResult[]>(() => {
    const q = query.trim();

    // Empty query — show recents first, then a curated set of pages.
    if (!q) {
      const recentIds = getRecent();
      const recents = recentIds
        .map((id) => ROUTES.find((r) => r.id === id))
        .filter((r): r is CommandRoute => Boolean(r))
        .map((r) => ({ key: r.id, label: r.label, path: r.path, group: 'Recent', icon: r.icon, target: r.target }));
      const featured = ROUTES.slice(0, 8)
        .filter((r) => !recentIds.includes(r.id))
        .map((r) => ({ key: r.id, label: r.label, path: r.path, group: r.group, icon: r.icon, target: r.target }));
      return [...recents, ...featured];
    }

    const routeHits = ROUTES.map((r) => ({ route: r, score: scoreRoute(r, q) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score);

    // Entity searches — cheap, run over already-loaded in-memory lists.
    const itemHits = items
      .map((i) => {
        const label = i.name || i.partNumber;
        const s = Math.max(
          fuzzyScore(q, i.partNumber).score,
          fuzzyScore(q, label).score,
          i.manufacturer ? fuzzyScore(q, i.manufacturer).score : -1,
        );
        return { item: i, score: s, label };
      })
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_PER_GROUP);

    const clientHits = clients
      .map((c) => ({ client: c, score: fuzzyScore(q, c.clientName).score }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_PER_GROUP);

    const supplierHits = suppliers
      .map((s) => ({ supplier: s, score: fuzzyScore(q, s.name).score }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_PER_GROUP);

    // Interleave: pages/bookkeeping first (highest signal), then entities.
    const out: DisplayResult[] = [];
    routeHits.slice(0, 12).forEach(({ route }) => {
      out.push({ key: route.id, label: route.label, path: route.path, group: route.group, icon: route.icon, target: route.target });
    });
    itemHits.forEach(({ item, label }) => {
      out.push({
        key: `item-${item.partNumber}`,
        label,
        path: `Item · ${item.partNumber}${item.manufacturer ? ' · ' + item.manufacturer : ''}`,
        group: 'Items',
        icon: 'Boxes',
        target: { view: 'items', focusQuery: item.partNumber },
      });
    });
    clientHits.forEach(({ client }) => {
      out.push({
        key: `client-${client.id}`,
        label: client.clientName,
        path: `Client${client.contactName ? ' · ' + client.contactName : ''}`,
        group: 'Clients',
        icon: 'Users',
        target: { view: 'bookkeeping', section: 'SALES', subSection: 'CUSTOMERS' },
      });
    });
    supplierHits.forEach(({ supplier }) => {
      out.push({
        key: `supplier-${supplier.id}`,
        label: supplier.name,
        path: `Supplier${supplier.website ? ' · ' + supplier.website : ''}`,
        group: 'Suppliers',
        icon: 'Factory',
        target: { view: 'suppliers' },
      });
    });
    return out;
  }, [query, items, clients, suppliers]);

  // Keep activeIndex within bounds when results change.
  useEffect(() => {
    if (activeIndex >= results.length) setActiveIndex(0);
  }, [results.length, activeIndex]);

  // Grouped view for the render pass — a flat index → group,index-in-group map.
  const grouped = useMemo(() => {
    const map = new Map<string, DisplayResult[]>();
    results.forEach((r) => {
      if (!map.has(r.group)) map.set(r.group, []);
      map.get(r.group)!.push(r);
    });
    return Array.from(map.entries());
  }, [results]);

  const flatIndexOf = (result: DisplayResult) => results.indexOf(result);

  const commit = (r: DisplayResult) => {
    // Only remember canonical route ids in recents; entity clicks aren't a
    // stable "place I want to jump back to."
    if (!r.key.startsWith('item-') && !r.key.startsWith('client-') && !r.key.startsWith('supplier-')) {
      pushRecent(r.key);
    }
    onNavigate(r.target);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = results[activeIndex];
      if (chosen) commit(chosen);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  // Scroll the active row into view when navigation moves off-screen.
  useEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh] px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-2xl rounded-xl bg-surface border border-outline-variant shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 border-b border-outline-variant">
          <Search className="w-4 h-4 text-on-surface-variant shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search pages, tabs, items, clients, suppliers…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
            onKeyDown={onKeyDown}
            className="flex-1 py-3.5 bg-transparent outline-none text-sm text-on-surface placeholder:text-on-surface-variant/60"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-on-surface-variant hover:text-on-surface"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1">
          {grouped.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-on-surface-variant">
              No matches for <span className="font-mono">"{query}"</span>
            </div>
          ) : (
            grouped.map(([group, rows]) => (
              <div key={group}>
                <div className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-outline">
                  {group}
                </div>
                {rows.map((row) => {
                  const flatIdx = flatIndexOf(row);
                  const isActive = flatIdx === activeIndex;
                  const Icon = ICONS[row.icon] ?? Boxes;
                  return (
                    <button
                      key={row.key}
                      data-active={isActive}
                      onMouseEnter={() => setActiveIndex(flatIdx)}
                      onClick={() => commit(row)}
                      className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${
                        isActive ? 'bg-primary/10' : 'hover:bg-surface-variant/40'
                      }`}
                    >
                      <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-primary' : 'text-on-surface-variant'}`} />
                      <div className="flex-1 min-w-0">
                        <div className={`text-[13px] truncate ${isActive ? 'text-primary font-bold' : 'text-on-surface'}`}>
                          {row.label}
                        </div>
                        <div className="text-[10px] text-on-surface-variant truncate">{row.path}</div>
                      </div>
                      {isActive && (
                        <span className="text-[10px] text-primary font-bold shrink-0 flex items-center gap-1">
                          <CornerDownLeft className="w-3 h-3" /> jump
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="px-4 py-2 border-t border-outline-variant flex items-center justify-between text-[10px] text-on-surface-variant">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1"><ArrowUp className="w-3 h-3" /><ArrowDown className="w-3 h-3" /> navigate</span>
            <span className="flex items-center gap-1"><CornerDownLeft className="w-3 h-3" /> select</span>
            <span>esc close</span>
          </div>
          <span className="font-mono">Ctrl / ⌘ + K</span>
        </div>
      </div>
    </div>
  );
};
