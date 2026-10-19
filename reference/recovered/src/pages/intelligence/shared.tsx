import { useState, type ReactNode } from 'react';
import { api, buildQuery } from '@/api/client';
import type { StudentRow } from '@/api/types';
import { useApiQuery } from '@/hooks/useApi';
import { Button, Icon, SearchInput, Skeleton, useToast, errorMessage } from '@/components/ui';
import { cx, fmt } from '@/lib/format';

export const STAGES = ['Signal', 'Teacher Review', 'Intervention', 'Action', 'Follow-up', 'Closed'];
export const STAGE_SHORT = ['Signal', 'Review', 'Intervene', 'Act', 'Follow up', 'Close'];
export const RISK_LEVELS = ['On Track', 'Watch', 'Developing Risk', 'At Risk'];

// ---------------------------------------------------------------------------
// Types (API shapes)
// ---------------------------------------------------------------------------
export interface EwSummary {
  bands: { total: number; atRisk: number; developing: number; watch: number; onTrack: number };
  stages: { stage: number; label: string; count: number }[];
  closedThisTerm: number; reviewed: number; dismissed: number; openInterventions: number;
  awaitingReview: number; overdueReviews: number; termStart: string;
  thresholds: { attendance: number; scoreDrop: number };
}

export interface EwStudent extends StudentRow {
  intervention: 'Review pending' | 'Planned' | 'Active' | 'Monitoring' | 'None';
  signalId: string | null;
  signalDecision: string | null;
}

export interface Signal {
  id: string; code: string; signal: string; signalType: string; stage: number; stageLabel?: string;
  raisedOn: string; decision: 'accepted' | 'dismissed' | null; actionPlan: string | null; nextReviewOn: string | null;
  reviewedAt: string | null; closedAt: string | null; ownerId: string | null; owner: string | null; reviewedBy: string | null;
  studentId: string; studentName: string; admissionNo: string; grade: string | null; section: string | null; risk: string;
}

export interface SignalDetail extends Signal {
  student: { attendance: number | null; average: number | null; trend: number; classTeacherSection: string } | null;
  participation: { activities: number; concerns: number; positives: number; absent30: number; late30: number };
  behaviour: { date: string; type: string; note: string; by: string | null }[];
  observations: { date: string; text: string; by: string }[];
  history: { at: string; by: string; action: string; description: string }[];
  thresholds: { attendance: number; scoreDrop: number };
}

export interface RunCheckResult {
  checked: number; matched: number; skipped: number;
  created: { id: string; code: string; studentId: string; studentName: string; admissionNo: string; rule: string; signal: string }[];
  rules: { id: string; type: string; description: string }[];
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------
export function TrendCell({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="t-faint">—</span>;
  const tone = value > 2 ? 'success' : value < -3 ? 'critical' : value < 0 ? 'warning' : 'muted';
  return (
    <span className="row g-2">
      <span className={cx('t-num t-bold', `t-${tone}`)}>{value > 0 ? '+' : ''}{value}</span>
      <Icon name={value >= 0 ? 'arrowUp' : 'arrowDown'} size={12} />
    </span>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('eyebrow', className ?? 'mb-2')}>{children}</div>;
}

/** Bulleted check list used across the prototype and co-pilot screens. */
export function CheckList({ items, icon = 'check', tone = 't-success' }: { items: ReactNode[]; icon?: string; tone?: string }) {
  return (
    <ul className="col g-2">
      {items.map((a, i) => (
        <li key={i} className="row g-2 t-sm"><Icon name={icon} size={14} className={tone} />{a}</li>
      ))}
    </ul>
  );
}

export function LabelledPoints({ rows, icon = 'check', tone = 't-success' }: { rows: [string, string][]; icon?: string; tone?: string }) {
  return (
    <div className="col g-3">
      {rows.map(([title, text]) => (
        <div className="row-top g-3" key={title}>
          <Icon name={icon} size={15} className={tone} />
          <span className="col"><span className="t-sm t-bold">{title}</span><span className="t-xs t-muted">{text}</span></span>
        </div>
      ))}
    </div>
  );
}

/** Downloads a server-generated CSV (auth header included) with a toast on failure. */
export function useCsvDownload() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const download = async (key: string, path: string, params?: Record<string, string | number | boolean | null | undefined>, fallback = 'report.csv') => {
    setBusy(key);
    try {
      await api.download(`${path}${buildQuery(params)}`, fallback);
      toast('Download started', 'success', 'download');
    } catch (err) {
      toast(errorMessage(err), 'critical');
    } finally {
      setBusy(null);
    }
  };
  return { download, busy };
}

/** Type-ahead student search (server-side, scoped to the signed-in user). */
export function StudentPicker({ onPick, placeholder = 'Search a student by name or admission number', autoFocus }: {
  onPick: (s: StudentRow) => void; placeholder?: string; autoFocus?: boolean;
}) {
  const [q, setQ] = useState('');
  const res = useApiQuery<StudentRow[]>(q.length >= 2 ? '/students' : null, { q, pageSize: 8, sort: 'name' });
  return (
    <div className="col g-2" style={{ position: 'relative' }} data-autofocus={autoFocus || undefined}>
      <SearchInput value={q} onSearch={setQ} placeholder={placeholder} maxWidth={520} />
      {q.length >= 2 && (
        <div className="card" style={{ maxWidth: 520 }} role="listbox" aria-label="Matching students">
          {res.isLoading ? (
            <div className="col g-2" style={{ padding: 12 }}><Skeleton height={14} /><Skeleton height={14} width="70%" /></div>
          ) : res.error ? (
            <div className="t-sm t-critical" style={{ padding: 12 }}>{errorMessage(res.error)}</div>
          ) : !res.data?.length ? (
            <div className="t-sm t-muted" style={{ padding: 12 }}>No students match “{q}” in your classes.</div>
          ) : (
            res.data.map((s) => (
              <button type="button" key={s.id} role="option" aria-selected={false} className="alert-item" onClick={() => { onPick(s); setQ(''); }}>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="alert-item__title" style={{ display: 'block' }}>{s.fullName}</span>
                  <span className="alert-item__meta" style={{ display: 'block' }}>{s.grade}{s.section} · {s.admissionNo} · {s.campusName}</span>
                </span>
                <Icon name="chevronRight" size={15} className="t-faint" />
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function SourceChip({ title, meta, icon = 'fileText', onClick }: { title: string; meta: ReactNode; icon?: string; onClick?: () => void }) {
  const body = (
    <>
      <Icon name={icon} size={16} className="t-muted" />
      <span className="col grow"><span className="t-sm t-bold">{title}</span><span className="t-micro t-muted">{meta}</span></span>
    </>
  );
  return onClick
    ? <button type="button" className="card card--tint row g-3" style={{ padding: '10px 12px', textAlign: 'left' }} onClick={onClick}>{body}<Icon name="external" size={14} className="t-faint" /></button>
    : <div className="card card--tint row g-3" style={{ padding: '10px 12px' }}>{body}</div>;
}

export const updatedLabel = (d: string | null | undefined) => (d ? fmt.date(d) : '—');

export function RefreshButton({ onClick, loading }: { onClick: () => void; loading?: boolean }) {
  return <Button icon="refresh" onClick={onClick} loading={loading} aria-label="Refresh" />;
}
