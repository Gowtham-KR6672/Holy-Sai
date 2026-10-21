import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { Button, Card, DataTable, Empty, InlineError, Modal, PageHead, SearchInput, SelectField, TextField } from '@/components/ui';
import { useApiMutation, useApiQuery } from '@/hooks/useApi';
import { fmt } from '@/lib/format';
import { SUB_STATE } from './SchoolSubscription';
import { SchoolStatus, TemporaryPassword, type SchoolRow } from './shared';
import { Badge } from '@/components/ui';

const EMPTY = {
  name: '', code: '', currency: 'INR', country: 'India', timezone: 'Asia/Kolkata',
  contactName: '', contactEmail: '', contactPhone: '',
  adminName: '', adminEmail: '', adminPhone: '',
  subKind: 'trial', planCode: 'annual', startsOn: new Date().toISOString().slice(0, 10), trialDays: '30', amount: '', method: 'bank', reference: '',
};

/** "Holy Sai International School" → "holysai" (editable). */
const suggestCode = (name: string) => {
  const words = name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).filter((w) => !['the', 'of', 'and', 'school', 'international', 'public', 'academy', 'college'].includes(w));
  return (words.slice(0, 2).join('') || 'school').replace(/^[^a-z]+/, '').slice(0, 20);
};

interface Created {
  workspace: { id: string; code: string; name: string };
  admin: { email: string; temporaryPassword: string };
}

/** Every school on We School, and "Create school". */
export default function SchoolsPage() {
  const navigate = useNavigate();
  const list = useApiQuery<SchoolRow[]>('/platform/workspaces');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(EMPTY);
  const [codeTouched, setCodeTouched] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const set = (k: keyof typeof EMPTY) => (v: string) =>
    setF((x) => ({ ...x, [k]: v, ...(k === 'name' && !codeTouched ? { code: suggestCode(v) } : {}) }));

  const save = useApiMutation<typeof EMPTY, Created>('post', '/platform/workspaces', {
    invalidate: ['/platform'],
    error: false,
    body: (v) => ({
      name: v.name, code: v.code.trim().toLowerCase(), currency: v.currency, country: v.country, timezone: v.timezone,
      contactName: v.contactName || undefined, contactEmail: v.contactEmail || undefined, contactPhone: v.contactPhone || undefined,
      admin: { fullName: v.adminName, email: v.adminEmail, phone: v.adminPhone || undefined },
      subscription: v.subKind === 'none' ? undefined : {
        planCode: v.planCode, startsOn: v.startsOn,
        ...(v.subKind === 'trial' ? { trialDays: Number(v.trialDays) } : {}),
        ...(v.subKind === 'paid' ? { amount: Number(v.amount), method: v.method, reference: v.reference || undefined } : {}),
      },
    }),
    onSuccess: (r) => {
      setOpen(false);
      setF(EMPTY);
      setCodeTouched(false);
      setCreated(r.data);
    },
  });
  const err = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const adminErr = (k: string) => err[`admin.${k}`] ?? err[k];

  const rows = (list.data ?? []).filter((s) => !q || `${s.name} ${s.code} ${s.contactName ?? ''} ${s.contactEmail ?? ''}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <PageHead
        title="Schools"
        sub="Each school has its own workspace, admins and data"
        crumbs={false}
        actions={<Button variant="primary" icon="plus" onClick={() => { save.reset(); setOpen(true); }}>Create school</Button>}
      />
      <Card flush actions={<SearchInput value={q} onSearch={setQ} placeholder="Search schools" />} title={`${rows.length} school${rows.length === 1 ? '' : 's'}`}>
        {list.data && list.data.length === 0 ? (
          <Empty icon="building" title="No schools yet" sub="Create the first school to give it its own workspace and admin login." action={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>Create school</Button>} />
        ) : (
          <DataTable
            rows={rows}
            loading={list.isLoading}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/platform/schools/${r.code}`)}
            columns={[
              { key: 'name', label: 'School', render: (r) => <><span className="t-bold">{r.name}</span><div className="t-micro t-muted">{r.code} · {r.country}</div></> },
              { key: 'status', label: 'Status', render: (r) => <SchoolStatus status={r.status} /> },
              { key: 'subscription', label: 'Subscription', render: (r) => (r.subscription ? <><Badge tone={SUB_STATE[r.subscription.status]?.tone ?? 'neutral'}>{SUB_STATE[r.subscription.status]?.label ?? r.subscription.status}</Badge>{r.subscription.endsOn && <div className="t-micro t-muted">until {fmt.date(r.subscription.endsOn)}</div>}</> : <span className="t-faint">—</span>) },
              { key: 'currency', label: 'Billing', render: (r) => r.currency },
              { key: 'contact', label: 'Contact', render: (r) => (r.contactName || r.contactEmail ? <><span>{r.contactName ?? '—'}</span><div className="t-micro t-muted">{r.contactEmail ?? ''}</div></> : <span className="t-faint">—</span>) },
              { key: 'createdAt', label: 'Created', render: (r) => <span className="t-xs">{fmt.date(r.createdAt)}</span> },
            ]}
          />
        )}
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="wide"
        busy={save.isPending}
        title="Create school"
        sub="The school gets its own workspace and a Workspace Admin login with a temporary password."
        foot={<><Button onClick={() => setOpen(false)} disabled={save.isPending}>Cancel</Button><Button variant="primary" icon="check" loading={save.isPending} onClick={() => save.mutate(f)}>Create school</Button></>}
      >
        {save.error && !Object.keys(err).length && <div className="mb-4"><InlineError error={save.error} /></div>}
        <div className="formsection">
          <div className="formsection__title">School</div>
          <div className="form-grid">
            <TextField className="span-2" label="School name" required value={f.name} onChange={set('name')} error={err.name} placeholder="e.g. Green Valley Public School" />
            <TextField label="Code" required value={f.code} onChange={(v) => { setCodeTouched(true); set('code')(v.toLowerCase()); }} error={err.code} hint="Permanent: used in the school's web addresses. Letters and digits." />
            <SelectField label="Billing currency" required value={f.currency} onChange={set('currency')} options={[{ value: 'INR', label: 'INR — Indian rupee (Razorpay)' }, { value: 'USD', label: 'USD — US dollar (Stripe, PayPal, Razorpay International)' }]} hint="Fixed once the school is created" />
            <TextField label="Country" value={f.country} onChange={set('country')} error={err.country} />
            <TextField label="Time zone" value={f.timezone} onChange={set('timezone')} error={err.timezone} hint="e.g. Asia/Kolkata" />
          </div>
        </div>
        <div className="formsection">
          <div className="formsection__title">Billing contact</div>
          <div className="form-grid">
            <TextField label="Name" value={f.contactName} onChange={set('contactName')} error={err.contactName} />
            <TextField label="Email" type="email" value={f.contactEmail} onChange={set('contactEmail')} error={err.contactEmail} />
            <TextField label="Mobile" value={f.contactPhone} onChange={set('contactPhone')} error={err.contactPhone} />
          </div>
        </div>
        <div className="formsection">
          <div className="formsection__title">Subscription</div>
          <div className="form-grid">
            <SelectField label="Start with" value={f.subKind} onChange={set('subKind')} options={[{ value: 'trial', label: 'A free trial' }, { value: 'paid', label: 'A paid plan (payment received)' }, { value: 'none', label: 'Nothing yet — set it up later' }]} />
            {f.subKind !== 'none' && <SelectField label="Plan" value={f.planCode} onChange={set('planCode')} options={[{ value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }, { value: 'half_yearly', label: 'Half-yearly' }, { value: 'annual', label: 'Annual' }]} />}
            {f.subKind !== 'none' && <TextField label="Starts on" type="date" value={f.startsOn} onChange={set('startsOn')} />}
            {f.subKind === 'trial' && <TextField label="Trial days" type="number" min={1} max={366} value={f.trialDays} onChange={set('trialDays')} error={err['subscription.trialDays']} />}
            {f.subKind === 'paid' && <TextField label={`Amount received (${f.currency})`} type="number" min={0} step="0.01" value={f.amount} onChange={set('amount')} error={err['subscription.amount']} hint="Including tax" />}
            {f.subKind === 'paid' && <SelectField label="Method" value={f.method} onChange={set('method')} options={[{ value: 'bank', label: 'Bank transfer' }, { value: 'upi', label: 'UPI' }, { value: 'cheque', label: 'Cheque' }, { value: 'cash', label: 'Cash' }, { value: 'other', label: 'Other' }]} />}
            {f.subKind === 'paid' && <TextField label="Reference" value={f.reference} onChange={set('reference')} placeholder="UTR / cheque number" />}
          </div>
        </div>
        <div className="formsection">
          <div className="formsection__title">First Workspace Admin</div>
          <div className="form-grid">
            <TextField label="Full name" required value={f.adminName} onChange={set('adminName')} error={adminErr('fullName')} />
            <TextField label="Email (sign-in)" type="email" required value={f.adminEmail} onChange={set('adminEmail')} error={adminErr('email')} />
            <TextField label="Mobile" value={f.adminPhone} onChange={set('adminPhone')} error={adminErr('phone')} />
          </div>
        </div>
      </Modal>

      {created && (
        <TemporaryPassword
          open
          onClose={() => { const code = created.workspace.code; setCreated(null); navigate(`/platform/schools/${code}`); }}
          title={`${created.workspace.name} is ready`}
          email={created.admin.email}
          password={created.admin.temporaryPassword}
          note="The admin signs in on the We School sign-in page with this email, then sets up campuses, classes and staff, and can add campus admins."
        />
      )}
    </>
  );
}
