import { useState } from 'react';
import { ApiError } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';
import { Badge, Button, Card, DataTable, InlineError, Modal, PageHead, TextField, useConfirm } from '@/components/ui';
import { useApiMutation, useApiQuery } from '@/hooks/useApi';
import { fmt } from '@/lib/format';
import { TemporaryPassword } from './shared';

interface Admin {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  status: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
}

/** We School's own administrators: they create schools and can open any school for support. */
export default function AdminsPage() {
  const { admin: me } = useAuth();
  const confirm = useConfirm();
  const list = useApiQuery<Admin[]>('/platform/admins');
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ fullName: '', email: '', phone: '' });
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const create = useApiMutation<typeof f, { email: string; temporaryPassword: string }>('post', '/platform/admins', {
    invalidate: ['/platform/admins'],
    error: false,
    success: false,
    body: (v) => ({ fullName: v.fullName, email: v.email, phone: v.phone || undefined }),
    onSuccess: (r) => { setOpen(false); setF({ fullName: '', email: '', phone: '' }); setSecret({ email: r.data.email, password: r.data.temporaryPassword }); },
  });
  const setStatus = useApiMutation<{ id: string; status: 'active' | 'disabled' }>('patch', (v) => `/platform/admins/${v.id}`, { invalidate: ['/platform/admins'], body: (v) => ({ status: v.status }) });
  const err = create.error instanceof ApiError ? create.error.fieldErrors : {};

  return (
    <>
      <PageHead title="Platform admins" sub="People who run We School: they create schools and can open any school for support" crumbs={false}
        actions={<Button variant="primary" icon="plus" onClick={() => { create.reset(); setOpen(true); }}>Add platform admin</Button>} />
      <Card flush>
        <DataTable
          rows={list.data}
          loading={list.isLoading}
          rowKey={(a) => a.id}
          columns={[
            { key: 'fullName', label: 'Admin', render: (a) => <><span className="t-bold">{a.fullName}</span>{a.id === me?.id && <span className="t-micro t-muted"> (you)</span>}<div className="t-micro t-muted">{a.email}</div></> },
            { key: 'status', label: 'Status', render: (a) => <>{a.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Disabled</Badge>}{a.mustChangePassword && <Badge tone="warning">Temporary password</Badge>}</> },
            { key: 'lastLoginAt', label: 'Last sign-in', render: (a) => (a.lastLoginAt ? fmt.relative(a.lastLoginAt) : <span className="t-faint">Never</span>) },
            {
              key: 'actions', label: '', render: (a) => a.id === me?.id ? null : a.status === 'active' ? (
                <Button size="sm" variant="danger" onClick={async () => { if (await confirm({ title: `Disable ${a.fullName}?`, body: 'They are signed out and cannot sign in until enabled again.', confirmLabel: 'Disable', danger: true })) setStatus.mutate({ id: a.id, status: 'disabled' }); }}>Disable</Button>
              ) : (
                <Button size="sm" onClick={() => setStatus.mutate({ id: a.id, status: 'active' })}>Enable</Button>
              ),
            },
          ]}
        />
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} busy={create.isPending} title="Add platform admin" sub="They get a temporary password to change at the first sign-in."
        foot={<><Button onClick={() => setOpen(false)} disabled={create.isPending}>Cancel</Button><Button variant="primary" icon="check" loading={create.isPending} onClick={() => create.mutate(f)}>Add admin</Button></>}>
        {create.error && !Object.keys(err).length && <div className="mb-4"><InlineError error={create.error} /></div>}
        <div className="form-grid">
          <TextField className="span-2" label="Full name" required value={f.fullName} onChange={(v) => setF((x) => ({ ...x, fullName: v }))} error={err.fullName} />
          <TextField label="Email (sign-in)" type="email" required value={f.email} onChange={(v) => setF((x) => ({ ...x, email: v }))} error={err.email} />
          <TextField label="Mobile" value={f.phone} onChange={(v) => setF((x) => ({ ...x, phone: v }))} error={err.phone} />
        </div>
      </Modal>
      {secret && <TemporaryPassword open onClose={() => setSecret(null)} title="Platform admin added" email={secret.email} password={secret.password} />}
    </>
  );
}
