// Automation: rules that watch for something and tell people (or draft
// purchase orders), the app's background jobs, the in-app inbox, Auto-PO and
// the event log. Server: src/lib/automationRoutes.ts, automationEngine.ts,
// scheduledJobs.ts, autoPoRoutes.ts.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Item, Supplier } from '../../types';
import AutoPoPanel from '../AutoPoPanel';
import {
  Zap, Clock, Bell, Settings, LogIn, AlertCircle, CheckCircle2, Play, RefreshCw, Plus, ChevronRight, Pencil, Lock, Trash2, Eye, Download, Loader2, XCircle,
} from 'lucide-react';
import { confirmDialog } from '../../lib/confirmDialog';
import { PrimaryButton, SecondaryButton } from '../bookkeeping/shared';

type Toast = (msg: string, type?: string) => void;
type Action = { type: 'NOTIFY'; to: string } | { type: 'DRAFT_PO' };
export interface Rule {
  id: number; ruleName: string; description: string | null; triggerEvent: string; triggerLabel: string | null;
  conditions: { prefix?: string }; action: Action; every: 'hour' | 'day' | 'week' | null; isActive: boolean;
  lastRunAt: string | null; lastResult: { status: string; by: string; error: string | null; total?: number; fresh?: number; notified?: boolean; drafted?: string[] } | null;
}
interface Job { key: string; name: string; description: string; schedule: string; runNow: boolean; scheduled: boolean; isActive: boolean; running: boolean; lastRunAt: string | null; lastStatus: string | null; lastMessage: string | null; lastBy: string | null; lastMs: number | null }
interface Notification { id: number; notificationType: string; recipient: string; subject: string | null; message: string; read: boolean; createdAt: string }
interface Hit { id: string; label: string; detail: string }
interface Options { triggers: Array<{ key: string; label: string; items: boolean }>; every: Array<{ key: string; label: string }> }

// Free-form editing of automation rules is reserved for admin/manager —
// viewers can still see rule configuration, just not change it.
const canEditAutomation = (userRole?: string) => userRole === 'admin' || userRole === 'manager';

const input = 'w-full bg-surface-container-high border border-outline-variant rounded px-2 py-1.5 text-xs text-on-surface';
const when = (d: string | null) => (d ? new Date(d).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
const EVERY_LABEL: Record<string, string> = { hour: 'every hour', day: 'every day', week: 'every week' };

async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init && init.body ? { ...init, headers: { 'Content-Type': 'application/json' } } : init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

/** "Tell everyone", "Draft purchase orders", … */
export function actionText(a: Action): string {
  if (a.type === 'DRAFT_PO') return 'Draft purchase orders';
  return a.to === 'role:admin' ? 'Tell the admins' : a.to === 'role:manager' ? 'Tell the managers' : a.to === 'everyone' ? 'Tell everyone' : `Tell ${a.to}`;
}

/** What a rule's last run did, in a line. */
export function lastRunText(r: Rule): string {
  const x = r.lastResult;
  if (!r.lastRunAt || !x) return 'Not run yet.';
  const by = x.by === 'schedule' ? 'on schedule' : `by ${x.by}`;
  if (x.status === 'FAILED') return `Failed ${when(r.lastRunAt)} (${by}): ${x.error}`;
  const did = x.drafted?.length ? `drafted ${x.drafted.join(', ')}` : x.notified ? 'told people' : x.fresh ? '' : 'nothing new';
  return `Last run ${when(r.lastRunAt)} (${by}): ${x.total ?? 0} found, ${x.fresh ?? 0} new${did ? `, ${did}` : ''}.`;
}

// Ready-made rules, one press to add.
const STARTERS: Array<{ label: string; rule: Partial<Rule> & { ruleName: string; triggerEvent: string; action: Action; every: Rule['every'] } }> = [
  { label: 'Out of stock: tell me daily', rule: { ruleName: 'Out of stock', triggerEvent: 'OUT_OF_STOCK', action: { type: 'NOTIFY', to: 'everyone' }, every: 'day' } },
  { label: 'Low stock: tell me daily', rule: { ruleName: 'Low stock', triggerEvent: 'LOW_STOCK', action: { type: 'NOTIFY', to: 'everyone' }, every: 'day' } },
  { label: 'Overdue invoices: tell the admins', rule: { ruleName: 'Overdue invoices', triggerEvent: 'INVOICE_OVERDUE', action: { type: 'NOTIFY', to: 'role:admin' }, every: 'day' } },
  { label: 'Late purchase orders: tell me', rule: { ruleName: 'Late purchase orders', triggerEvent: 'PO_LATE', action: { type: 'NOTIFY', to: 'everyone' }, every: 'day' } },
  { label: 'Auto-PO: draft when due', rule: { ruleName: 'Auto-PO drafts', triggerEvent: 'AUTO_PO_DUE', action: { type: 'DRAFT_PO' }, every: 'day' } },
];

interface DashboardProps {
  triggerToast: Toast;
  userRole?: string;
  /** For the Auto-PO tab's item picker and supplier list. */
  items?: Item[];
  suppliers?: Supplier[];
}

export default function AutomationDashboard({ triggerToast, userRole, items, suppliers }: DashboardProps) {
  const [view, setView] = useState<string>('overview');
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [autoPos, setAutoPos] = useState(0);

  const load = useCallback(async () => {
    try {
      const [r, j, u, e] = await Promise.all([
        api<Rule[]>('/api/automation-rules'), api<Job[]>('/api/scheduled-jobs'),
        api<{ unread: number }>('/api/notifications/unread-count'), api<any[]>('/api/event-log?type=AUTO_PO_CREATED&limit=1000'),
      ]);
      setRules(r); setJobs(j); setUnread(u.unread); setAutoPos(e.length);
    } catch (err: any) { triggerToast(`Could not load automation: ${err.message}`, 'ERROR'); }
  }, [triggerToast]);
  useEffect(() => { void load(); }, [load]);

  const tabs = [
    { id: 'overview', label: 'Overview', icon: Zap },
    { id: 'rules', label: 'Automation Rules', icon: Settings },
    { id: 'jobs', label: 'Scheduled Jobs', icon: Clock },
    { id: 'notifications', label: `Notifications${unread ? ` (${unread})` : ''}`, icon: Bell },
    { id: 'auto-po', label: 'Auto-PO Config', icon: AlertCircle },
    { id: 'events', label: 'Event Log', icon: LogIn },
  ];
  const activeRules = (rules ?? []).filter((r) => r.isActive);
  const problems = [
    ...(rules ?? []).filter((r) => r.isActive && r.lastResult?.status === 'FAILED').map((r) => `Rule "${r.ruleName}" failed: ${r.lastResult?.error}`),
    ...(jobs ?? []).filter((j) => j.isActive && j.lastStatus === 'FAILED').map((j) => `${j.name} failed ${when(j.lastRunAt)}: ${j.lastMessage}`),
  ];

  return (
    <div className="p-container-margin space-y-lg max-w-[1600px] mx-auto w-full">
      <div className="bg-surface-container border border-outline-variant p-lg rounded-xl flex flex-wrap lg:items-center justify-between gap-md">
        <div className="space-y-1 flex-1 min-w-[300px]">
          <div className="flex items-center gap-xs text-primary">
            <Zap className="w-5 h-5" />
            <span className="font-label-caps text-[10px] uppercase font-bold tracking-wider">System Automation</span>
          </div>
          <h3 className="font-headline-sm text-lg font-black text-on-surface">Workflow Automation & Events</h3>
          <p className="text-on-surface-variant text-xs max-w-[640px]">
            Rules watch for things like low stock or overdue invoices and tell people (or draft purchase orders). Scheduled jobs are the app's own background work. Everything that runs is recorded in the event log.
          </p>
        </div>
        <button type="button" onClick={() => void load()}
          className="h-9 px-lg rounded-lg flex items-center gap-xs text-xs font-bold uppercase tracking-wider transition-all bg-primary text-on-primary hover:brightness-110 active:scale-95">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
        <StatCard icon={<Zap className="w-5 h-5" />} label="Active rules" value={activeRules.length} color="text-blue-400" onClick={() => setView('rules')} />
        <StatCard icon={<Clock className="w-5 h-5" />} label="Jobs on" value={(jobs ?? []).filter((j) => j.isActive).length} color="text-cyan-400" onClick={() => setView('jobs')} />
        <StatCard icon={<Bell className="w-5 h-5" />} label="Unread notifications" value={unread} color="text-yellow-400" onClick={() => setView('notifications')} />
        <StatCard icon={<CheckCircle2 className="w-5 h-5" />} label="Auto-POs drafted" value={autoPos} color="text-green-400" onClick={() => setView('auto-po')} />
      </div>

      <div className="bg-surface-container-high/40 rounded-lg p-1 flex gap-1 overflow-x-auto" role="tablist">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button key={tab.id} type="button" role="tab" aria-selected={view === tab.id} onClick={() => setView(tab.id)}
              className={`px-4 py-2 rounded-lg text-xs font-bold whitespace-nowrap transition-all flex items-center gap-1 ${view === tab.id ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:text-on-surface'}`}>
              <Icon className="w-4 h-4" />{tab.label}
            </button>
          );
        })}
      </div>

      <div className="min-h-[400px]">
        {view === 'overview' && <Overview rules={rules} jobs={jobs} problems={problems} onNavigate={setView} />}
        {view === 'rules' && <RulesSection triggerToast={triggerToast} userRole={userRole} rules={rules} onChanged={load} />}
        {view === 'jobs' && <JobsSection triggerToast={triggerToast} userRole={userRole} jobs={jobs} onChanged={load} />}
        {view === 'notifications' && <NotificationsSection triggerToast={triggerToast} onChanged={load} />}
        {view === 'auto-po' && <AutoPoPanel triggerToast={triggerToast} items={items} suppliers={suppliers} />}
        {view === 'events' && <EventLogSection triggerToast={triggerToast} rules={rules ?? []} jobs={jobs ?? []} />}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color, onClick }: { icon: React.ReactNode; label: string; value: number; color: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-left bg-surface-container border border-outline-variant rounded-lg p-md hover:border-primary transition-colors">
      <div className={`flex items-center justify-between gap-2 ${color}`}>
        {icon}
        <div className="text-right">
          <div className="text-2xl font-black">{value}</div>
          <div className="text-[10px] text-on-surface-variant uppercase font-bold">{label}</div>
        </div>
      </div>
    </button>
  );
}

function Overview({ rules, jobs, problems, onNavigate }: { rules: Rule[] | null; jobs: Job[] | null; problems: string[]; onNavigate: (v: string) => void }) {
  if (!rules || !jobs) return <p className="text-xs text-outline flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>;
  const active = rules.filter((r) => r.isActive);
  return (
    <div className="space-y-lg">
      {problems.length > 0 && (
        <div className="rounded-lg border border-error/40 bg-error/5 p-md space-y-1" data-testid="automation-problems">
          <p className="text-xs font-bold text-error flex items-center gap-1.5"><XCircle className="w-4 h-4" /> Needs a look</p>
          {problems.map((p) => <p key={p} className="text-xs text-on-surface">{p}</p>)}
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-lg">
        <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-sm">
          <div className="flex items-center justify-between"><h4 className="text-sm font-bold text-primary">Rules</h4>
            <button type="button" onClick={() => onNavigate('rules')} className="text-xs font-bold text-primary flex items-center gap-1">Manage <ChevronRight className="w-3 h-3" /></button></div>
          {active.length === 0
            ? <p className="text-xs text-on-surface-variant">No active rules. Add one to be told when stock runs low, an invoice is overdue or a purchase order is late.</p>
            : active.map((r) => (
              <div key={r.id} className="p-sm bg-surface-container-high rounded-lg">
                <p className="text-xs font-bold text-on-surface">{r.ruleName} <span className="font-normal text-outline">· {r.every ? EVERY_LABEL[r.every] : 'by hand only'}</span></p>
                <p className={`text-[11px] ${r.lastResult?.status === 'FAILED' ? 'text-error' : 'text-on-surface-variant'}`}>{lastRunText(r)}</p>
              </div>
            ))}
        </div>
        <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-sm">
          <div className="flex items-center justify-between"><h4 className="text-sm font-bold text-primary">Background jobs</h4>
            <button type="button" onClick={() => onNavigate('jobs')} className="text-xs font-bold text-primary flex items-center gap-1">View <ChevronRight className="w-3 h-3" /></button></div>
          {jobs.map((j) => (
            <div key={j.key} className="flex items-start justify-between gap-sm p-sm bg-surface-container-high rounded-lg">
              <div><p className="text-xs font-bold text-on-surface">{j.name} <span className="font-normal text-outline">· {j.isActive ? j.schedule : 'off'}</span></p>
                <p className="text-[11px] text-on-surface-variant">Last run {when(j.lastRunAt)}{j.lastMessage ? `: ${j.lastMessage}` : ''}</p></div>
              <StatusPill status={j.isActive ? j.lastStatus : 'OFF'} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string | null }) {
  const s = status ?? 'NOT RUN';
  const cls = s === 'SUCCESS' ? 'bg-green-500/10 text-green-400' : s === 'FAILED' ? 'bg-red-500/10 text-red-400' : 'bg-gray-500/10 text-outline';
  return <span className={`px-2 py-0.5 rounded text-[9px] font-bold whitespace-nowrap ${cls}`}>{s === 'SUCCESS' ? 'OK' : s}</span>;
}

// ---------------------------------------------------------------------------
// Rules

type Draft = { ruleName: string; description: string; triggerEvent: string; prefix: string; actionType: 'NOTIFY' | 'DRAFT_PO'; to: string; email: string; every: string; isActive: boolean };
const draftOf = (r?: Partial<Rule>): Draft => {
  const to = r?.action?.type === 'NOTIFY' ? r.action.to : 'everyone';
  const named = to === 'everyone' || to === 'role:admin' || to === 'role:manager';
  return {
    ruleName: r?.ruleName ?? '', description: r?.description ?? '', triggerEvent: r?.triggerEvent ?? 'LOW_STOCK', prefix: r?.conditions?.prefix ?? '',
    actionType: r?.action?.type ?? 'NOTIFY', to: named ? to : 'email', email: named ? '' : to, every: r?.every === undefined ? 'day' : (r.every ?? ''), isActive: r?.isActive ?? true,
  };
};
const bodyOf = (d: Draft) => ({
  ruleName: d.ruleName, description: d.description, triggerEvent: d.triggerEvent, conditions: { prefix: d.prefix },
  action: d.actionType === 'DRAFT_PO' ? { type: 'DRAFT_PO' } : { type: 'NOTIFY', to: d.to === 'email' ? d.email : d.to }, every: d.every || null, isActive: d.isActive,
});

function RuleForm({ initial, options, onSave, onCancel }: { initial: Draft; options: Options; onSave: (d: Draft) => Promise<void>; onCancel: () => void }) {
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const trigger = options.triggers.find((t) => t.key === d.triggerEvent);
  const set = (p: Partial<Draft>) => setD({ ...d, ...p });
  return (
    <div className="bg-surface-container border border-primary/40 rounded-lg p-lg space-y-sm" data-testid="rule-form">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-sm">
        <label className="text-xs font-bold text-on-surface-variant">Name<input className={`${input} mt-1`} value={d.ruleName} onChange={(e) => set({ ruleName: e.target.value })} placeholder="e.g. Capacitors running low" aria-label="Rule name" /></label>
        <label className="text-xs font-bold text-on-surface-variant">Note (optional)<input className={`${input} mt-1`} value={d.description} onChange={(e) => set({ description: e.target.value })} aria-label="Rule note" /></label>
        <label className="text-xs font-bold text-on-surface-variant">When<select className={`${input} mt-1`} value={d.triggerEvent} onChange={(e) => set({ triggerEvent: e.target.value, actionType: e.target.value === 'AUTO_PO_DUE' ? d.actionType : 'NOTIFY' })} aria-label="When">
          {options.triggers.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></label>
        {trigger?.items
          ? <label className="text-xs font-bold text-on-surface-variant">Only stock codes starting with (optional)<input className={`${input} mt-1 font-mono`} value={d.prefix} onChange={(e) => set({ prefix: e.target.value })} placeholder="e.g. CAP-" aria-label="Only codes starting with" /></label>
          : <span />}
        <label className="text-xs font-bold text-on-surface-variant">Then<select className={`${input} mt-1`} value={d.actionType} onChange={(e) => set({ actionType: e.target.value as Draft['actionType'] })} aria-label="Then">
          <option value="NOTIFY">Tell people (in-app notification)</option>
          {d.triggerEvent === 'AUTO_PO_DUE' && <option value="DRAFT_PO">Draft purchase orders</option>}</select></label>
        {d.actionType === 'NOTIFY' ? (
          <div className="text-xs font-bold text-on-surface-variant">Who
            <div className="flex gap-sm mt-1">
              <select className={input} value={d.to} onChange={(e) => set({ to: e.target.value })} aria-label="Who">
                <option value="everyone">Everyone</option><option value="role:admin">Admins</option><option value="role:manager">Managers</option><option value="email">One person (email)</option></select>
              {d.to === 'email' && <input className={input} value={d.email} onChange={(e) => set({ email: e.target.value })} placeholder="name@company.co.za" aria-label="Their email" />}
            </div>
          </div>
        ) : <p className="text-[11px] text-on-surface-variant self-end">Drafts what Auto-PO would, for the watched items at their reorder point, one purchase order per supplier. Nothing is sent to a supplier.</p>}
        <label className="text-xs font-bold text-on-surface-variant">How often<select className={`${input} mt-1`} value={d.every} onChange={(e) => set({ every: e.target.value })} aria-label="How often">
          {options.every.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}<option value="">Only when I press Run</option></select></label>
        <label className="flex items-center gap-2 text-xs text-on-surface-variant self-end"><input type="checkbox" checked={d.isActive} onChange={(e) => set({ isActive: e.target.checked })} /> On</label>
      </div>
      <p className="text-[11px] text-outline">People are told only about what's new since the rule last ran, in the Notifications tab here. Nothing is emailed.</p>
      <div className="flex gap-sm justify-end">
        <SecondaryButton type="button" onClick={onCancel}>Cancel</SecondaryButton>
        <PrimaryButton type="button" disabled={busy || !d.ruleName.trim() || (d.actionType === 'NOTIFY' && d.to === 'email' && !d.email.includes('@'))}
          onClick={async () => { setBusy(true); try { await onSave(d); } finally { setBusy(false); } }}>{busy ? 'Saving…' : 'Save'}</PrimaryButton>
      </div>
    </div>
  );
}

function RulesSection({ triggerToast, userRole, rules, onChanged }: { triggerToast: Toast; userRole?: string; rules: Rule[] | null; onChanged: () => Promise<void> }) {
  const canEdit = canEditAutomation(userRole);
  const [options, setOptions] = useState<Options | null>(null);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [newDraft, setNewDraft] = useState<Draft>(draftOf());
  const [preview, setPreview] = useState<{ id: number; hits: Hit[]; fresh: number; total: number } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => { api<Options>('/api/automation/options').then(setOptions).catch((e) => triggerToast(e.message, 'ERROR')); }, [triggerToast]);

  const save = async (d: Draft, id?: number) => {
    try {
      await api(id ? `/api/automation-rules/${id}` : '/api/automation-rules', { method: id ? 'PUT' : 'POST', body: JSON.stringify(bodyOf(d)) });
      triggerToast(id ? 'Rule saved.' : 'Rule added.', 'SUCCESS'); setEditing(null); await onChanged();
    } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const run = async (r: Rule) => {
    setBusy(r.id);
    try {
      const out = await api(`/api/automation-rules/${r.id}/run`, { method: 'POST', body: '{}' });
      triggerToast(`${r.ruleName}: ${out.total} found, ${out.fresh} new${out.drafted?.length ? `; drafted ${out.drafted.join(', ')}` : out.notified ? '; people told' : ''}.`, 'SUCCESS');
      await onChanged();
    } catch (e: any) { triggerToast(e.message, 'ERROR'); } finally { setBusy(null); }
  };
  const showPreview = async (r: Rule) => {
    if (preview?.id === r.id) { setPreview(null); return; }
    setBusy(r.id);
    try { const out = await api(`/api/automation-rules/${r.id}/preview`); setPreview({ id: r.id, hits: out.hits, fresh: out.fresh, total: out.total }); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); } finally { setBusy(null); }
  };
  const toggle = async (r: Rule) => { try { await api(`/api/automation-rules/${r.id}`, { method: 'PUT', body: JSON.stringify({ isActive: !r.isActive }) }); await onChanged(); } catch (e: any) { triggerToast(e.message, 'ERROR'); } };
  const remove = async (r: Rule) => {
    if (!(await confirmDialog({ title: 'Delete rule', message: `Delete "${r.ruleName}"? Its notifications stay.`, confirmLabel: 'Delete', destructive: true }))) return;
    try { await api(`/api/automation-rules/${r.id}`, { method: 'DELETE' }); await onChanged(); } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };

  if (!rules || !options) return <p className="text-xs text-outline flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>;
  return (
    <div className="space-y-md">
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-sm">
          <PrimaryButton type="button" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => { setNewDraft(draftOf()); setEditing('new'); }}>New rule</PrimaryButton>
          <span className="text-[11px] text-outline">or add a ready-made one:</span>
          {STARTERS.filter((s) => !rules.some((r) => r.triggerEvent === s.rule.triggerEvent && r.action.type === s.rule.action.type)).map((s) => (
            <button key={s.label} type="button" className="px-2 py-1 rounded-full border border-outline-variant text-[11px] text-on-surface-variant hover:border-primary hover:text-primary"
              onClick={() => { setNewDraft(draftOf(s.rule)); setEditing('new'); }}>{s.label}</button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[11px] text-outline bg-surface-container-high/40 border border-outline-variant/30 rounded-lg px-md py-2">
          <Lock className="w-3.5 h-3.5" /> Only admins and managers can add or change rules.
        </div>
      )}
      {editing === 'new' && <RuleForm initial={newDraft} options={options} onCancel={() => setEditing(null)} onSave={(d) => save(d)} />}
      {rules.length === 0 && editing !== 'new' && <div className="text-center py-8 text-outline italic text-xs">No rules yet.</div>}
      {rules.map((r) => editing === r.id
        ? <RuleForm key={r.id} initial={draftOf(r)} options={options} onCancel={() => setEditing(null)} onSave={(d) => save(d, r.id)} />
        : (
          <div key={r.id} className={`bg-surface-container border border-outline-variant rounded-lg p-md space-y-sm ${r.isActive ? '' : 'opacity-60'}`} data-rule={r.ruleName}>
            <div className="flex flex-wrap items-start justify-between gap-sm">
              <div className="flex-1 min-w-[240px]">
                <div className="flex items-center gap-2">
                  <h5 className="text-sm font-bold text-on-surface">{r.ruleName}</h5>
                  <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${r.isActive ? 'bg-green-500/10 text-green-400' : 'bg-gray-500/10 text-outline'}`}>{r.isActive ? 'ON' : 'OFF'}</span>
                </div>
                <p className="text-xs text-on-surface mt-1">
                  When <strong>{(r.triggerLabel ?? r.triggerEvent).replace(/^An? /, (m) => m.toLowerCase())}</strong>{r.conditions?.prefix ? <> (codes starting <span className="font-mono">{r.conditions.prefix}</span>)</> : null}: {actionText(r.action).toLowerCase()}, {r.every ? EVERY_LABEL[r.every] : 'only when run by hand'}.
                </p>
                {r.description && <p className="text-[11px] text-on-surface-variant">{r.description}</p>}
                <p className={`text-[11px] mt-1 ${r.lastResult?.status === 'FAILED' ? 'text-error' : 'text-outline'}`}>{lastRunText(r)}</p>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" className="px-2 py-1 rounded text-[11px] font-bold text-on-surface-variant hover:bg-surface-container-high inline-flex items-center gap-1" onClick={() => void showPreview(r)}><Eye className="w-3.5 h-3.5" /> What it finds</button>
                {canEdit && <>
                  <button type="button" disabled={busy === r.id} className="px-2 py-1 rounded text-[11px] font-bold text-primary hover:bg-surface-container-high inline-flex items-center gap-1 disabled:opacity-50" onClick={() => void run(r)}>{busy === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run now</button>
                  <button type="button" className="px-2 py-1 rounded text-[11px] hover:bg-surface-container-high" onClick={() => void toggle(r)}>{r.isActive ? 'Turn off' : 'Turn on'}</button>
                  <button type="button" aria-label={`Edit ${r.ruleName}`} className="p-1.5 rounded hover:bg-surface-container-high" onClick={() => setEditing(r.id)}><Pencil className="w-3.5 h-3.5" /></button>
                  <button type="button" aria-label={`Delete ${r.ruleName}`} className="p-1.5 rounded hover:bg-error/10 text-error" onClick={() => void remove(r)}><Trash2 className="w-3.5 h-3.5" /></button>
                </>}
              </div>
            </div>
            {preview?.id === r.id && (
              <div className="rounded border border-outline-variant bg-surface-container-high/40 p-sm" data-testid="rule-preview">
                <p className="text-[11px] text-on-surface-variant mb-1">Right now it finds {preview.total}; {preview.fresh} would be new to people. Nothing was changed.</p>
                {preview.hits.length > 0 && (
                  <div className="max-h-56 overflow-y-auto custom-scrollbar"><table className="w-full text-[11px]"><tbody>{preview.hits.map((h) => (
                    <tr key={h.id}><td className="pr-2 font-mono font-bold whitespace-nowrap">{h.label}</td><td className="text-on-surface-variant">{h.detail}</td></tr>
                  ))}</tbody></table></div>
                )}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scheduled jobs

function JobsSection({ triggerToast, userRole, jobs, onChanged }: { triggerToast: Toast; userRole?: string; jobs: Job[] | null; onChanged: () => Promise<void> }) {
  const canEdit = canEditAutomation(userRole);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (j: Job) => {
    setBusy(j.key);
    try { const r = await api(`/api/scheduled-jobs/${j.key}/run`, { method: 'POST', body: '{}' }); triggerToast(`${j.name}: ${r.message}`, r.status === 'FAILED' ? 'ERROR' : 'SUCCESS'); await onChanged(); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); } finally { setBusy(null); }
  };
  const toggle = async (j: Job) => { try { await api(`/api/scheduled-jobs/${j.key}/toggle`, { method: 'PUT', body: JSON.stringify({ active: !j.isActive }) }); await onChanged(); } catch (e: any) { triggerToast(e.message, 'ERROR'); } };
  if (!jobs) return <p className="text-xs text-outline flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>;
  return (
    <div className="space-y-md">
      <p className="text-xs text-on-surface-variant">The work the app does on its own. A job that is off is skipped when its time comes; Run now still runs it.</p>
      <div className="overflow-x-auto border border-outline-variant rounded-lg">
        <table className="w-full text-left text-xs">
          <thead className="bg-surface-container-high border-b border-outline-variant"><tr className="text-[10px] text-outline uppercase">
            <th className="px-md py-2">Job</th><th className="px-md py-2">When</th><th className="px-md py-2">Last run</th><th className="px-md py-2"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody className="divide-y divide-outline-variant/30">
            {jobs.map((j) => (
              <tr key={j.key} className={j.isActive ? '' : 'opacity-60'} data-job={j.key}>
                <td className="px-md py-2 max-w-[360px]"><p className="font-bold text-on-surface">{j.name}</p><p className="text-[11px] text-on-surface-variant">{j.description}</p></td>
                <td className="px-md py-2 whitespace-nowrap">{!j.isActive ? 'Off' : j.scheduled ? j.schedule : <span className="text-outline">Not run on a timer here</span>}</td>
                <td className="px-md py-2"><div className="flex items-center gap-2"><StatusPill status={j.running ? 'RUNNING' : j.lastStatus} /><span className="text-on-surface-variant">{when(j.lastRunAt)}{j.lastBy && j.lastBy !== 'schedule' ? ` by ${j.lastBy}` : ''}</span></div>
                  {j.lastMessage && <p className={`text-[11px] mt-0.5 ${j.lastStatus === 'FAILED' ? 'text-error' : 'text-outline'}`}>{j.lastMessage}</p>}</td>
                <td className="px-md py-2 text-right whitespace-nowrap">{canEdit && <>
                  {j.runNow
                    ? <button type="button" disabled={busy === j.key || j.running} className="px-2 py-1 rounded text-[11px] font-bold text-primary hover:bg-surface-container-high inline-flex items-center gap-1 disabled:opacity-50" onClick={() => void run(j)}>{busy === j.key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run now</button>
                    : <span className="text-[10px] text-outline mr-2">Run it from Pricing</span>}
                  <button type="button" className="px-2 py-1 rounded text-[11px] hover:bg-surface-container-high" onClick={() => void toggle(j)}>{j.isActive ? 'Turn off' : 'Turn on'}</button>
                </>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications

function NotificationsSection({ triggerToast, onChanged }: { triggerToast: Toast; onChanged: () => Promise<void> }) {
  const [show, setShow] = useState<'unread' | 'all'>('unread');
  const [list, setList] = useState<Notification[] | null>(null);
  const load = useCallback(async () => {
    try { setList(await api(`/api/notifications?mine=1${show === 'unread' ? '&status=unread' : ''}`)); } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  }, [show, triggerToast]);
  useEffect(() => { void load(); }, [load]);
  const read = async (n: Notification) => { if (n.read) return; try { await api(`/api/notifications/${n.id}/mark-read`, { method: 'PUT', body: '{}' }); await load(); await onChanged(); } catch (e: any) { triggerToast(e.message, 'ERROR'); } };
  const readAll = async () => { try { await api('/api/notifications/mark-all-read', { method: 'PUT', body: '{}' }); await load(); await onChanged(); } catch (e: any) { triggerToast(e.message, 'ERROR'); } };
  return (
    <div className="space-y-md">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <div className="flex gap-1" role="radiogroup" aria-label="Show">
          {(['unread', 'all'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={show === k} onClick={() => setShow(k)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold border ${show === k ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant text-on-surface-variant'}`}>{k === 'unread' ? 'Unread' : 'All'}</button>
          ))}
        </div>
        {list && list.some((n) => !n.read) && <SecondaryButton type="button" onClick={() => void readAll()}>Mark all read</SecondaryButton>}
      </div>
      {!list ? <Loader2 className="w-4 h-4 animate-spin text-outline" /> : list.length === 0 ? (
        <p className="text-xs text-on-surface-variant italic">{show === 'unread' ? 'Nothing unread.' : 'No notifications yet. Rules that tell people put them here.'}</p>
      ) : (
        <div className="space-y-sm">
          {list.map((n) => (
            <div key={n.id} className={`p-sm rounded border-l-2 ${n.read ? 'border-outline-variant bg-surface-container-high/10' : 'border-primary bg-surface-container-high/30'}`} data-notification={n.id}>
              <div className="flex items-start justify-between gap-sm">
                <p className={`text-xs ${n.read ? 'text-on-surface-variant' : 'font-bold text-on-surface'}`}>{n.subject || n.notificationType}</p>
                {!n.read && <button type="button" className="text-[11px] text-primary whitespace-nowrap" onClick={() => void read(n)}>Mark read</button>}
              </div>
              <p className="text-[11px] text-on-surface-variant mt-1 whitespace-pre-line">{n.message}</p>
              <p className="text-[10px] text-outline mt-1">{when(n.createdAt)} · {n.recipient === 'everyone' ? 'to everyone' : n.recipient.startsWith('role:') ? `to ${n.recipient.slice(5)}s` : `to ${n.recipient}`}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event log

interface Event { id: number; eventType: string; entityType: string | null; entityId: string | null; action: string | null; userId: string | null; details: any; status: string; errorMessage: string | null; createdAt: string }

/** An event in words. */
export function describeEvent(e: Event, ruleName: (id: string) => string | undefined, jobName: (key: string) => string | undefined): string {
  const d = typeof e.details === 'string' ? (() => { try { return JSON.parse(e.details); } catch { return {}; } })() : (e.details ?? {});
  switch (e.eventType) {
    case 'RULE_RUN': return `Rule "${ruleName(e.entityId ?? '') ?? e.entityId}" ran${e.action === 'SCHEDULED' ? ' on schedule' : ''}: ${d.total ?? 0} found, ${d.fresh ?? 0} new${d.drafted?.length ? `, drafted ${d.drafted.join(', ')}` : d.notified ? ', people told' : ''}`;
    case 'JOB_RUN': return `${jobName(e.entityId ?? '') ?? e.entityId}${e.action === 'SCHEDULED' ? '' : ' (run by hand)'}: ${d.message ?? ''}`;
    case 'AUTO_PO_CREATED': return `Auto-PO drafted ${d.poNumber ?? 'a purchase order'}${d.lines?.length ? ` (${d.lines.length} line${d.lines.length === 1 ? '' : 's'})` : ''}`;
    case 'MISSING_SUPPLIER_CHECK': return `${d.missing ?? 0} items found with no supplier part number`;
    case 'MPN_ENRICHMENT': return 'Supplier enrichment (old version; it gave made-up search links)';
    case 'ALERT_SENT': return `Alert sent (${d.alertType ?? ''})`;
    default: return [e.action, e.entityType, e.entityId].filter(Boolean).join(' · ') || e.eventType;
  }
}

const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function EventLogSection({ triggerToast, rules, jobs }: { triggerToast: Toast; rules: Rule[]; jobs: Job[] }) {
  const [events, setEvents] = useState<Event[] | null>(null);
  const [types, setTypes] = useState<Array<{ type: string; count: number }>>([]);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [more, setMore] = useState(false);
  const PAGE = 100;
  const ruleName = useMemo(() => { const m = new Map(rules.map((r) => [String(r.id), r.ruleName])); return (id: string) => m.get(id); }, [rules]);
  const jobName = useMemo(() => { const m = new Map(jobs.map((j) => [j.key, j.name])); return (k: string) => m.get(k); }, [jobs]);
  const url = (before?: number) => `/api/event-log?limit=${PAGE}${type ? `&type=${encodeURIComponent(type)}` : ''}${status ? `&status=${status}` : ''}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}${before ? `&before=${before}` : ''}`;
  const load = useCallback(async () => {
    try { const rows = await api<Event[]>(url()); setEvents(rows); setMore(rows.length === PAGE); } catch (e: any) { triggerToast(e.message, 'ERROR'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, status, q, triggerToast]);
  useEffect(() => { const t = setTimeout(() => { void load(); }, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { api('/api/event-log/types').then(setTypes).catch(() => {}); }, []);
  const loadMore = async () => {
    if (!events?.length) return;
    try { const rows = await api<Event[]>(url(events[events.length - 1].id)); setEvents([...events, ...rows]); setMore(rows.length === PAGE); } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const exportCsv = () => {
    const lines = [['Time', 'Event', 'What happened', 'Status', 'By', 'Error'].join(','),
      ...(events ?? []).map((e) => [new Date(e.createdAt).toISOString(), e.eventType, describeEvent(e, ruleName, jobName), e.status, e.userId, e.errorMessage].map(csvCell).join(','))];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }));
    a.download = `event-log-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  return (
    <div className="space-y-md">
      <div className="flex flex-wrap items-center gap-sm">
        <select className={`${input} w-auto`} value={type} onChange={(e) => setType(e.target.value)} aria-label="Event type">
          <option value="">Every kind</option>{types.map((t) => <option key={t.type} value={t.type}>{t.type} ({t.count})</option>)}</select>
        <select className={`${input} w-auto`} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any result</option><option value="SUCCESS">Worked</option><option value="FAILED">Failed</option></select>
        <input className={`${input} w-56`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search events" />
        <SecondaryButton type="button" icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => void load()}>Refresh</SecondaryButton>
        <SecondaryButton type="button" icon={<Download className="w-3.5 h-3.5" />} disabled={!events?.length} onClick={exportCsv}>Export CSV</SecondaryButton>
      </div>
      <div className="overflow-x-auto border border-outline-variant rounded-lg">
        <table className="w-full text-left text-xs">
          <thead className="bg-surface-container-high border-b border-outline-variant"><tr className="text-[10px] text-outline uppercase">
            <th className="px-md py-2">Time</th><th className="px-md py-2">What happened</th><th className="px-md py-2">Result</th><th className="px-md py-2">By</th></tr></thead>
          <tbody className="divide-y divide-outline-variant/30">
            {!events ? <tr><td colSpan={4} className="px-md py-4"><Loader2 className="w-4 h-4 animate-spin text-outline" /></td></tr>
              : events.length === 0 ? <tr><td colSpan={4} className="px-md py-4 text-center text-on-surface-variant text-[11px]">Nothing recorded{type || status || q ? ' that matches' : ' yet'}.</td></tr>
              : events.map((e) => (
                <tr key={e.id} data-event={e.eventType}>
                  <td className="px-md py-2 text-on-surface-variant whitespace-nowrap">{when(e.createdAt)}</td>
                  <td className="px-md py-2 text-on-surface">{describeEvent(e, ruleName, jobName)}<span className="block text-[9px] text-outline font-mono">{e.eventType}</span>{e.errorMessage && <span className="block text-[11px] text-error">{e.errorMessage}</span>}</td>
                  <td className="px-md py-2"><StatusPill status={e.status} /></td>
                  <td className="px-md py-2 text-on-surface-variant">{e.userId === 'schedule' ? 'On schedule' : e.userId ?? ''}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {more && <div className="text-center"><SecondaryButton type="button" onClick={() => void loadMore()}>Show older</SecondaryButton></div>}
    </div>
  );
}
