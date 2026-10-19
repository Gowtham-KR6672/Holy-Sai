import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/hooks/useApi';
import { useLookups } from '@/hooks/useLookups';
import {
  Badge, Banner, Button, Card, DataTable, Empty, ErrorState, Grid, Icon, InlineError, Modal, Page, PageHead, PageSkeleton,
  SelectField, Switch, Tabs, TextField, useConfirm,
} from '@/components/ui';
import { fmt } from '@/lib/format';

/**
 * School setup (new in the rebuild): the school starts with no demo data, so the Super Admin creates
 * campuses, academic years, classes and sections, subjects and houses here.
 */

interface CheckItem { key: string; label: string; done: boolean; count: number; to: string }
interface CampusRow {
  id: string; code: string; name: string; shortName: string; place: string; curriculum: string; address: string | null;
  establishedYear: number | null; staffingTarget: number; latitude: number | null; longitude: number | null; radiusM: number;
  isActive: boolean; students: number; classes: number;
}
interface YearRow { id: string; label: string; startsOn: string; endsOn: string; isCurrent: boolean; status: string }
interface SectionRow { id: string; name: string; room: string | null; capacity: number; classTeacherId: string | null; classTeacher: string | null; students: number }
interface ClassRow { id: string; campusId: string; name: string; gradeLevel: number; stage: string | null; sections: SectionRow[] }
interface SubjectRow { id: string; code: string; name: string; stageScope: string; isElective: boolean; isActive: boolean }
interface HouseRow { id: string; name: string; color: string | null }
interface Setup { checklist: CheckItem[]; campuses: CampusRow[]; years: YearRow[]; classes: ClassRow[]; subjects: SubjectRow[]; houses: HouseRow[] }

type Tab = 'overview' | 'campuses' | 'years' | 'classes' | 'subjects' | 'houses';

const errorsOf = (e: unknown) => (e instanceof ApiError ? e.fieldErrors : {});
const STAGES = ['Cambridge Primary', 'Cambridge Lower Secondary', 'Cambridge IGCSE', 'Cambridge AS Level', 'Cambridge A Level', 'Early Years', 'Experiential / Residential'];

export default function SchoolSetupPage() {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'overview';
  const q = useApiQuery<Setup>('/setup');
  const setTab = (t: Tab) => setSp(t === 'overview' ? {} : { tab: t }, { replace: true });

  if (q.isLoading) return <Page><PageSkeleton /></Page>;
  if (q.error || !q.data) return <Page><PageHead title="School setup" /><ErrorState error={q.error} onRetry={() => q.refetch()} /></Page>;
  const d = q.data;
  const done = d.checklist.filter((c) => c.done).length;

  return (
    <Page>
      <PageHead
        title="School setup"
        sub="Campuses, academic years, classes, subjects and houses. The school starts empty — set these up first, then add staff and students."
      />
      <div className="tabsbar">
        <Tabs<Tab>
          items={[
            { id: 'overview', label: 'Overview' },
            { id: 'campuses', label: 'Campuses', count: d.campuses.length },
            { id: 'years', label: 'Academic years', count: d.years.length },
            { id: 'classes', label: 'Classes & sections', count: d.classes.length },
            { id: 'subjects', label: 'Subjects', count: d.subjects.length },
            { id: 'houses', label: 'Houses', count: d.houses.length },
          ]}
          active={tab}
          onChange={setTab}
        />
      </div>
      <div className="mt-4">
        {tab === 'overview' && (
          <Card icon="checkSquare" title="Setup checklist" sub={`${done} of ${d.checklist.length} complete`}>
            {done < d.checklist.length && (
              <div className="mb-4">
                <Banner tone="warning" icon="info">Complete the steps in order. Most screens show empty states until campuses, the academic year and classes exist.</Banner>
              </div>
            )}
            <div className="col g-2">
              {d.checklist.map((c, i) => (
                <div key={c.key} className="optioncard" style={{ cursor: 'default' }}>
                  <span className={`avatar ${c.done ? 'avatar--teal' : ''}`}><Icon name={c.done ? 'check' : 'clock'} size={17} /></span>
                  <span className="col grow">
                    <span className="t-sm t-bold">{i + 1}. {c.label}</span>
                    <span className="t-xs t-muted">{c.done ? `${c.count} recorded` : 'Not set up yet'}</span>
                  </span>
                  {c.done ? <Badge tone="success">Done</Badge> : <Badge tone="warning">To do</Badge>}
                  <Button size="sm" iconRight="chevronRight" to={c.to}>Open</Button>
                </div>
              ))}
            </div>
          </Card>
        )}
        {tab === 'campuses' && <Campuses rows={d.campuses} />}
        {tab === 'years' && <Years rows={d.years} />}
        {tab === 'classes' && <Classes rows={d.classes} campuses={d.campuses} />}
        {tab === 'subjects' && <Subjects rows={d.subjects} />}
        {tab === 'houses' && <Houses rows={d.houses} />}
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Campuses
// ---------------------------------------------------------------------------
const EMPTY_CAMPUS = { code: '', name: '', shortName: '', place: '', curriculum: '', address: '', establishedYear: '', staffingTarget: '', latitude: '', longitude: '', radiusM: '250', isActive: true };

function Campuses({ rows }: { rows: CampusRow[] }) {
  const [edit, setEdit] = useState<CampusRow | 'new' | null>(null);
  const [f, setF] = useState(EMPTY_CAMPUS);
  const open = (r: CampusRow | 'new') => {
    setEdit(r);
    setF(r === 'new' ? EMPTY_CAMPUS : {
      code: r.code, name: r.name, shortName: r.shortName, place: r.place, curriculum: r.curriculum, address: r.address ?? '',
      establishedYear: r.establishedYear ? String(r.establishedYear) : '', staffingTarget: String(r.staffingTarget || ''),
      latitude: r.latitude != null ? String(r.latitude) : '', longitude: r.longitude != null ? String(r.longitude) : '', radiusM: String(r.radiusM), isActive: r.isActive,
    });
    save.reset();
  };
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
  const save = useApiMutation<typeof f>(edit && edit !== 'new' ? 'put' : 'post', edit && edit !== 'new' ? `/setup/campuses/${edit.id}` : '/setup/campuses', {
    invalidate: ['/setup', '/lookups'], error: false,
    body: (v) => ({
      code: v.code.trim().toLowerCase(), name: v.name, shortName: v.shortName || undefined, place: v.place, curriculum: v.curriculum || undefined,
      address: v.address || undefined, establishedYear: num(v.establishedYear), staffingTarget: num(v.staffingTarget),
      latitude: num(v.latitude), longitude: num(v.longitude), radiusM: num(v.radiusM), isActive: v.isActive,
    }),
    onSuccess: () => setEdit(null),
  });
  const err = errorsOf(save.error);
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  return (
    <>
      <Card icon="building" title="Campuses" sub="Each campus has its own classes, staff and students. The header's campus selector lists these."
        actions={<Button variant="primary" icon="plus" onClick={() => open('new')}>Add campus</Button>} flush>
        {rows.length === 0 ? (
          <Empty icon="building" title="No campuses yet" sub="Add the first campus to begin." action={<Button variant="primary" icon="plus" onClick={() => open('new')}>Add campus</Button>} />
        ) : (
          <DataTable rows={rows} rowKey={(r) => r.id} onRowClick={open}
            columns={[
              { key: 'name', label: 'Campus', render: (r) => <><span className="t-bold">{r.name}</span><div className="t-micro t-muted">{r.code} · {r.place}{r.establishedYear ? ` · since ${r.establishedYear}` : ''}</div></> },
              { key: 'curriculum', label: 'Curriculum', render: (r) => r.curriculum || <span className="t-faint">—</span> },
              { key: 'classes', label: 'Classes', className: 'num', render: (r) => r.classes },
              { key: 'students', label: 'Students', className: 'num', render: (r) => fmt.n(r.students) },
              { key: 'geo', label: 'Geofence', render: (r) => (r.latitude != null ? <span className="t-xs">{r.latitude.toFixed(4)}, {r.longitude?.toFixed(4)} · {r.radiusM} m</span> : <span className="t-faint t-xs">Not set</span>) },
              { key: 'status', label: 'Status', render: (r) => <Badge tone={r.isActive ? 'success' : 'neutral'}>{r.isActive ? 'Active' : 'Inactive'}</Badge> },
            ]} />
        )}
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} size="wide" busy={save.isPending}
        title={edit === 'new' ? 'Add campus' : `Edit ${edit?.name ?? ''}`}
        sub="The campus code is used in references and settings (2–8 lowercase letters or digits, e.g. gdv)."
        foot={<><Button onClick={() => setEdit(null)} disabled={save.isPending}>Cancel</Button><Button variant="primary" icon="check" loading={save.isPending} onClick={() => save.mutate(f)}>Save campus</Button></>}>
        {save.error && !Object.keys(err).length && <div className="mb-4"><InlineError error={save.error} /></div>}
        <div className="formsection">
          <div className="formsection__title">Identity</div>
          <div className="form-grid">
            <TextField label="Campus name" required value={f.name} onChange={set('name')} error={err.name} placeholder="Holy Sai International" />
            <TextField label="Short name" value={f.shortName} onChange={set('shortName')} hint="Shown where space is tight" />
            <TextField label="Code" required value={f.code} onChange={set('code')} error={err.code} placeholder="gdv" />
            <TextField label="Place" required value={f.place} onChange={set('place')} error={err.place} placeholder="Guduvanchery" />
            <TextField label="Curriculum" value={f.curriculum} onChange={set('curriculum')} placeholder="Cambridge Primary → A Level" />
            <TextField label="Established (year)" type="number" value={f.establishedYear} onChange={set('establishedYear')} error={err.establishedYear} />
            <TextField className="span-2" label="Address" value={f.address} onChange={set('address')} />
          </div>
        </div>
        <div className="formsection">
          <div className="formsection__title">Staffing and tracking</div>
          <div className="form-grid">
            <TextField label="Approved staff positions" type="number" min={0} value={f.staffingTarget} onChange={set('staffingTarget')} />
            <TextField label="Geofence radius (metres)" type="number" min={50} value={f.radiusM} onChange={set('radiusM')} error={err.radiusM} hint="Used to show a student as “At school”" />
            <TextField label="Latitude" type="number" step="any" value={f.latitude} onChange={set('latitude')} placeholder="12.8213" />
            <TextField label="Longitude" type="number" step="any" value={f.longitude} onChange={set('longitude')} placeholder="80.0436" />
            {edit !== 'new' && <div className="field span-2"><Switch checked={f.isActive} onChange={set('isActive')} label="Campus is active" /></div>}
          </div>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Academic years
// ---------------------------------------------------------------------------
function Years({ rows }: { rows: YearRow[] }) {
  const confirm = useConfirm();
  const [edit, setEdit] = useState<YearRow | 'new' | null>(null);
  const [f, setF] = useState({ label: '', startsOn: '', endsOn: '' });
  const open = (r: YearRow | 'new') => {
    setEdit(r);
    setF(r === 'new' ? { label: '', startsOn: '', endsOn: '' } : { label: r.label, startsOn: r.startsOn, endsOn: r.endsOn });
    save.reset();
  };
  const save = useApiMutation<typeof f>(edit && edit !== 'new' ? 'put' : 'post', edit && edit !== 'new' ? `/setup/academic-years/${edit.id}` : '/setup/academic-years', {
    invalidate: ['/setup', '/lookups'], error: false, onSuccess: () => setEdit(null),
  });
  const current = useApiMutation<string>('post', (id) => `/setup/academic-years/${id}/make-current`, { invalidate: ['/setup', '/lookups'] });
  const err = errorsOf(save.error);
  return (
    <>
      <Card icon="calendar" title="Academic years" sub="One year is current (live data). Making another year current archives the previous one — it becomes read-only."
        actions={<Button variant="primary" icon="plus" onClick={() => open('new')}>Add year</Button>} flush>
        {rows.length === 0 ? (
          <Empty icon="calendar" title="No academic year yet" sub="Add the current academic year, e.g. 2026–27 from 1 June to 30 April." action={<Button variant="primary" icon="plus" onClick={() => open('new')}>Add year</Button>} />
        ) : (
          <DataTable rows={rows} rowKey={(r) => r.id}
            columns={[
              { key: 'label', label: 'Year', render: (r) => <span className="t-bold">{r.label}</span> },
              { key: 'dates', label: 'Dates', render: (r) => `${fmt.date(r.startsOn)} – ${fmt.date(r.endsOn)}` },
              { key: 'status', label: 'Status', render: (r) => <Badge tone={r.isCurrent ? 'success' : r.status === 'archived' ? 'neutral' : 'info'}>{r.isCurrent ? 'Current' : r.status === 'archived' ? 'Archived' : 'Planned'}</Badge> },
              { key: 'actions', label: '', className: 'num', render: (r) => (
                <div className="row g-2 end">
                  {r.status !== 'archived' && <Button size="sm" icon="edit" onClick={() => open(r)}>Edit</Button>}
                  {!r.isCurrent && r.status !== 'archived' && (
                    <Button size="sm" variant="teal" loading={current.isPending && current.variables === r.id} onClick={async () => {
                      if (await confirm({ title: `Make ${r.label} the current year?`, body: 'The current year will be archived and become read-only. This cannot be undone.', confirmLabel: 'Make current' })) current.mutate(r.id);
                    }}>Make current</Button>
                  )}
                </div>
              ) },
            ]} />
        )}
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} busy={save.isPending} title={edit === 'new' ? 'Add academic year' : 'Edit academic year'}
        foot={<><Button onClick={() => setEdit(null)} disabled={save.isPending}>Cancel</Button><Button variant="primary" icon="check" loading={save.isPending} onClick={() => save.mutate(f)}>Save year</Button></>}>
        {save.error && !Object.keys(err).length && <div className="mb-4"><InlineError error={save.error} /></div>}
        <div className="col g-3">
          <TextField label="Label" required value={f.label} onChange={(v) => setF({ ...f, label: v })} error={err.label} placeholder="2026–27" />
          <div className="grid g-2col g-3">
            <TextField label="Starts on" type="date" required value={f.startsOn} onChange={(v) => setF({ ...f, startsOn: v })} error={err.startsOn} />
            <TextField label="Ends on" type="date" required value={f.endsOn} onChange={(v) => setF({ ...f, endsOn: v })} error={err.endsOn} />
          </div>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Classes and sections
// ---------------------------------------------------------------------------
function Classes({ rows, campuses }: { rows: ClassRow[]; campuses: CampusRow[] }) {
  const confirm = useConfirm();
  const { lookups } = useLookups();
  const [campusId, setCampusId] = useState(campuses[0]?.id ?? '');
  const [cls, setCls] = useState<ClassRow | 'new' | null>(null);
  const [cf, setCf] = useState({ name: '', gradeLevel: '', stage: '', sections: 'A, B' });
  const [sec, setSec] = useState<ClassRow | null>(null);
  const [sf, setSf] = useState({ name: '', room: '', capacity: '40', classTeacherId: '' });
  const list = rows.filter((r) => !campusId || r.campusId === campusId);
  const staff = (lookups?.staff ?? []).filter((s) => s.employeeType === 'teaching' && (!campusId || s.campusId === campusId));

  const saveClass = useApiMutation<typeof cf>(cls && cls !== 'new' ? 'put' : 'post', cls && cls !== 'new' ? `/setup/classes/${cls.id}` : '/setup/classes', {
    invalidate: ['/setup', '/lookups'], error: false,
    body: (v) => ({ campusId, name: v.name.trim(), gradeLevel: Number(v.gradeLevel), stage: v.stage || undefined, sections: cls === 'new' ? v.sections.split(',').map((s) => s.trim()).filter(Boolean) : undefined }),
    onSuccess: () => setCls(null),
  });
  const delClass = useApiMutation<string>('delete', (id) => `/setup/classes/${id}`, { invalidate: ['/setup', '/lookups'] });
  const saveSection = useApiMutation<typeof sf>('post', '/setup/sections', {
    invalidate: ['/setup', '/lookups'], error: false,
    body: (v) => ({ classId: sec?.id, name: v.name.trim(), room: v.room || undefined, capacity: Number(v.capacity) || undefined, classTeacherId: v.classTeacherId || undefined }),
    onSuccess: () => setSec(null),
  });
  const delSection = useApiMutation<string>('delete', (id) => `/setup/sections/${id}`, { invalidate: ['/setup', '/lookups'] });
  const ce = errorsOf(saveClass.error);
  const se = errorsOf(saveSection.error);

  if (!campuses.length) return <Card><Empty icon="building" title="Add a campus first" sub="Classes belong to a campus." action={<Button to="/admin/setup?tab=campuses">Open campuses</Button>} /></Card>;

  return (
    <>
      <Card icon="grid" title="Classes and sections" sub="Section names are letters (A, B, C…). Class teachers and rooms can also be set on the Classes page."
        actions={<>
          <select className="select" aria-label="Campus" value={campusId} onChange={(e) => setCampusId(e.target.value)} style={{ width: 'auto' }}>
            {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Button variant="primary" icon="plus" onClick={() => { setCls('new'); setCf({ name: '', gradeLevel: '', stage: '', sections: 'A, B' }); saveClass.reset(); }}>Add class</Button>
        </>} flush>
        {list.length === 0 ? (
          <Empty icon="grid" title="No classes on this campus" sub="Add classes such as Grade 1 … Grade 12, each with its sections." />
        ) : (
          <DataTable rows={list} rowKey={(r) => r.id}
            columns={[
              { key: 'name', label: 'Class', render: (r) => <><span className="t-bold">{r.name}</span><div className="t-micro t-muted">Grade level {r.gradeLevel}{r.stage ? ` · ${r.stage}` : ''}</div></> },
              { key: 'sections', label: 'Sections', render: (r) => (
                <div className="row g-1 wrap">
                  {r.sections.map((s) => (
                    <span key={s.id} className="tag" title={`${s.classTeacher ?? 'No class teacher'} · room ${s.room ?? '—'} · ${s.students} students`}>
                      {r.name.replace(/^Grade\s*/i, '')}{s.name} · {s.students}
                      {s.students === 0 && (
                        <button type="button" className="t-micro" style={{ marginLeft: 4, color: 'var(--critical)' }} aria-label={`Delete section ${s.name}`}
                          onClick={async () => { if (await confirm({ title: `Delete section ${r.name}${s.name}?`, body: 'Only empty sections can be deleted.', confirmLabel: 'Delete', danger: true })) delSection.mutate(s.id); }}>×</button>
                      )}
                    </span>
                  ))}
                  {!r.sections.length && <span className="t-faint t-xs">No sections</span>}
                </div>
              ) },
              { key: 'students', label: 'Students', className: 'num', render: (r) => r.sections.reduce((n, s) => n + s.students, 0) },
              { key: 'actions', label: '', className: 'num', render: (r) => (
                <div className="row g-2 end wrap">
                  <Button size="sm" icon="plus" onClick={() => { setSec(r); setSf({ name: '', room: '', capacity: '40', classTeacherId: '' }); saveSection.reset(); }}>Section</Button>
                  <Button size="sm" icon="edit" onClick={() => { setCls(r); setCf({ name: r.name, gradeLevel: String(r.gradeLevel), stage: r.stage ?? '', sections: '' }); saveClass.reset(); }}>Edit</Button>
                  {r.sections.every((s) => s.students === 0) && (
                    <Button size="sm" variant="danger" icon="trash" onClick={async () => { if (await confirm({ title: `Delete ${r.name}?`, body: 'The class and its empty sections are removed.', confirmLabel: 'Delete', danger: true })) delClass.mutate(r.id); }} aria-label={`Delete ${r.name}`} />
                  )}
                </div>
              ) },
            ]} />
        )}
      </Card>
      <Modal open={!!cls} onClose={() => setCls(null)} busy={saveClass.isPending} title={cls === 'new' ? 'Add class' : 'Edit class'}
        foot={<><Button onClick={() => setCls(null)} disabled={saveClass.isPending}>Cancel</Button><Button variant="primary" icon="check" loading={saveClass.isPending} onClick={() => saveClass.mutate(cf)}>Save class</Button></>}>
        {saveClass.error && !Object.keys(ce).length && <div className="mb-4"><InlineError error={saveClass.error} /></div>}
        <div className="col g-3">
          <div className="grid g-2col g-3">
            <TextField label="Class name" required value={cf.name} onChange={(v) => setCf({ ...cf, name: v })} error={ce.name} placeholder="Grade 5" />
            <TextField label="Grade level" required type="number" min={-3} max={14} value={cf.gradeLevel} onChange={(v) => setCf({ ...cf, gradeLevel: v })} error={ce.gradeLevel} hint="Used for sorting; 0 = KG" />
          </div>
          <SelectField label="Curriculum stage" value={cf.stage} onChange={(v) => setCf({ ...cf, stage: v })} placeholder="Not set" options={STAGES} />
          {cls === 'new' && <TextField label="Sections" value={cf.sections} onChange={(v) => setCf({ ...cf, sections: v })} hint="Comma separated, e.g. A, B, C" />}
        </div>
      </Modal>
      <Modal open={!!sec} onClose={() => setSec(null)} busy={saveSection.isPending} title={`Add section to ${sec?.name ?? ''}`}
        foot={<><Button onClick={() => setSec(null)} disabled={saveSection.isPending}>Cancel</Button><Button variant="primary" icon="check" loading={saveSection.isPending} onClick={() => saveSection.mutate(sf)}>Add section</Button></>}>
        {saveSection.error && !Object.keys(se).length && <div className="mb-4"><InlineError error={saveSection.error} /></div>}
        <div className="grid g-2col g-3">
          <TextField label="Section" required value={sf.name} onChange={(v) => setSf({ ...sf, name: v })} error={se.name} placeholder="C" />
          <TextField label="Room" value={sf.room} onChange={(v) => setSf({ ...sf, room: v })} placeholder="R-204" />
          <TextField label="Capacity" type="number" min={1} value={sf.capacity} onChange={(v) => setSf({ ...sf, capacity: v })} />
          <SelectField label="Class teacher" value={sf.classTeacherId} onChange={(v) => setSf({ ...sf, classTeacherId: v })} placeholder="Not assigned"
            options={staff.map((s) => ({ value: s.id, label: s.fullName }))} />
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------
function Subjects({ rows }: { rows: SubjectRow[] }) {
  const [edit, setEdit] = useState<SubjectRow | 'new' | null>(null);
  const [f, setF] = useState({ code: '', name: '', stageScope: 'All', isElective: false, isActive: true });
  const open = (r: SubjectRow | 'new') => {
    setEdit(r);
    setF(r === 'new' ? { code: '', name: '', stageScope: 'All', isElective: false, isActive: true } : { code: r.code, name: r.name, stageScope: r.stageScope, isElective: r.isElective, isActive: r.isActive });
    save.reset();
  };
  const save = useApiMutation<typeof f>(edit && edit !== 'new' ? 'put' : 'post', edit && edit !== 'new' ? `/setup/subjects/${edit.id}` : '/setup/subjects', {
    invalidate: ['/setup', '/lookups'], error: false, body: (v) => ({ ...v, code: v.code.trim().toUpperCase() }), onSuccess: () => setEdit(null),
  });
  const err = errorsOf(save.error);
  return (
    <>
      <Card icon="book" title="Subjects" sub="Used by the timetable, assessments, homework, report cards and objectives."
        actions={<Button variant="primary" icon="plus" onClick={() => open('new')}>Add subject</Button>} flush>
        {rows.length === 0 ? (
          <Empty icon="book" title="No subjects yet" sub="Add subjects such as English (ENG), Mathematics (MAT) and Science (SCI)." />
        ) : (
          <DataTable rows={rows} rowKey={(r) => r.id} onRowClick={open}
            columns={[
              { key: 'name', label: 'Subject', render: (r) => <><span className="t-bold">{r.name}</span>{r.isElective && <span className="t-micro t-muted"> · Elective</span>}</> },
              { key: 'code', label: 'Code', render: (r) => <span className="t-mono">{r.code}</span> },
              { key: 'stage', label: 'Stages', render: (r) => r.stageScope },
              { key: 'status', label: 'Status', render: (r) => <Badge tone={r.isActive ? 'success' : 'neutral'}>{r.isActive ? 'Active' : 'Inactive'}</Badge> },
            ]} />
        )}
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} busy={save.isPending} title={edit === 'new' ? 'Add subject' : 'Edit subject'}
        foot={<><Button onClick={() => setEdit(null)} disabled={save.isPending}>Cancel</Button><Button variant="primary" icon="check" loading={save.isPending} onClick={() => save.mutate(f)}>Save subject</Button></>}>
        {save.error && !Object.keys(err).length && <div className="mb-4"><InlineError error={save.error} /></div>}
        <div className="col g-3">
          <div className="grid g-2col g-3">
            <TextField label="Subject name" required value={f.name} onChange={(v) => setF({ ...f, name: v })} error={err.name} placeholder="Mathematics" />
            <TextField label="Code" required value={f.code} onChange={(v) => setF({ ...f, code: v })} error={err.code} placeholder="MAT" />
          </div>
          <TextField label="Taught at" value={f.stageScope} onChange={(v) => setF({ ...f, stageScope: v })} hint="e.g. All, IGCSE, Primary & Lower Secondary" />
          <Switch checked={f.isElective} onChange={(v) => setF({ ...f, isElective: v })} label="Elective" />
          {edit !== 'new' && <Switch checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} label="Active" />}
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Houses
// ---------------------------------------------------------------------------
function Houses({ rows }: { rows: HouseRow[] }) {
  const confirm = useConfirm();
  const [f, setF] = useState({ name: '', color: '#E8A93A' });
  const add = useApiMutation<typeof f>('post', '/setup/houses', { invalidate: ['/setup', '/lookups'], error: false, onSuccess: () => setF({ name: '', color: '#E8A93A' }) });
  const del = useApiMutation<string>('delete', (id) => `/setup/houses/${id}`, { invalidate: ['/setup', '/lookups'] });
  const err = errorsOf(add.error);
  return (
    <Grid cols="g-main">
      <Card icon="star" title="Houses" sub="Students can be placed in a house; used in lists, filters and competitions." flush>
        {rows.length === 0 ? <Empty icon="star" title="No houses yet" sub="Houses are optional." /> : (
          <DataTable rows={rows} rowKey={(r) => r.id}
            columns={[
              { key: 'name', label: 'House', render: (r) => <span className="row g-2"><span style={{ width: 14, height: 14, borderRadius: 4, background: r.color ?? 'var(--border-strong)', display: 'inline-block' }} /><span className="t-bold">{r.name}</span></span> },
              { key: 'actions', label: '', className: 'num', render: (r) => <Button size="sm" variant="danger" icon="trash" aria-label={`Remove ${r.name}`} onClick={async () => { if (await confirm({ title: `Remove ${r.name} house?`, body: 'Only houses without students can be removed.', confirmLabel: 'Remove', danger: true })) del.mutate(r.id); }} /> },
            ]} />
        )}
      </Card>
      <Card icon="plus" title="Add a house">
        <form className="col g-3" onSubmit={(e) => { e.preventDefault(); add.mutate(f); }} noValidate>
          {add.error && !Object.keys(err).length && <InlineError error={add.error} />}
          <TextField label="Name" required value={f.name} onChange={(v) => setF({ ...f, name: v })} error={err.name} placeholder="Sapphire" />
          <TextField label="Colour" type="color" value={f.color} onChange={(v) => setF({ ...f, color: v.toUpperCase() })} error={err.color} />
          <div><Button variant="primary" type="submit" icon="plus" loading={add.isPending}>Add house</Button></div>
        </form>
      </Card>
    </Grid>
  );
}
