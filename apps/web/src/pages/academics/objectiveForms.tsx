import { useEffect, useMemo, useState } from 'react';
import { useApiMutation } from '@/hooks/useApi';
import { useLookups } from '@/hooks/useLookups';
import { Banner, Button, InlineError, Modal, SelectField, TextArea, TextField } from '@/components/ui';
import { serverFieldErrors } from './shared';

export interface ObjectiveRow { id: string; code: string; text: string; subjectId: string; subject: string; stage: string; coverage: number; mastery: number; lessonPlans: number }

const INVALIDATE = ['/academics/objectives', '/academics/curriculum', '/academics/subjects'];

/** Create (no `objective`) or edit an objective. */
export function ObjectiveModal({ objective, onClose }: { objective?: ObjectiveRow; onClose: () => void }) {
  const { lookups } = useLookups();
  const editing = !!objective;
  const [f, setF] = useState({
    code: objective?.code ?? '', description: objective?.text ?? '', subjectId: objective?.subjectId ?? '',
    stageLabel: objective?.stage ?? '', coveragePct: String(objective?.coverage ?? 0), masteryPct: String(objective?.mastery ?? 0),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof f) => (v: string) => { setF((x) => ({ ...x, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); };
  const save = useApiMutation<Record<string, unknown>>(editing ? 'put' : 'post', editing ? `/academics/objectives/${objective!.id}` : '/academics/objectives', {
    invalidate: INVALIDATE, success: editing ? 'Objective updated' : 'Objective added', onSuccess: onClose, error: false,
  });
  useEffect(() => { if (save.error) setErrors(serverFieldErrors(save.error)); }, [save.error]);

  const submit = () => {
    const e: Record<string, string> = {};
    const cov = Number(f.coveragePct);
    const mas = Number(f.masteryPct);
    if (!editing && !/^[A-Za-z0-9.\-]{2,20}$/.test(f.code.trim())) e.code = 'Use 2–20 letters, numbers, dots or dashes (e.g. 5Nf.09)';
    if (f.description.trim().length < 3) e.description = 'Describe the objective';
    if (!editing && !f.subjectId) e.subjectId = 'Choose a subject';
    if (!f.stageLabel.trim()) e.stageLabel = 'Enter the stage (e.g. Primary 5)';
    if (!Number.isInteger(cov) || cov < 0 || cov > 100) e.coveragePct = '0–100';
    if (!Number.isInteger(mas) || mas < 0 || mas > 100) e.masteryPct = '0–100';
    else if (mas > cov) e.masteryPct = 'Mastery cannot exceed coverage';
    setErrors(e);
    if (Object.keys(e).length) return;
    save.mutate(editing
      ? { description: f.description.trim(), stageLabel: f.stageLabel.trim(), coveragePct: cov, masteryPct: mas }
      : { code: f.code.trim(), description: f.description.trim(), subjectId: f.subjectId, stageLabel: f.stageLabel.trim(), coveragePct: cov, masteryPct: mas });
  };

  return (
    <Modal open onClose={onClose} busy={save.isPending} title={editing ? `Edit objective ${objective!.code}` : 'Map a curriculum objective'}
      sub={editing ? `${objective!.subject} · ${objective!.stage}` : 'Adds a Cambridge objective so it can be planned, taught and tracked.'}
      foot={<><Button onClick={onClose} disabled={save.isPending}>Cancel</Button><Button variant="primary" onClick={submit} loading={save.isPending}>{editing ? 'Save changes' : 'Add objective'}</Button></>}>
      {save.error && !Object.keys(serverFieldErrors(save.error)).length && <div className="mb-3"><InlineError error={save.error} /></div>}
      <div className="grid g-2col g-3">
        {!editing && <TextField label="Objective code" required value={f.code} onChange={set('code')} error={errors.code} placeholder="5Nf.09" maxLength={20} />}
        {!editing && (
          <SelectField label="Subject" required value={f.subjectId} onChange={set('subjectId')} placeholder="Choose a subject" error={errors.subjectId}
            options={(lookups?.subjects ?? []).map((s) => ({ value: s.id, label: s.name }))} />
        )}
        <TextField label="Stage" required value={f.stageLabel} onChange={set('stageLabel')} error={errors.stageLabel} placeholder="Primary 5" maxLength={40} />
        <div className="grid g-2col g-3">
          <TextField label="Coverage %" type="number" min={0} max={100} value={f.coveragePct} onChange={set('coveragePct')} error={errors.coveragePct} />
          <TextField label="Mastery %" type="number" min={0} max={100} value={f.masteryPct} onChange={set('masteryPct')} error={errors.masteryPct} />
        </div>
      </div>
      <div className="mt-3">
        <TextArea label="Objective" required rows={3} value={f.description} onChange={set('description')} error={errors.description} maxLength={300} />
      </div>
    </Modal>
  );
}

interface ParsedRow { code: string; description: string; subjectId: string; stageLabel: string; coveragePct: number; masteryPct: number }

/** Paste-in import: one objective per line — code, description, subject code, stage, coverage, mastery. */
export function ImportObjectivesModal({ onClose }: { onClose: () => void }) {
  const { lookups } = useLookups();
  const [text, setText] = useState('');
  const bySubject = useMemo(() => new Map((lookups?.subjects ?? []).flatMap((s) => [[s.code.toUpperCase(), s.id], [s.name.toUpperCase(), s.id]])), [lookups]);
  const parsed = useMemo(() => {
    const rows: ParsedRow[] = [];
    const errors: string[] = [];
    text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
      const parts = line.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((p) => p.trim().replace(/^"|"$/g, ''));
      const [code, description, subject, stage, cov = '0', mas = '0'] = parts;
      const subjectId = bySubject.get((subject ?? '').toUpperCase());
      const c = Number(cov), m = Number(mas);
      if (!code || !/^[A-Za-z0-9.\-]{2,20}$/.test(code)) errors.push(`Line ${i + 1}: invalid code "${code ?? ''}"`);
      else if (!description) errors.push(`Line ${i + 1}: description is missing`);
      else if (!subjectId) errors.push(`Line ${i + 1}: unknown subject "${subject ?? ''}"`);
      else if (!stage) errors.push(`Line ${i + 1}: stage is missing`);
      else if (!Number.isInteger(c) || !Number.isInteger(m) || c < 0 || c > 100 || m < 0 || m > c) errors.push(`Line ${i + 1}: coverage/mastery must be 0–100 and mastery ≤ coverage`);
      else rows.push({ code, description, subjectId, stageLabel: stage, coveragePct: c, masteryPct: m });
    });
    return { rows, errors };
  }, [text, bySubject]);
  const imp = useApiMutation<{ rows: ParsedRow[] }, { imported: number }>('post', '/academics/objectives/import', {
    invalidate: INVALIDATE, success: (r) => `${r.data.imported} objectives imported`, onSuccess: onClose, error: false,
  });
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;

  return (
    <Modal open onClose={onClose} busy={imp.isPending} size="wide" title="Import objectives"
      sub="Paste one objective per line. Columns: code, description, subject code, stage, coverage %, mastery %."
      foot={<><Button onClick={onClose} disabled={imp.isPending}>Cancel</Button>
        <Button variant="primary" icon="upload" onClick={() => imp.mutate({ rows: parsed.rows })} loading={imp.isPending}
          disabled={!parsed.rows.length || parsed.errors.length > 0 || lines > 200}>Import {parsed.rows.length || ''}</Button></>}>
      <TextArea label="Objectives" rows={8} value={text} onChange={setText}
        placeholder={'5Nf.09, Recognise percentages as fractions of 100, MAT, Primary 5, 0, 0\n5Sc.06, Describe how shadows are formed, SCI, Primary 5, 0, 0'} />
      <div className="mt-3 col g-2">
        {imp.error && <InlineError error={imp.error} />}
        {lines > 200 && <Banner tone="critical" icon="alert">Import at most 200 objectives at a time.</Banner>}
        {parsed.errors.length > 0 && <Banner tone="warning" icon="alert">{parsed.errors.slice(0, 5).join(' · ')}{parsed.errors.length > 5 ? ` · and ${parsed.errors.length - 5} more` : ''}</Banner>}
        {parsed.rows.length > 0 && parsed.errors.length === 0 && <Banner tone="success" icon="check">{parsed.rows.length} objectives ready to import. The import is all-or-nothing: a duplicate code cancels it.</Banner>}
      </div>
    </Modal>
  );
}
