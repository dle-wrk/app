// Part-number review: placeholders, supplier names and other things in the
// part-number fields that stop items being priced, with the fixes the server
// offers (src/lib/partNumberReview.ts). Anyone signed in can see the list;
// roles that may change inventory can apply the fixes, which save for
// everyone.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Download, Loader2, RefreshCw, Wrench } from 'lucide-react';
import { confirmDialog } from '../lib/confirmDialog';
import { fmtNumber } from '../lib/formatMoney';
import { currentUserCan, notAllowedMessage } from '../lib/permissions';
import { PrimaryButton, SecondaryButton } from './bookkeeping/shared';

type IssueKind = 'supplier_name' | 'placeholder' | 'lcsc_extra_text' | 'not_a_part_number' | 'held_back' | 'swapped' | 'no_part_number';
type FixAction = 'move_to_supplier' | 'clear' | 'set';
type ToastType = 'SUCCESS' | 'ERROR' | 'INFO';

export interface PartNumberIssue {
  kind: IssueKind;
  serialNumber: string;
  name: string | null;
  field: string | null;
  value: string | null;
  fix: { action: FixAction; value?: string } | null;
  note: string;
}

interface ReviewResponse {
  issues: PartNumberIssue[];
  counts: Partial<Record<IssueKind, number>>;
  fixable: number;
  canFix: boolean;
}

interface Props {
  onShowNotification: (msg: string, type?: ToastType) => void;
  /** Opens an item's detail. */
  onOpenItem?: (serialNumber: string) => void;
  /** Called after fixes are saved, so the app reloads its inventory. */
  onChanged?: () => void;
}

const SECTIONS: Array<{ kind: IssueKind; title: string; blurb: string; collapsed?: boolean }> = [
  { kind: 'supplier_name', title: 'Supplier names in part-number fields',
    blurb: 'The item form used to save the supplier into the first supplier part-number field, so suppliers were asked for a part called "Digikey". The fix moves the name to the item\'s Supplier field.' },
  { kind: 'lcsc_extra_text', title: 'LCSC numbers with extra text',
    blurb: 'LCSC can only be asked by its part number on its own.' },
  { kind: 'placeholder', title: 'Placeholders',
    blurb: 'Values that mean "no part number". Clearing them changes nothing else.' },
  { kind: 'held_back', title: 'Prices held back: the part number matched the wrong part',
    blurb: 'Needs a person: open the item and correct its part number. Bulk pricing tries again on its next run.' },
  { kind: 'not_a_part_number', title: 'Manufacturer fields without digits',
    blurb: 'Not used for pricing. Leave a real model code that has no digits; replace a description with the manufacturer part number.' },
  { kind: 'swapped', title: 'Stock code and name look swapped',
    blurb: 'Renaming a stock code isn\'t possible in the app yet.' },
  { kind: 'no_part_number', title: 'No part number', collapsed: true,
    blurb: 'These can\'t be priced. Add a manufacturer or supplier part number to anything bought in; items made in-house need none.' },
];

const FIELD_LABEL: Record<string, string> = {
  man_pn_1: 'ManPN1', man_pn_2: 'ManPN2', man_pn_3: 'ManPN3', man_pn_4: 'ManPN4', man_pn_5: 'ManPN5',
  sup_pn_1: 'SupPN1', sup_pn_2: 'SupPN2', sup_pn_3: 'SupPN3', sup_pn_4: 'SupPN4', sup_pn_5: 'SupPN5',
};

function fixLabel(issue: PartNumberIssue): string {
  if (!issue.fix) return '';
  if (issue.fix.action === 'move_to_supplier') return 'Move to Supplier';
  if (issue.fix.action === 'set') return `Use ${issue.fix.value}`;
  return 'Clear';
}

const issueKey = (i: PartNumberIssue) => `${i.kind}|${i.serialNumber}|${i.field ?? ''}`;

function toCsv(issues: PartNumberIssue[]): string {
  const title = Object.fromEntries(SECTIONS.map((s) => [s.kind, s.title]));
  const rows = [['Stock code', 'Name', 'Issue', 'Field', 'Current value', 'Fix', 'Notes'],
    ...issues.map((i) => [i.serialNumber, i.name ?? '', title[i.kind] ?? i.kind, i.field ? FIELD_LABEL[i.field] ?? i.field : '', i.value ?? '', fixLabel(i), i.note])];
  return '﻿' + rows.map((r) => r.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n') + '\r\n';
}

export default function PartNumberReview({ onShowNotification, onOpenItem, onChanged }: Props) {
  const canFix = currentUserCan('inventory.update');
  const [data, setData] = useState<ReviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(SECTIONS.map((s) => [s.kind, !s.collapsed])));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/inventory/part-number-review');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || 'Could not load the part-number review.'); return; }
      setData(body);
      setError(null);
    } catch (err: any) {
      setError(`Could not load the part-number review: ${err?.message || err}`);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const byKind = useMemo(() => {
    const map = new Map<IssueKind, PartNumberIssue[]>();
    for (const i of data?.issues ?? []) map.set(i.kind, [...(map.get(i.kind) ?? []), i]);
    return map;
  }, [data]);

  const apply = async (issues: PartNumberIssue[], key: string) => {
    const fixable = issues.filter((i) => i.fix && i.field && i.value);
    if (!fixable.length) return;
    if (fixable.length > 1) {
      const ok = await confirmDialog({
        title: 'Fix part numbers',
        message: `Apply ${fmtNumber(fixable.length)} fixes?\n\nEach changes one part-number field as shown in the list (supplier names move to the item's Supplier field). Every change is recorded in the activity log with your name.`,
        confirmLabel: `Apply ${fmtNumber(fixable.length)} fixes`,
      });
      if (!ok) return;
    }
    setBusy(key);
    try {
      const res = await fetch('/api/inventory/part-number-review/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fixes: fixable.map((i) => ({ serialNumber: i.serialNumber, field: i.field, action: i.fix!.action, expected: i.value, ...(i.fix!.value ? { value: i.fix!.value } : {}) })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { onShowNotification(body.error || 'Could not apply the fixes.', 'ERROR'); return; }
      const applied = body.applied?.length ?? 0;
      const skipped = body.skipped?.length ?? 0;
      onShowNotification(
        `${fmtNumber(applied)} ${applied === 1 ? 'fix' : 'fixes'} saved${skipped ? `; ${fmtNumber(skipped)} skipped because the value changed since the list was loaded` : ''}.`,
        skipped ? 'INFO' : 'SUCCESS',
      );
      if (applied) onChanged?.();
      await load();
    } catch (err: any) {
      onShowNotification(`Could not apply the fixes: ${err?.message || err}`, 'ERROR');
    } finally {
      setBusy(null);
    }
  };

  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([toCsv(data.issues)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `part-number-review-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const itemCount = new Set((data?.issues ?? []).map((i) => i.serialNumber)).size;

  return (
    <div className="space-y-lg" data-testid="part-number-review">
      <div className="bg-surface-container rounded-xl border border-outline-variant p-lg">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-md">
          <div className="max-w-[720px]">
            <h4 className="text-base font-bold text-on-surface flex items-center gap-2"><Wrench className="w-4 h-4 text-primary" /> Part numbers</h4>
            <p className="text-xs text-on-surface-variant mt-1 leading-relaxed">
              Things in the part-number fields that stop items being priced, or make suppliers return the wrong part. Pricing already
              ignores placeholders and supplier names; fixing them here cleans up the data for everything else too.
            </p>
            {data && (
              <p className="text-xs text-on-surface mt-2" data-testid="review-summary">
                {fmtNumber(data.issues.length)} {data.issues.length === 1 ? 'issue' : 'issues'} on {fmtNumber(itemCount)} {itemCount === 1 ? 'item' : 'items'};{' '}
                {fmtNumber(data.fixable)} can be fixed here.
              </p>
            )}
            {!canFix && <p className="text-[11px] text-outline mt-1">{notAllowedMessage('inventory.update')} You can see the list.</p>}
          </div>
          <div className="flex gap-sm shrink-0">
            <SecondaryButton type="button" onClick={() => void load()} icon={loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}>Refresh</SecondaryButton>
            <SecondaryButton type="button" onClick={download} disabled={!data} icon={<Download className="w-3.5 h-3.5" />}>Download list</SecondaryButton>
          </div>
        </div>
        {error && (
          <div className="mt-md flex items-center gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
            <AlertTriangle className="w-3.5 h-3.5" /> {error}
          </div>
        )}
      </div>

      {data && SECTIONS.map((section) => {
        const issues = byKind.get(section.kind) ?? [];
        if (!issues.length) return null;
        const fixable = issues.filter((i) => i.fix);
        const isOpen = open[section.kind];
        return (
          <div key={section.kind} className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden" data-testid={`section-${section.kind}`}>
            <div className="px-lg py-sm border-b border-outline-variant bg-surface-container-high/30 flex flex-wrap items-center justify-between gap-sm">
              <button type="button" className="flex items-center gap-sm text-left" aria-expanded={isOpen}
                onClick={() => setOpen((o) => ({ ...o, [section.kind]: !o[section.kind] }))}>
                {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                <span className="font-bold text-sm">{section.title}</span>
                <span className="text-[11px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded">{fmtNumber(issues.length)}</span>
              </button>
              {canFix && fixable.length > 0 && (
                <PrimaryButton type="button" disabled={busy !== null} onClick={() => void apply(fixable, section.kind)}
                  icon={busy === section.kind ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}>
                  Fix all {fmtNumber(fixable.length)}
                </PrimaryButton>
              )}
            </div>
            {isOpen && (
              <>
                <p className="px-lg pt-sm text-[11px] text-on-surface-variant">{section.blurb}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="text-[10px] text-outline uppercase tracking-wider">
                        <th className="px-lg py-sm">Item</th>
                        <th className="px-lg py-sm">Field</th>
                        <th className="px-lg py-sm">Value</th>
                        <th className="px-lg py-sm">What to do</th>
                        <th className="px-lg py-sm"><span className="sr-only">Action</span></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/30">
                      {issues.map((i) => (
                        <tr key={issueKey(i)} data-issue={issueKey(i)}>
                          <td className="px-lg py-sm">
                            {onOpenItem
                              ? <button type="button" className="font-mono font-bold text-primary hover:underline" onClick={() => onOpenItem(i.serialNumber)}>{i.serialNumber}</button>
                              : <span className="font-mono font-bold">{i.serialNumber}</span>}
                            {i.name && <span className="block text-[11px] text-on-surface-variant">{i.name}</span>}
                          </td>
                          <td className="px-lg py-sm text-on-surface-variant whitespace-nowrap">{i.field ? FIELD_LABEL[i.field] ?? i.field : '—'}</td>
                          <td className="px-lg py-sm font-mono">{i.value ?? '—'}</td>
                          <td className="px-lg py-sm text-on-surface-variant max-w-[420px]">{i.note}</td>
                          <td className="px-lg py-sm text-right whitespace-nowrap">
                            {i.fix && canFix && (
                              <SecondaryButton type="button" disabled={busy !== null} onClick={() => void apply([i], issueKey(i))}
                                icon={busy === issueKey(i) ? <Loader2 className="w-3 h-3 animate-spin" /> : undefined}>
                                {fixLabel(i)}
                              </SecondaryButton>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        );
      })}

      {data && data.issues.length === 0 && (
        <div className="bg-surface-container rounded-xl border border-outline-variant p-lg text-xs text-on-surface-variant">Nothing to fix: every part-number field holds a part number.</div>
      )}
    </div>
  );
}
