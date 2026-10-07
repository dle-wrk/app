// Project Progress: every project on one board, in the stage it has reached,
// so several projects running at the same time can be followed at a glance.
// Move a project on when it reaches its next stage (the arrows, dragging the
// card, or its details), put it on hold with the reason, or add an update;
// everyone sees the change within half a minute. Admins can change the
// stages. Server: src/lib/projectProgress.ts; shared rules:
// src/lib/projectStages.ts.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowUp, CalendarClock, Check, ChevronLeft, ChevronRight, ClipboardList,
  Columns3, History, List, Loader2, PauseCircle, PlayCircle, Plus, RefreshCw, Search, Settings2, X,
} from 'lucide-react';
import { useDataChanged } from '../../lib/liveUpdates';
import { notAllowedMessage } from '../../lib/permissions';
import {
  MAX_STAGES, MIN_STAGES, NOTE_MAX, STAGE_NAME_MAX, STUCK_AFTER_DAYS,
  daysSince, dueStatus, isClosedStatus, type Stage,
} from '../../lib/projectStages';
import { Modal, PrimaryButton, SecondaryButton, inputClass } from '../bookkeeping/shared';

type ToastType = 'SUCCESS' | 'ERROR' | 'INFO';
type LogKind = 'stage' | 'hold' | 'resume' | 'update';

export interface LogEntry {
  id: number;
  kind: LogKind;
  fromStage: string | null;
  toStage: string | null;
  note: string | null;
  by: string | null;
  at: string | null;
}

export interface BoardProject {
  id: number;
  name: string;
  status: string | null;
  team: string | null;
  startDate: string | null;
  endDate: string | null;
  stageId: number | null;
  stageSet: boolean;
  stageSince: string | null;
  stageBy: string | null;
  onHold: boolean;
  holdReason: string | null;
  holdSince: string | null;
  holdBy: string | null;
  lastNote: { kind: LogKind; note: string; by: string | null; at: string | null } | null;
  kits: { count: number; lastSavedAt: string | null };
  builds: { inProgress: number; inProgressQty: number; completed: number };
  lastActivityAt: string | null;
}

export interface Board {
  stages: Stage[];
  projects: BoardProject[];
  can: { move: boolean; editStages: boolean };
}

interface Props {
  /** Kit Booking's stock check per project (App loads it), for the BOM and shortage counts. */
  projectReadiness?: Record<number, any>;
  triggerToast: (message: string, type?: ToastType) => void;
  onOpenProjectManager?: () => void;
}

type Focus = 'all' | 'moving' | 'hold' | 'overdue' | 'finished';
type Layout = 'board' | 'list';
const LAYOUT_KEY = 'projectProgress.layout';
// inputClass's look, for fields that need their own size and padding.
const fieldClass = 'rounded-lg border border-outline-variant bg-surface-container-low text-on-surface focus:outline-none focus:border-primary';

const dateText = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const dateTimeText = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const dayText = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const whoText = (email: string | null) => (email ? email.split('@')[0] : 'someone');

/** "today", "yesterday", "5 days ago", or the date. */
function agoText(iso: string | null): string {
  const days = daysSince(iso);
  if (days === null) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return dateText(iso);
}

async function send(method: 'POST' | 'PUT', url: string, body: unknown) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Everything the board works out about a project once, for cards, rows and details.
interface Placed {
  project: BoardProject;
  stage: Stage | null;
  index: number;
  finished: boolean;
  days: number | null;
  stuck: boolean;
  due: ReturnType<typeof dueStatus>;
  closed: boolean;
}

function place(project: BoardProject, stages: Stage[]): Placed {
  const index = Math.max(0, stages.findIndex((s) => s.id === project.stageId));
  const stage = stages[index] ?? null;
  const finished = stages.length > 0 && index === stages.length - 1;
  const days = project.stageSet ? daysSince(project.stageSince) : null;
  return {
    project, stage, index, finished, days,
    stuck: !finished && !project.onHold && days !== null && days >= STUCK_AFTER_DAYS,
    due: dueStatus(project.endDate, finished),
    closed: isClosedStatus(project.status),
  };
}

function readinessOf(readiness: unknown): { lines: number; short: number } | null {
  if (!Array.isArray(readiness)) return null;
  return { lines: readiness.length, short: readiness.filter((r: any) => Number(r?.shortage_qty) > 0).length };
}

const StageBar: React.FC<{ index: number; total: number; onHold: boolean }> = ({ index, total, onHold }) => (
  <div className="flex gap-0.5" aria-hidden="true">
    {Array.from({ length: total }, (_, i) => (
      <span key={i} className={`h-1 flex-1 rounded-full ${i <= index ? (onHold ? 'bg-amber-500/70' : 'bg-primary') : 'bg-surface-container-highest'}`} />
    ))}
  </div>
);

/** "12 days in Assembly", "Finished 3 days ago", "Stage not set yet". */
function stageLine(p: Placed): { text: string; className: string; title?: string } {
  const name = p.stage?.name ?? '';
  if (!p.project.stageSet) return { text: 'Stage not set yet', className: 'text-outline italic' };
  if (p.finished) return { text: `Finished${p.project.stageSince ? ` ${agoText(p.project.stageSince)}` : ''}`, className: 'text-green-500 font-bold' };
  if (p.days === null) return { text: `In ${name}`, className: 'text-on-surface-variant' };
  const text = p.days === 0 ? `In ${name} since today` : `${plural(p.days, 'day')} in ${name}`;
  return p.stuck
    ? { text, className: 'text-amber-500 font-bold', title: `No stage change for over ${STUCK_AFTER_DAYS} days` }
    : { text, className: 'text-on-surface-variant' };
}

function dueLine(p: Placed): { text: string; className: string } | null {
  if (!p.due) return null;
  const { day, daysLeft, overdue } = p.due;
  if (p.finished) return { text: `Due ${dayText(day)}`, className: 'text-outline' };
  if (overdue) return { text: `Due ${dayText(day)} · ${plural(-daysLeft, 'day')} overdue`, className: 'text-error font-bold' };
  if (daysLeft === 0) return { text: 'Due today', className: 'text-amber-500 font-bold' };
  if (daysLeft <= 7) return { text: `Due in ${plural(daysLeft, 'day')}`, className: 'text-amber-500' };
  return { text: `Due ${dayText(day)}`, className: 'text-on-surface-variant' };
}

const Signals: React.FC<{ project: BoardProject; readiness: unknown }> = ({ project, readiness }) => {
  const bom = readinessOf(readiness);
  const chips: Array<{ text: string; className: string; title?: string }> = [];
  if (bom) {
    if (bom.lines === 0) chips.push({ text: 'No BOM', className: 'bg-surface-container-high text-outline border-outline-variant' });
    else if (bom.short > 0) chips.push({ text: `BOM ${bom.lines} · ${bom.short} short`, className: 'bg-error/10 text-error border-error/20', title: `${plural(bom.short, 'part')} of ${bom.lines} short for one build` });
    else chips.push({ text: `BOM ${bom.lines} · in stock`, className: 'bg-green-500/10 text-green-500 border-green-500/20', title: `All ${bom.lines} parts in stock for one build` });
  }
  if (project.kits.count > 0) {
    chips.push({ text: plural(project.kits.count, 'kit'), className: 'bg-primary/10 text-primary border-primary/20', title: project.kits.lastSavedAt ? `Last kit saved ${agoText(project.kits.lastSavedAt)}` : undefined });
  }
  if (project.builds.inProgress > 0) {
    chips.push({ text: `Building ${project.builds.inProgressQty || project.builds.inProgress}`, className: 'bg-secondary/10 text-secondary border-secondary/20', title: `${plural(project.builds.inProgress, 'job card')} in progress` });
  }
  if (project.builds.completed > 0) {
    chips.push({ text: `${project.builds.completed} built`, className: 'bg-green-500/10 text-green-500 border-green-500/20', title: `${plural(project.builds.completed, 'job card')} completed` });
  }
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <span key={c.text} title={c.title} className={`text-[10px] font-bold px-1.5 py-0.5 rounded border whitespace-nowrap ${c.className}`}>{c.text}</span>
      ))}
    </div>
  );
};

const LastNote: React.FC<{ note: BoardProject['lastNote']; clamp?: boolean }> = ({ note, clamp = true }) => {
  if (!note) return null;
  return (
    <p className={`text-[11px] text-on-surface-variant ${clamp ? 'line-clamp-2' : ''}`} title={note.note}>
      “{note.note}” <span className="text-outline">— {whoText(note.by)}, {agoText(note.at)}</span>
    </p>
  );
};

interface CardProps {
  placed: Placed;
  stages: Stage[];
  readiness: unknown;
  canMove: boolean;
  onOpen: () => void;
  onMove: (stage: Stage) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

const ProjectCard: React.FC<CardProps> = ({ placed, stages, readiness, canMove, onOpen, onMove, onDragStart, onDragEnd }) => {
  const { project } = placed;
  const prev = placed.index > 0 ? stages[placed.index - 1] : null;
  const next = placed.index < stages.length - 1 ? stages[placed.index + 1] : null;
  const line = stageLine(placed);
  const due = dueLine(placed);
  return (
    <article
      data-testid={`project-card-${project.id}`}
      draggable={canMove}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(project.id)); e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={`rounded-lg border bg-surface-container p-2.5 space-y-1.5 cursor-pointer transition-colors hover:border-primary/50 ${project.onHold ? 'border-amber-500/40' : placed.due?.overdue ? 'border-error/40' : 'border-outline-variant'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(); }} className="text-left font-bold text-[13px] leading-tight text-on-surface hover:text-primary">
          {project.name}
        </button>
        <span className="text-[10px] font-mono text-outline shrink-0">#{project.id}</span>
      </div>
      <StageBar index={placed.index} total={stages.length} onHold={project.onHold} />
      {project.onHold && (
        <p className="text-[11px] text-amber-500 font-bold flex items-start gap-1">
          <PauseCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>On hold{project.holdReason ? `: ${project.holdReason}` : ''}</span>
        </p>
      )}
      <p className={`text-[11px] ${line.className}`} title={line.title}>{line.text}</p>
      {due && <p className={`text-[11px] flex items-center gap-1 ${due.className}`}><CalendarClock className="w-3 h-3" />{due.text}</p>}
      <Signals project={project} readiness={readiness} />
      <LastNote note={project.lastNote} />
      {canMove && (prev || next) && (
        <div className="flex items-center justify-between gap-1 pt-0.5">
          {prev ? (
            <button
              type="button"
              aria-label={`Move ${project.name} back to ${prev.name}`}
              title={`Back to ${prev.name}`}
              onClick={(e) => { e.stopPropagation(); onMove(prev); }}
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold text-outline hover:text-on-surface hover:bg-surface-container-high min-w-0"
            >
              <ChevronLeft className="w-3 h-3 shrink-0" /><span className="truncate">{prev.name}</span>
            </button>
          ) : <span />}
          {next && (
            <button
              type="button"
              aria-label={`Move ${project.name} on to ${next.name}`}
              title={`On to ${next.name}`}
              onClick={(e) => { e.stopPropagation(); onMove(next); }}
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold text-primary hover:bg-primary/10 min-w-0"
            >
              <span className="truncate">{next.name}</span><ChevronRight className="w-3 h-3 shrink-0" />
            </button>
          )}
        </div>
      )}
    </article>
  );
};

// ---------------------------------------------------------------------------
// Moving a project: from a card's arrows, a drag, or the list's "Move to".
// ---------------------------------------------------------------------------
const MoveDialog: React.FC<{
  placed: Placed;
  to: Stage;
  stages: Stage[];
  onClose: () => void;
  onMoved: (message: string) => void;
  onError: (message: string, reload: boolean) => void;
}> = ({ placed, to, stages, onClose, onMoved, onError }) => {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const from = placed.project.stageSet ? placed.stage?.name ?? null : null;
  const finalStage = stages[stages.length - 1]?.id === to.id;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { ok, status, data } = await send('POST', `/api/project-progress/${placed.project.id}/stage`, { stageId: to.id, note });
      if (!ok) { onError(data.error || 'Could not move the project.', status === 409); return; }
      onMoved(`${placed.project.name} moved to ${data.stageName ?? to.name}.`);
    } catch (err: any) {
      onError(`Could not move the project: ${err?.message || err}`, false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Move ${placed.project.name}`} subtitle={from ? `From ${from} to ${to.name}` : `To ${to.name}`} onClose={onClose} maxWidth="max-w-md">
      <form onSubmit={submit} className="space-y-md">
        {finalStage && <p className="text-xs text-on-surface-variant">{to.name} is the last stage: the project will show as finished.</p>}
        <div>
          <label htmlFor="move-note" className="block text-xs font-bold text-on-surface-variant mb-1">Note <span className="font-normal text-outline">(optional)</span></label>
          <textarea
            id="move-note"
            rows={3}
            maxLength={NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. PCBs arrived, starting assembly"
            className={inputClass}
          />
        </div>
        <div className="flex justify-end gap-sm">
          <SecondaryButton type="button" onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton type="submit" disabled={busy} icon={busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}>
            Move to {to.name}
          </PrimaryButton>
        </div>
      </form>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// One project's details: stages, hold, updates and history.
// ---------------------------------------------------------------------------
function historyText(e: LogEntry): string {
  if (e.kind === 'stage') return e.fromStage ? `Moved from ${e.fromStage} to ${e.toStage}` : `Set to ${e.toStage}`;
  if (e.kind === 'hold') return 'Put on hold';
  if (e.kind === 'resume') return 'Resumed';
  return 'Update';
}

const KIND_ICON: Record<LogKind, React.ReactNode> = {
  stage: <ChevronRight className="w-3.5 h-3.5 text-primary" />,
  hold: <PauseCircle className="w-3.5 h-3.5 text-amber-500" />,
  resume: <PlayCircle className="w-3.5 h-3.5 text-green-500" />,
  update: <ClipboardList className="w-3.5 h-3.5 text-on-surface-variant" />,
};

const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="bg-surface-container-high/40 rounded-lg border border-outline-variant/40 px-2.5 py-1.5 min-w-0">
    <div className="text-[10px] font-bold text-outline">{label}</div>
    <div className="text-xs text-on-surface truncate">{children}</div>
  </div>
);

const ProjectDetails: React.FC<{
  placed: Placed;
  stages: Stage[];
  readiness: unknown;
  canMove: boolean;
  refreshKey: number;
  onClose: () => void;
  onChanged: (message: string) => void;
  onError: (message: string, reload: boolean) => void;
  onOpenProjectManager?: () => void;
}> = ({ placed, stages, readiness, canMove, refreshKey, onClose, onChanged, onError, onOpenProjectManager }) => {
  const { project } = placed;
  const [history, setHistory] = useState<LogEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [target, setTarget] = useState<Stage | null>(null);
  const [moveNote, setMoveNote] = useState('');
  const [holdOpen, setHoldOpen] = useState(false);
  const [holdReason, setHoldReason] = useState('');
  const [update, setUpdate] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`/api/project-progress/${project.id}/history`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setHistoryError(data.error || 'Could not load the history.'); return; }
      setHistory(data.entries ?? []);
      setHistoryError(null);
    } catch (err: any) {
      setHistoryError(`Could not load the history: ${err?.message || err}`);
    }
  }, [project.id]);
  useEffect(() => { void loadHistory(); }, [loadHistory, refreshKey]);

  const act = async (key: string, url: string, body: unknown, message: (data: any) => string, after?: () => void) => {
    setBusy(key);
    try {
      const { ok, status, data } = await send('POST', url, body);
      if (!ok) { onError(data.error || 'That did not work.', status === 409); return; }
      after?.();
      onChanged(message(data));
      await loadHistory();
    } catch (err: any) {
      onError(`That did not work: ${err?.message || err}`, false);
    } finally {
      setBusy(null);
    }
  };

  const move = (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) return;
    void act('move', `/api/project-progress/${project.id}/stage`, { stageId: target.id, note: moveNote },
      (d) => `${project.name} moved to ${d.stageName ?? target.name}.`, () => { setTarget(null); setMoveNote(''); });
  };
  const hold = (e: React.FormEvent) => {
    e.preventDefault();
    void act('hold', `/api/project-progress/${project.id}/hold`, { onHold: true, reason: holdReason },
      () => `${project.name} is on hold.`, () => { setHoldOpen(false); setHoldReason(''); });
  };
  const resume = () => act('resume', `/api/project-progress/${project.id}/hold`, { onHold: false },
    () => `${project.name} resumed.`);
  const addUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!update.trim()) return;
    void act('update', `/api/project-progress/${project.id}/update`, { note: update },
      () => `Update added to ${project.name}.`, () => setUpdate(''));
  };

  const line = stageLine(placed);
  const due = dueLine(placed);
  const bom = readinessOf(readiness);

  return (
    <Modal title={project.name} subtitle={`#${project.id}${project.status ? ` · ${project.status}` : ''}${project.team ? ` · ${project.team}` : ''}`} onClose={onClose} maxWidth="max-w-2xl">
      <div className="space-y-md">
        <section aria-label="Stages">
          <ol className="flex flex-wrap gap-1.5">
            {stages.map((s, i) => {
              const current = s.id === placed.stage?.id;
              const done = i < placed.index;
              const selectable = canMove && (!current || !project.stageSet);
              const tone = current
                ? (project.onHold ? 'bg-amber-500/15 text-amber-500 border-amber-500/40' : 'bg-primary text-white border-primary')
                : done ? 'bg-green-500/10 text-green-500 border-green-500/25' : 'bg-surface-container-high text-outline border-outline-variant';
              const chosen = target?.id === s.id;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    disabled={!selectable}
                    aria-current={current ? 'step' : undefined}
                    onClick={() => { setTarget(chosen ? null : s); setMoveNote(''); }}
                    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors ${tone} ${chosen ? 'ring-2 ring-primary ring-offset-1 ring-offset-surface-container' : ''} ${selectable ? 'cursor-pointer hover:border-primary' : 'cursor-default'}`}
                    title={selectable ? (current ? `Set the stage to ${s.name}` : `Move to ${s.name}`) : undefined}
                  >
                    {done ? <Check className="w-3 h-3" /> : <span className="font-mono">{i + 1}</span>}
                    {s.name}
                  </button>
                </li>
              );
            })}
          </ol>
          {canMove && !target && (
            <p className="text-[11px] text-outline mt-1.5">{project.stageSet ? 'Click a stage to move the project there.' : 'Click the stage the project is at.'}</p>
          )}
          {target && (
            <form onSubmit={move} className="mt-sm rounded-lg border border-primary/30 bg-primary/5 p-sm space-y-sm">
              <label htmlFor="details-move-note" className="block text-xs font-bold text-on-surface">
                {project.stageSet && placed.stage ? `Move from ${placed.stage.name} to ${target.name}` : `Set the stage to ${target.name}`}
                <span className="font-normal text-outline"> — note (optional)</span>
              </label>
              <textarea id="details-move-note" rows={2} maxLength={NOTE_MAX} value={moveNote} onChange={(e) => setMoveNote(e.target.value)} className={inputClass} placeholder="e.g. Stencil ordered" />
              <div className="flex justify-end gap-sm">
                <SecondaryButton type="button" onClick={() => setTarget(null)}>Cancel</SecondaryButton>
                <PrimaryButton type="submit" disabled={busy !== null} icon={busy === 'move' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}>
                  {project.stageSet ? `Move to ${target.name}` : `Set to ${target.name}`}
                </PrimaryButton>
              </div>
            </form>
          )}
        </section>

        <p className={`text-xs ${line.className}`} title={line.title}>
          {line.text}
          {project.stageSet && project.stageSince && <span className="text-outline font-normal not-italic"> · since {dateText(project.stageSince)}{project.stageBy ? `, moved by ${whoText(project.stageBy)}` : ''}</span>}
        </p>

        {project.onHold && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-sm flex items-start justify-between gap-sm">
            <div className="text-xs text-amber-500">
              <div className="font-bold flex items-center gap-1"><PauseCircle className="w-3.5 h-3.5" /> On hold{project.holdSince ? ` since ${dateText(project.holdSince)}` : ''}{project.holdBy ? `, by ${whoText(project.holdBy)}` : ''}</div>
              {project.holdReason && <div className="mt-0.5 text-on-surface whitespace-pre-wrap">{project.holdReason}</div>}
            </div>
            {canMove && (
              <SecondaryButton type="button" onClick={() => void resume()} disabled={busy !== null} icon={busy === 'resume' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}>
                Resume
              </SecondaryButton>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          <Fact label="Due">{due ? <span className={due.className}>{due.text}</span> : <span className="text-outline">Not set</span>}</Fact>
          <Fact label="Started">{project.startDate || <span className="text-outline">Not set</span>}</Fact>
          <Fact label="BOM">{bom ? (bom.lines === 0 ? 'No BOM' : `${plural(bom.lines, 'part')}${bom.short ? `, ${bom.short} short` : ', in stock'}`) : <span className="text-outline">Not checked</span>}</Fact>
          <Fact label="Kits">{project.kits.count ? `${project.kits.count} saved` : <span className="text-outline">None</span>}</Fact>
          <Fact label="Building">{project.builds.inProgress ? `${plural(project.builds.inProgress, 'job card')}${project.builds.inProgressQty ? ` (${project.builds.inProgressQty})` : ''}` : <span className="text-outline">Nothing</span>}</Fact>
          <Fact label="Built">{project.builds.completed ? plural(project.builds.completed, 'job card') : <span className="text-outline">Nothing yet</span>}</Fact>
          <Fact label="Team">{project.team || <span className="text-outline">Not set</span>}</Fact>
          <Fact label="Last activity">{project.lastActivityAt ? agoText(project.lastActivityAt) : <span className="text-outline">Unknown</span>}</Fact>
        </div>

        {canMove && (
          <div className="space-y-sm">
            {!project.onHold && !holdOpen && (
              <SecondaryButton type="button" onClick={() => setHoldOpen(true)} icon={<PauseCircle className="w-3.5 h-3.5" />}>Put on hold</SecondaryButton>
            )}
            {!project.onHold && holdOpen && (
              <form onSubmit={hold} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-sm space-y-sm">
                <label htmlFor="hold-reason" className="block text-xs font-bold text-on-surface">Why is it on hold? <span className="font-normal text-outline">(everyone sees this on the board)</span></label>
                <input id="hold-reason" maxLength={NOTE_MAX} value={holdReason} onChange={(e) => setHoldReason(e.target.value)} className={inputClass} placeholder="e.g. Waiting for PCBs from the supplier" />
                <div className="flex justify-end gap-sm">
                  <SecondaryButton type="button" onClick={() => { setHoldOpen(false); setHoldReason(''); }}>Cancel</SecondaryButton>
                  <PrimaryButton type="submit" disabled={busy !== null} icon={busy === 'hold' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PauseCircle className="w-3.5 h-3.5" />}>Put on hold</PrimaryButton>
                </div>
              </form>
            )}
            <form onSubmit={addUpdate} className="space-y-1.5">
              <label htmlFor="progress-update" className="block text-xs font-bold text-on-surface-variant">Add an update</label>
              <textarea id="progress-update" rows={2} maxLength={NOTE_MAX} value={update} onChange={(e) => setUpdate(e.target.value)} className={inputClass} placeholder="Where it's at, what it's waiting for, what's next" />
              <div className="flex justify-end">
                <PrimaryButton type="submit" disabled={busy !== null || !update.trim()} icon={busy === 'update' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}>Add update</PrimaryButton>
              </div>
            </form>
          </div>
        )}

        <section aria-label="History">
          <h5 className="text-xs font-bold text-on-surface-variant mb-1.5 flex items-center gap-1"><History className="w-3.5 h-3.5" /> History</h5>
          {historyError && <p className="text-xs text-error">{historyError}</p>}
          {!historyError && history === null && <p className="text-xs text-outline"><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1" />Loading…</p>}
          {history && history.length === 0 && <p className="text-xs text-outline italic">Nothing recorded yet.</p>}
          {history && history.length > 0 && (
            <ol className="space-y-1.5 max-h-72 overflow-y-auto custom-scrollbar pr-1">
              {history.map((e) => (
                <li key={e.id} className="flex gap-2 text-xs">
                  <span className="mt-0.5 shrink-0">{KIND_ICON[e.kind] ?? KIND_ICON.update}</span>
                  <div className="min-w-0">
                    <div className="text-on-surface"><span className="font-bold">{historyText(e)}</span> <span className="text-outline">· {whoText(e.by)} · {dateTimeText(e.at)}</span></div>
                    {e.note && <div className="text-on-surface-variant whitespace-pre-wrap break-words">{e.note}</div>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        {onOpenProjectManager && (
          <div className="flex justify-end">
            <SecondaryButton type="button" onClick={onOpenProjectManager} icon={<ClipboardList className="w-3.5 h-3.5" />}>Open Project Manager</SecondaryButton>
          </div>
        )}
      </div>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// The stage list (admins).
// ---------------------------------------------------------------------------
interface EditRow { key: string; id: number | null; name: string }

const StagesEditor: React.FC<{
  stages: Stage[];
  counts: Record<number, number>;
  onClose: () => void;
  onSaved: () => void;
}> = ({ stages, counts, onClose, onSaved }) => {
  const [rows, setRows] = useState<EditRow[]>(() => stages.map((s) => ({ key: `s${s.id}`, id: s.id, name: s.name })));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(0);

  const swap = (i: number, j: number) => setRows((r) => {
    if (j < 0 || j >= r.length) return r;
    const copy = [...r];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    return copy;
  });
  // A new stage goes before the last one, which means finished.
  const add = () => {
    setAdded((n) => n + 1);
    setRows((r) => {
      const row = { key: `new${added}`, id: null, name: '' };
      return r.length ? [...r.slice(0, -1), row, r[r.length - 1]] : [row];
    });
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { ok, data } = await send('PUT', '/api/project-progress/stages', { stages: rows.map((r) => ({ id: r.id, name: r.name })) });
      if (!ok) { setError(data.error || 'Could not save the stages.'); return; }
      onSaved();
    } catch (err: any) {
      setError(`Could not save the stages: ${err?.message || err}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Project stages" subtitle="The steps every project goes through, in order. The last one means finished." onClose={onClose} maxWidth="max-w-lg">
      <form onSubmit={save} className="space-y-md">
        <ol className="space-y-1.5">
          {rows.map((row, i) => {
            const inUse = row.id !== null ? counts[row.id] ?? 0 : 0;
            return (
              <li key={row.key} className="flex items-center gap-1.5">
                <span className="w-5 text-right text-[11px] font-mono text-outline">{i + 1}</span>
                <input
                  aria-label={`Stage ${i + 1} name`}
                  value={row.name}
                  maxLength={STAGE_NAME_MAX}
                  onChange={(e) => { const name = e.target.value; setRows((r) => r.map((x) => (x.key === row.key ? { ...x, name } : x))); }}
                  className={`${fieldClass} w-full px-3 py-1.5 text-sm`}
                  placeholder="Stage name"
                />
                <button type="button" aria-label={`Move ${row.name || 'stage'} up`} disabled={i === 0} onClick={() => swap(i, i - 1)} className="p-1.5 rounded text-outline hover:text-on-surface hover:bg-surface-container-high disabled:opacity-30"><ArrowUp className="w-3.5 h-3.5" /></button>
                <button type="button" aria-label={`Move ${row.name || 'stage'} down`} disabled={i === rows.length - 1} onClick={() => swap(i, i + 1)} className="p-1.5 rounded text-outline hover:text-on-surface hover:bg-surface-container-high disabled:opacity-30"><ArrowDown className="w-3.5 h-3.5" /></button>
                <button
                  type="button"
                  aria-label={`Remove ${row.name || 'stage'}`}
                  disabled={inUse > 0 || rows.length <= MIN_STAGES}
                  title={inUse > 0 ? `${plural(inUse, 'project is', 'projects are')} in this stage: move them first` : undefined}
                  onClick={() => setRows((r) => r.filter((x) => x.key !== row.key))}
                  className="p-1.5 rounded text-outline hover:text-error hover:bg-error/10 disabled:opacity-30"
                ><X className="w-3.5 h-3.5" /></button>
              </li>
            );
          })}
        </ol>
        <SecondaryButton type="button" onClick={add} disabled={rows.length >= MAX_STAGES} icon={<Plus className="w-3.5 h-3.5" />}>Add a stage</SecondaryButton>
        <p className="text-[11px] text-outline">Renaming a stage keeps its projects in it. A stage with projects in it can't be removed. The history keeps the names as they were.</p>
        {error && <p className="text-xs text-error" role="alert">{error}</p>}
        <div className="flex justify-end gap-sm">
          <SecondaryButton type="button" onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton type="submit" disabled={busy} icon={busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}>Save stages</PrimaryButton>
        </div>
      </form>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------
const FOCUS_LABEL: Record<Exclude<Focus, 'all'>, string> = { moving: 'In progress', hold: 'On hold', overdue: 'Overdue', finished: 'Finished' };

function readLayout(): Layout {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    return saved === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}

export default function ProjectProgressView({ projectReadiness = {}, triggerToast, onOpenProjectManager }: Props) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [layout, setLayoutState] = useState<Layout>(readLayout);
  const [search, setSearch] = useState('');
  const [focus, setFocus] = useState<Focus>('all');
  const [showClosed, setShowClosed] = useState(false);
  const [moving, setMoving] = useState<{ projectId: number; to: Stage } | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [editingStages, setEditingStages] = useState(false);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropStage, setDropStage] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/project-progress');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Could not load the board.'); return; }
      setBoard({ stages: data.stages ?? [], projects: data.projects ?? [], can: data.can ?? { move: false, editStages: false } });
      setError(null);
      setRefreshKey((k) => k + 1);
    } catch (err: any) {
      setError(`Could not load the board: ${err?.message || err}`);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Someone else moved a project, changed a project or saved a kit.
  useDataChanged(['project_progress', 'projects', 'production_kits'], () => { void load(); });

  const setLayout = (next: Layout) => {
    setLayoutState(next);
    try { localStorage.setItem(LAYOUT_KEY, next); } catch { /* remembered for this visit only */ }
  };

  const stages = useMemo(() => [...(board?.stages ?? [])].sort((a, b) => a.position - b.position || a.id - b.id), [board]);
  const placed = useMemo(() => (board?.projects ?? []).map((p) => place(p, stages)), [board, stages]);
  const closedCount = placed.filter((p) => p.closed).length;
  const open = placed.filter((p) => showClosed || !p.closed);
  const summary = {
    moving: open.filter((p) => !p.finished && !p.project.onHold).length,
    hold: open.filter((p) => p.project.onHold).length,
    overdue: open.filter((p) => p.due?.overdue).length,
    finished: open.filter((p) => p.finished).length,
  };
  const notSet = open.filter((p) => !p.project.stageSet).length;
  const needle = search.trim().toLowerCase();
  const visible = open
    .filter((p) => focus === 'all'
      || (focus === 'moving' && !p.finished && !p.project.onHold)
      || (focus === 'hold' && p.project.onHold)
      || (focus === 'overdue' && p.due?.overdue)
      || (focus === 'finished' && p.finished))
    .filter((p) => !needle || [p.project.name, p.project.team, p.stage?.name, p.project.holdReason, p.project.lastNote?.note, `#${p.project.id}`]
      .some((v) => String(v ?? '').toLowerCase().includes(needle)))
    .sort((a, b) => a.index - b.index || a.project.name.localeCompare(b.project.name, undefined, { numeric: true, sensitivity: 'base' }));
  const counts = useMemo(() => {
    const c: Record<number, number> = {};
    for (const p of board?.projects ?? []) if (p.stageSet && p.stageId !== null) c[p.stageId] = (c[p.stageId] ?? 0) + 1;
    return c;
  }, [board]);

  const canMove = board?.can.move ?? false;
  const movingPlaced = moving ? placed.find((p) => p.project.id === moving.projectId) ?? null : null;
  const openPlaced = openId !== null ? placed.find((p) => p.project.id === openId) ?? null : null;

  const onError = (message: string, reload: boolean) => {
    triggerToast(message, 'ERROR');
    if (reload) void load();
  };
  const onChanged = (message: string) => {
    triggerToast(message, 'SUCCESS');
    void load();
  };

  const drop = (stage: Stage) => {
    const p = placed.find((x) => x.project.id === dragId);
    setDragId(null);
    setDropStage(null);
    if (!p || !canMove) return;
    if (p.project.stageSet && p.stage?.id === stage.id) return;
    setMoving({ projectId: p.project.id, to: stage });
  };

  if (!board) {
    return (
      <div className="p-container-margin max-w-[1600px] mx-auto w-full">
        <h3 className="font-headline-sm text-lg text-on-surface">Project Progress</h3>
        {error ? (
          <div className="mt-md rounded-lg border border-error/30 bg-error/10 p-md text-sm text-error flex items-center justify-between gap-md">
            <span>{error}</span>
            <SecondaryButton type="button" onClick={() => void load()} icon={<RefreshCw className="w-3.5 h-3.5" />}>Try again</SecondaryButton>
          </div>
        ) : (
          <p className="mt-md text-sm text-outline"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading the board…</p>
        )}
      </div>
    );
  }

  const chip = (key: Exclude<Focus, 'all'>, n: number, tone: string) => (
    <button
      key={key}
      type="button"
      aria-pressed={focus === key}
      onClick={() => setFocus(focus === key ? 'all' : key)}
      className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors ${focus === key ? 'ring-2 ring-primary/50' : ''} ${n ? tone : 'bg-surface-container-high text-outline border-outline-variant'}`}
    >
      {n} {FOCUS_LABEL[key].toLowerCase()}
    </button>
  );

  return (
    <div className="p-container-margin max-w-[1600px] mx-auto w-full space-y-md">
      <div className="flex flex-wrap items-end justify-between gap-md">
        <div>
          <h3 className="font-headline-sm text-lg text-on-surface">Project Progress</h3>
          <p className="text-on-surface-variant text-xs max-w-2xl">
            Every project in the stage it has reached. {canMove ? 'Move a project on when it gets to its next stage; everyone sees the change.' : `${notAllowedMessage('projects.update')} You can see the board.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-sm">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-outline" />
            <input
              type="search"
              aria-label="Search projects"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects"
              className={`${fieldClass} w-48 pl-8 pr-3 py-1.5 text-sm`}
            />
          </div>
          <div className="inline-flex rounded-lg border border-outline-variant overflow-hidden" role="group" aria-label="Layout">
            <button type="button" aria-pressed={layout === 'board'} onClick={() => setLayout('board')} className={`px-2.5 py-1.5 text-xs font-bold flex items-center gap-1 ${layout === 'board' ? 'bg-primary/10 text-primary' : 'text-outline hover:text-on-surface'}`}><Columns3 className="w-3.5 h-3.5" />Board</button>
            <button type="button" aria-pressed={layout === 'list'} onClick={() => setLayout('list')} className={`px-2.5 py-1.5 text-xs font-bold flex items-center gap-1 border-l border-outline-variant ${layout === 'list' ? 'bg-primary/10 text-primary' : 'text-outline hover:text-on-surface'}`}><List className="w-3.5 h-3.5" />List</button>
          </div>
          {board.can.editStages && (
            <SecondaryButton type="button" onClick={() => setEditingStages(true)} icon={<Settings2 className="w-3.5 h-3.5" />}>Edit stages</SecondaryButton>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {chip('moving', summary.moving, 'bg-primary/10 text-primary border-primary/25')}
        {chip('hold', summary.hold, 'bg-amber-500/10 text-amber-500 border-amber-500/25')}
        {chip('overdue', summary.overdue, 'bg-error/10 text-error border-error/25')}
        {chip('finished', summary.finished, 'bg-green-500/10 text-green-500 border-green-500/25')}
        {closedCount > 0 && (
          <label className="ml-1 inline-flex items-center gap-1.5 text-[11px] text-on-surface-variant cursor-pointer">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
            Show inactive and completed projects ({closedCount})
          </label>
        )}
        {error && <span className="text-[11px] text-error ml-auto">{error}</span>}
      </div>

      {notSet > 0 && canMove && (
        <p className="text-[11px] text-on-surface-variant rounded-lg border border-outline-variant bg-surface-container-low px-sm py-1.5">
          <AlertTriangle className="w-3.5 h-3.5 inline mr-1 text-amber-500" />
          {plural(notSet, "project hasn't", "projects haven't")} been given a stage yet, so {notSet === 1 ? 'it shows' : 'they show'} in {stages[0]?.name ?? 'the first stage'}. Open one and click the stage it's at.
        </p>
      )}

      {placed.length === 0 ? (
        <div className="rounded-xl border border-outline-variant bg-surface-container p-lg text-center text-sm text-outline">
          No projects yet.{onOpenProjectManager && <> <button type="button" onClick={onOpenProjectManager} className="text-primary font-bold hover:underline">Create one in Project Manager.</button></>}
        </div>
      ) : layout === 'board' ? (
        <div className="flex flex-col md:flex-row md:items-start gap-3 md:overflow-x-auto pb-2 custom-scrollbar">
          {stages.map((stage, i) => {
            const here = visible.filter((p) => p.stage?.id === stage.id);
            const droppable = dragId !== null && canMove;
            return (
              <section
                key={stage.id}
                aria-label={stage.name}
                data-testid={`stage-column-${stage.id}`}
                onDragOver={(e) => { if (droppable) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropStage(stage.id); } }}
                onDragLeave={() => setDropStage((s) => (s === stage.id ? null : s))}
                onDrop={(e) => { e.preventDefault(); drop(stage); }}
                className={`md:flex-1 md:min-w-[200px] md:max-w-[320px] rounded-xl border bg-surface-container-low transition-colors ${dropStage === stage.id ? 'border-primary bg-primary/5' : 'border-outline-variant'}`}
              >
                <header className="flex items-center justify-between gap-2 px-2.5 py-2 border-b border-outline-variant/60">
                  <span className="text-xs font-bold text-on-surface flex items-center gap-1.5 min-w-0">
                    <span className="text-[10px] font-mono text-outline">{i + 1}</span>
                    <span className="truncate">{stage.name}</span>
                    {i === stages.length - 1 && <Check className="w-3.5 h-3.5 text-green-500 shrink-0" aria-label="Finished" />}
                  </span>
                  <span className="text-[10px] font-bold text-outline bg-surface-container-high rounded-full px-1.5 py-0.5">{here.length}</span>
                </header>
                <div className="p-2 space-y-2">
                  {here.map((p) => (
                    <ProjectCard
                      key={p.project.id}
                      placed={p}
                      stages={stages}
                      readiness={projectReadiness[p.project.id]}
                      canMove={canMove}
                      onOpen={() => setOpenId(p.project.id)}
                      onMove={(to) => setMoving({ projectId: p.project.id, to })}
                      onDragStart={() => setDragId(p.project.id)}
                      onDragEnd={() => { setDragId(null); setDropStage(null); }}
                    />
                  ))}
                  {here.length === 0 && <p className="text-[11px] text-outline italic px-1 py-1">No projects here</p>}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-outline-variant bg-surface-container overflow-x-auto custom-scrollbar">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] font-bold text-outline border-b border-outline-variant">
                <th className="px-sm py-2">Project</th>
                <th className="px-sm py-2">Stage</th>
                <th className="px-sm py-2 min-w-[120px]">Progress</th>
                <th className="px-sm py-2">Due</th>
                <th className="px-sm py-2 min-w-[200px]">Latest</th>
                {canMove && <th className="px-sm py-2">Move to</th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => {
                const line = stageLine(p);
                const due = dueLine(p);
                return (
                  <tr key={p.project.id} data-testid={`project-row-${p.project.id}`} className="border-b border-outline-variant/50 last:border-0 align-top hover:bg-surface-container-high/30">
                    <td className="px-sm py-2">
                      <button type="button" onClick={() => setOpenId(p.project.id)} className="font-bold text-on-surface hover:text-primary text-left">{p.project.name}</button>
                      <div className="text-[10px] font-mono text-outline">#{p.project.id}{p.project.team ? ` · ${p.project.team}` : ''}</div>
                    </td>
                    <td className="px-sm py-2">
                      <div className="font-bold text-on-surface">{p.stage?.name}</div>
                      <div className={`text-[11px] ${line.className}`} title={line.title}>{line.text}</div>
                      {p.project.onHold && <div className="text-[11px] text-amber-500 font-bold">On hold{p.project.holdReason ? `: ${p.project.holdReason}` : ''}</div>}
                    </td>
                    <td className="px-sm py-2">
                      <StageBar index={p.index} total={stages.length} onHold={p.project.onHold} />
                      <div className="text-[10px] text-outline mt-1">{p.index + 1} of {stages.length}</div>
                    </td>
                    <td className="px-sm py-2">{due ? <span className={`text-[11px] ${due.className}`}>{due.text}</span> : <span className="text-[11px] text-outline">—</span>}</td>
                    <td className="px-sm py-2 space-y-1">
                      <Signals project={p.project} readiness={projectReadiness[p.project.id]} />
                      <LastNote note={p.project.lastNote} />
                    </td>
                    {canMove && (
                      <td className="px-sm py-2">
                        <select
                          aria-label={`Move ${p.project.name} to`}
                          value=""
                          onChange={(e) => {
                            const to = stages.find((s) => s.id === Number(e.target.value));
                            if (to) setMoving({ projectId: p.project.id, to });
                          }}
                          className={`${fieldClass} w-36 px-2 py-1 text-xs`}
                        >
                          <option value="">Move to…</option>
                          {stages.filter((s) => !p.project.stageSet || s.id !== p.stage?.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </td>
                    )}
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr><td colSpan={canMove ? 6 : 5} className="py-8 text-center text-outline italic">No projects match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {movingPlaced && moving && (
        <MoveDialog
          placed={movingPlaced}
          to={moving.to}
          stages={stages}
          onClose={() => setMoving(null)}
          onMoved={(message) => { setMoving(null); onChanged(message); }}
          onError={(message, reload) => { setMoving(null); onError(message, reload); }}
        />
      )}
      {openPlaced && (
        <ProjectDetails
          placed={openPlaced}
          stages={stages}
          readiness={projectReadiness[openPlaced.project.id]}
          canMove={canMove}
          refreshKey={refreshKey}
          onClose={() => setOpenId(null)}
          onChanged={onChanged}
          onError={onError}
          onOpenProjectManager={onOpenProjectManager ? () => { setOpenId(null); onOpenProjectManager(); } : undefined}
        />
      )}
      {editingStages && (
        <StagesEditor
          stages={stages}
          counts={counts}
          onClose={() => setEditingStages(false)}
          onSaved={() => { setEditingStages(false); onChanged('Stages saved.'); }}
        />
      )}
    </div>
  );
}
