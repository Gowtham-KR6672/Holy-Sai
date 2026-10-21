import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, api } from '@/api/client';
import { Badge, Banner, Button, Card, DataTable, Dl, Grid, InlineError, Kpi, Modal, PageHead, QueryState, TextArea, TextField, useConfirm, useToast } from '@/components/ui';
import { useApiMutation, useApiQuery, useInvalidate, usePagedQuery } from '@/hooks/useApi';
import { fmt } from '@/lib/format';
import SchoolSubscription from './SchoolSubscription';
import { SchoolStatus, TemporaryPassword } from './shared';

interface SchoolAdmin {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  status: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
}

interface School {
  id: string;
  code: string;
  name: string;
  status: string;
  currency: string;
  country: string;
  timezone: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  taxId: string | null;
  notes: string | null;
  schemaVersion: string | null;
  suspendedAt: string | null;
  suspendReason: string | null;
  createdAt: string;
  addresses: { api: string };
  usage: { campuses: number; students: number; staff: number; users: number } | null;
  admins: SchoolAdmin[];
}

interface AuditRow {
  id: string;
  at: string;
  admin: string | null;
  description: string;
}

/** One school: profile, usage, its Workspace Admins, support access, suspension, deletion and activity. */
export default function SchoolPage() {
  const { id = '' } = useParams();
  const q = useApiQuery<School>(`/platform/workspaces/${id}`);
  return <QueryState query={q}>{(s) => <SchoolView s={s} />}</QueryState>;
}

function SchoolView({ s }: { s: School }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [edit, setEdit] = useState(false);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [secret, setSecret] = useState<{ title: string; email: string; password: string } | null>(null);
  const activity = usePagedQuery<AuditRow>('/platform/audit', { workspaceId: s.id, pageSize: 10 });

  const openSchool = async () => {
    // Open the tab now (pop-up blockers allow it on the click), then point it at the support link.
    const tab = window.open('', '_blank');
    try {
      const r = await api.post<{ path: string }>(`/platform/workspaces/${s.id}/support`);
      if (tab) {
        tab.opener = null;
        tab.location.href = r.data.path;
      } else {
        window.location.href = r.data.path;
      }
    } catch (err) {
      tab?.close();
      toast(err instanceof ApiError ? err.message : 'Could not open the school', 'critical');
    }
  };

  const resume = useApiMutation('post', `/platform/workspaces/${s.id}/resume`, { invalidate: ['/platform'] });
  const resetPassword = useApiMutation<SchoolAdmin, { email: string; temporaryPassword: string }>('post', (a) => `/platform/workspaces/${s.id}/admins/${a.id}/reset-password`, {
    invalidate: [`/platform/workspaces/${s.id}`],
    success: false,
    onSuccess: (r) => setSecret({ title: 'New temporary password', email: r.data.email, password: r.data.temporaryPassword }),
  });

  return (
    <>
      <PageHead
        title={s.name}
        sub={<span className="row g-2" style={{ display: 'inline-flex' }}><SchoolStatus status={s.status} /><span>{s.code} · billed in {s.currency}</span></span>}
        crumbs={[{ label: 'Schools', to: '/platform/schools' }, { label: s.name }]}
        actions={
          <>
            {(s.status === 'active' || s.status === 'suspended') && <Button variant="primary" icon="external" onClick={openSchool}>Open school (support)</Button>}
            <Button icon="edit" onClick={() => setEdit(true)}>Edit</Button>
            {s.status === 'active' && <Button variant="danger" icon="pause" onClick={() => setSuspendOpen(true)}>Suspend</Button>}
            {s.status === 'suspended' && (
              <Button icon="play" loading={resume.isPending} onClick={async () => { if (await confirm({ title: `Resume ${s.name}?`, body: 'Its users can sign in again.', confirmLabel: 'Resume' })) resume.mutate(undefined); }}>
                Resume
              </Button>
            )}
            {s.status !== 'provisioning' && <Button variant="danger" icon="trash" onClick={() => setDeleteOpen(true)}>Delete</Button>}
          </>
        }
      />

      {s.status === 'suspended' && <div className="mb-4"><Banner tone="critical" icon="pause">Suspended {s.suspendedAt ? fmt.date(s.suspendedAt) : ''}{s.suspendReason ? ` — ${s.suspendReason}` : ''}. Nobody in this school can sign in; you can still open it for support.</Banner></div>}
      {s.status === 'failed' && <div className="mb-4"><Banner tone="warning" icon="alert">Setting up this school did not finish: {s.notes}. Create it again with the same code to finish.</Banner></div>}

      {s.usage && (
        <div className="wsc__kpis">
          <Kpi label="Campuses" value={s.usage.campuses} icon="building" />
          <Kpi label="Students" value={fmt.n(s.usage.students)} icon="users" />
          <Kpi label="Staff" value={fmt.n(s.usage.staff)} icon="idCard" />
          <Kpi label="Sign-in accounts" value={fmt.n(s.usage.users)} icon="user" />
        </div>
      )}

      {(s.status === 'active' || s.status === 'suspended') && <div className="mb-4"><SchoolSubscription schoolId={s.id} schoolName={s.name} /></div>}

      <Grid cols="g-2col">
        <Card title="Profile" icon="building">
          <Dl items={[
            ['Name', s.name],
            ['Code', s.code],
            ['Country / time zone', `${s.country} · ${s.timezone}`],
            ['Billing currency', s.currency],
            ['Billing contact', [s.contactName, s.contactEmail, s.contactPhone].filter(Boolean).join(' · ') || '—'],
            ['Address', s.address || '—'],
            ['Tax ID', s.taxId || '—'],
            ['Created', fmt.date(s.createdAt)],
            ['Notes', s.notes || '—'],
          ]} />
        </Card>
        <Card title="School address for webhooks" icon="link" sub="Payment, WhatsApp, smart-gate and biometric providers post to this school's own address.">
          <Dl items={[
            ['API base', <code key="a">{window.location.origin}{s.addresses.api}</code>],
            ['Example', <code key="b">{window.location.origin}{s.addresses.api}/whatsapp/webhook</code>],
            ['Database version', s.schemaVersion ?? '—'],
          ]} />
        </Card>
      </Grid>

      <Card
        title="Workspace Admins"
        icon="shield"
        sub="Run the whole school (all campuses) and can add campus admins."
        flush
        actions={<Button icon="plus" onClick={() => setAdminOpen(true)} disabled={!s.usage}>Add admin</Button>}
      >
        <DataTable
          rows={s.admins}
          rowKey={(a) => a.id}
          emptyText="This school has no admin of its own — add one."
          columns={[
            { key: 'fullName', label: 'Admin', render: (a) => <><span className="t-bold">{a.fullName}</span><div className="t-micro t-muted">{a.email}{a.phone ? ` · ${a.phone}` : ''}</div></> },
            { key: 'status', label: 'Status', render: (a) => <>{a.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">{a.status}</Badge>}{a.mustChangePassword && <Badge tone="warning">Temporary password</Badge>}</> },
            { key: 'lastLoginAt', label: 'Last sign-in', render: (a) => (a.lastLoginAt ? fmt.relative(a.lastLoginAt) : <span className="t-faint">Never</span>) },
            {
              key: 'actions', label: '', render: (a) => (
                <Button size="sm" icon="key" loading={resetPassword.isPending && resetPassword.variables?.id === a.id}
                  onClick={async (e) => { e.stopPropagation(); if (await confirm({ title: `Reset ${a.fullName}'s password?`, body: 'They are signed out everywhere and must choose a new password at the next sign-in.', confirmLabel: 'Reset password' })) resetPassword.mutate(a); }}>
                  Reset password
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Recent activity" icon="list" flush>
        <DataTable
          rows={activity.data?.rows}
          loading={activity.isLoading}
          rowKey={(r) => r.id}
          emptyText="Nothing yet."
          columns={[
            { key: 'at', label: 'When', render: (r) => <span className="t-xs t-muted">{fmt.dateTime(r.at)}</span>, width: '180px' },
            { key: 'admin', label: 'By', render: (r) => r.admin ?? '—' },
            { key: 'description', label: 'What happened' },
          ]}
        />
      </Card>

      <EditSchool s={s} open={edit} onClose={() => setEdit(false)} />
      <SuspendSchool s={s} open={suspendOpen} onClose={() => setSuspendOpen(false)} />
      <DeleteSchool s={s} open={deleteOpen} onClose={() => setDeleteOpen(false)} onSuspendFirst={() => { setDeleteOpen(false); setSuspendOpen(true); }} />
      <AddAdmin s={s} open={adminOpen} onClose={() => setAdminOpen(false)} onCreated={(email, password) => setSecret({ title: 'Workspace Admin added', email, password })} />
      {secret && <TemporaryPassword open onClose={() => setSecret(null)} title={secret.title} email={secret.email} password={secret.password} />}
    </>
  );
}

function EditSchool({ s, open, onClose }: { s: School; open: boolean; onClose: () => void }) {
  const init = () => ({ name: s.name, country: s.country, timezone: s.timezone, contactName: s.contactName ?? '', contactEmail: s.contactEmail ?? '', contactPhone: s.contactPhone ?? '', address: s.address ?? '', taxId: s.taxId ?? '', notes: s.notes ?? '' });
  const [f, setF] = useState(init);
  const save = useApiMutation<typeof f>('patch', `/platform/workspaces/${s.id}`, { invalidate: ['/platform'], error: false, onSuccess: onClose });
  const err = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const set = (k: keyof ReturnType<typeof init>) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal open={open} onClose={onClose} size="wide" busy={save.isPending} title={`Edit ${s.name}`}
      foot={<><Button onClick={onClose} disabled={save.isPending}>Cancel</Button><Button variant="primary" icon="check" loading={save.isPending} onClick={() => save.mutate(f)}>Save</Button></>}>
      {save.error && !Object.keys(err).length && <div className="mb-4"><InlineError error={save.error} /></div>}
      <div className="form-grid">
        <TextField className="span-2" label="School name" required value={f.name} onChange={set('name')} error={err.name} hint="Also changes the name the school sees in its own pages" />
        <TextField label="Country" value={f.country} onChange={set('country')} error={err.country} />
        <TextField label="Time zone" value={f.timezone} onChange={set('timezone')} error={err.timezone} />
        <TextField label="Billing contact" value={f.contactName} onChange={set('contactName')} error={err.contactName} />
        <TextField label="Contact email" value={f.contactEmail} onChange={set('contactEmail')} error={err.contactEmail} />
        <TextField label="Contact mobile" value={f.contactPhone} onChange={set('contactPhone')} error={err.contactPhone} />
        <TextField label="Tax ID (GSTIN / VAT)" value={f.taxId} onChange={set('taxId')} error={err.taxId} />
        <TextArea className="span-2" label="Address" rows={2} value={f.address} onChange={set('address')} error={err.address} />
        <TextArea className="span-2" label="Notes" rows={2} value={f.notes} onChange={set('notes')} error={err.notes} />
      </div>
    </Modal>
  );
}

function SuspendSchool({ s, open, onClose }: { s: School; open: boolean; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const save = useApiMutation<{ reason: string }>('post', `/platform/workspaces/${s.id}/suspend`, { invalidate: ['/platform'], onSuccess: () => { setReason(''); onClose(); } });
  return (
    <Modal open={open} onClose={onClose} busy={save.isPending} title={`Suspend ${s.name}?`} sub="Nobody in the school can sign in until you resume it. Its data is kept, and you can still open it for support."
      foot={<><Button onClick={onClose} disabled={save.isPending}>Cancel</Button><Button variant="danger" icon="pause" loading={save.isPending} disabled={reason.trim().length < 3} onClick={() => save.mutate({ reason })}>Suspend school</Button></>}>
      <TextArea label="Reason" required rows={3} value={reason} onChange={setReason} placeholder="e.g. Subscription unpaid since 1 Nov" />
    </Modal>
  );
}

/** Deleting is final, so only a suspended school (or a failed set-up) can be deleted, and the code must be typed. */
function DeleteSchool({ s, open, onClose, onSuspendFirst }: { s: School; open: boolean; onClose: () => void; onSuspendFirst: () => void }) {
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [typed, setTyped] = useState('');
  const close = () => { setTyped(''); onClose(); };
  const save = useApiMutation<{ code: string }>('post', `/platform/workspaces/${s.id}/delete`, {
    error: false,
    // Leave the page first: refreshing it now would ask for a school that no longer exists.
    onSuccess: () => { close(); navigate('/platform/schools', { replace: true }); void invalidate('/platform'); },
  });
  const err = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const canDelete = s.status === 'suspended' || s.status === 'failed';

  if (!canDelete) {
    return (
      <Modal open={open} onClose={close} title={`Delete ${s.name}?`}
        foot={<><Button onClick={close}>Cancel</Button><Button variant="danger" icon="pause" onClick={onSuspendFirst}>Suspend first</Button></>}>
        <Banner tone="warning" icon="pause">Only a suspended school can be deleted. Suspend it first: its users stop signing in, and you can still resume it if you change your mind.</Banner>
      </Modal>
    );
  }
  return (
    <Modal open={open} onClose={close} busy={save.isPending} title={`Delete ${s.name}?`}
      foot={<><Button onClick={close} disabled={save.isPending}>Cancel</Button><Button variant="danger" icon="trash" loading={save.isPending} disabled={typed.trim().toLowerCase() !== s.code} onClick={() => save.mutate({ code: typed })}>Delete school</Button></>}>
      <div className="col g-3">
        <Banner tone="critical" icon="alert">This permanently deletes the school and everything in it: campuses, students, staff, fees, attendance, sign-in accounts, uploaded files and its audit trail. It cannot be undone.</Banner>
        <p className="t-sm t-muted">{`Its payments and invoices stay in the console for your accounts. Its emails, mobile numbers and the code ${s.code} can be used again for another school.`}</p>
        {save.error && !Object.keys(err).length && <InlineError error={save.error} />}
        <TextField label={`Type ${s.code} to confirm`} required value={typed} onChange={setTyped} error={err.code} autoComplete="off" />
      </div>
    </Modal>
  );
}

function AddAdmin({ s, open, onClose, onCreated }: { s: School; open: boolean; onClose: () => void; onCreated: (email: string, password: string) => void }) {
  const [f, setF] = useState({ fullName: '', email: '', phone: '' });
  const save = useApiMutation<typeof f, { email: string; temporaryPassword: string }>('post', `/platform/workspaces/${s.id}/admins`, {
    invalidate: [`/platform/workspaces/${s.id}`],
    error: false,
    success: false,
    body: (v) => ({ fullName: v.fullName, email: v.email, phone: v.phone || undefined }),
    onSuccess: (r) => { setF({ fullName: '', email: '', phone: '' }); onClose(); onCreated(r.data.email, r.data.temporaryPassword); },
  });
  const err = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Modal open={open} onClose={onClose} busy={save.isPending} title="Add Workspace Admin" sub={`A new admin for ${s.name}, with a temporary password.`}
      foot={<><Button onClick={onClose} disabled={save.isPending}>Cancel</Button><Button variant="primary" icon="check" loading={save.isPending} onClick={() => save.mutate(f)}>Add admin</Button></>}>
      {save.error && !Object.keys(err).length && <div className="mb-4"><InlineError error={save.error} /></div>}
      <div className="form-grid">
        <TextField className="span-2" label="Full name" required value={f.fullName} onChange={(v) => setF((x) => ({ ...x, fullName: v }))} error={err.fullName} />
        <TextField label="Email (sign-in)" type="email" required value={f.email} onChange={(v) => setF((x) => ({ ...x, email: v }))} error={err.email} />
        <TextField label="Mobile" value={f.phone} onChange={(v) => setF((x) => ({ ...x, phone: v }))} error={err.phone} />
      </div>
    </Modal>
  );
}
