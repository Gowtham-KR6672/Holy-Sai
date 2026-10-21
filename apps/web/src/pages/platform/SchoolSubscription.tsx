import { useState } from 'react';
import { ApiError, api } from '@/api/client';
import { Badge, Button, Card, DataTable, Dl, InlineError, Modal, QueryState, SelectField, TextArea, TextField } from '@/components/ui';
import { useApiMutation, useApiQuery } from '@/hooks/useApi';
import { fmt, todayKey } from '@/lib/format';
import { money, type SubscriptionStatusView } from '../core/SubscriptionPage';
import { GATEWAY_LABEL, METHOD_LABEL, PAYMENT_STATUS } from './PaymentsPage';

interface Summary {
  currency: string;
  status: SubscriptionStatusView;
  plans: { code: string; name: string; months: number; price: number; total: number; taxPercent: number; available: boolean }[];
  periods: { id: string; planCode: string; startsOn: string; endsOn: string; source: string; note: string | null }[];
  payments: { id: string; planCode: string; amount: number; currency: string; gateway: string; method: string | null; status: string; reference: string | null; paidAt: string | null; createdAt: string; invoiceId: string | null }[];
}

export const SUB_STATE: Record<string, { tone: string; label: string }> = {
  none: { tone: 'neutral', label: 'No subscription' },
  active: { tone: 'success', label: 'Active' },
  expiring: { tone: 'warning', label: 'Ending soon' },
  grace: { tone: 'critical', label: 'Grace period' },
  expired: { tone: 'critical', label: 'Ended' },
  suspended: { tone: 'critical', label: 'Suspended' },
};

const METHODS = [
  { value: 'bank', label: 'Bank transfer' },
  { value: 'upi', label: 'UPI' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card (outside We School)' },
  { value: 'other', label: 'Other' },
];

/** A school's subscription in the console: status, record a payment, extend, start a trial or plan, history. */
export default function SchoolSubscription({ schoolId, schoolName }: { schoolId: string; schoolName: string }) {
  const q = useApiQuery<Summary>(`/platform/workspaces/${schoolId}/subscription`);
  const [open, setOpen] = useState<'pay' | 'extend' | 'start' | null>(null);
  return (
    <QueryState query={q}>
      {(d) => {
        const s = d.status;
        const st = SUB_STATE[s.status] ?? SUB_STATE.none;
        return (
          <Card
            title="Subscription"
            icon="creditCard"
            sub={`Billed in ${d.currency}`}
            actions={
              <>
                {s.status === 'none' && <Button size="sm" icon="play" onClick={() => setOpen('start')}>Start trial or plan</Button>}
                <Button size="sm" icon="calendar" onClick={() => setOpen('extend')} disabled={s.status === 'none'}>Extend</Button>
                <Button size="sm" variant="primary" icon="plus" onClick={() => setOpen('pay')}>Record payment</Button>
              </>
            }
          >
            <Dl items={[
              ['Status', <Badge key="s" tone={st.tone}>{st.label}</Badge>],
              ['Plan', d.plans.find((p) => p.code === s.planCode)?.name ?? s.planCode ?? '—'],
              ['Runs until', s.endsOn ? `${fmt.date(s.endsOn)}${s.daysLeft !== null ? (s.daysLeft >= 0 ? ` (${s.daysLeft} days left)` : ` (ended ${-s.daysLeft} days ago)`) : ''}` : '—'],
              ['Grace until', s.graceEndsOn ? fmt.date(s.graceEndsOn) : '—'],
            ]} />
            <div className="mt-4">
              <DataTable
                rows={d.payments}
                rowKey={(p) => p.id}
                compact
                emptyText="No payments yet."
                columns={[
                  { key: 'date', label: 'Date', render: (p) => <span className="t-xs">{fmt.date(p.paidAt ?? p.createdAt)}</span> },
                  { key: 'amount', label: 'Amount', className: 'num', render: (p) => money(p.currency, p.amount) },
                  { key: 'via', label: 'Via', render: (p) => <>{GATEWAY_LABEL[p.gateway] ?? p.gateway}{p.method ? <span className="t-micro t-muted"> · {METHOD_LABEL[p.method] ?? p.method}</span> : null}</> },
                  { key: 'reference', label: 'Reference', render: (p) => <span className="t-micro">{p.reference ?? '—'}</span> },
                  { key: 'status', label: 'Status', render: (p) => <Badge tone={p.status === 'paid' ? 'success' : p.status === 'failed' ? 'critical' : 'info'}>{PAYMENT_STATUS[p.status] ?? p.status}</Badge> },
                  { key: 'invoice', label: '', render: (p) => (p.invoiceId ? <Button size="sm" icon="download" onClick={() => api.download(`/platform/invoices/${p.invoiceId}/pdf`, 'invoice.pdf')}>Invoice</Button> : null) },
                ]}
              />
            </div>
            <RecordPayment open={open === 'pay'} onClose={() => setOpen(null)} schoolId={schoolId} schoolName={schoolName} d={d} />
            <Extend open={open === 'extend'} onClose={() => setOpen(null)} schoolId={schoolId} endsOn={s.endsOn} />
            <Start open={open === 'start'} onClose={() => setOpen(null)} schoolId={schoolId} d={d} />
          </Card>
        );
      }}
    </QueryState>
  );
}

function RecordPayment({ open, onClose, schoolId, schoolName, d }: { open: boolean; onClose: () => void; schoolId: string; schoolName: string; d: Summary }) {
  const first = d.plans.find((p) => p.code === 'annual') ?? d.plans[0];
  const [f, setF] = useState({ planCode: first?.code ?? 'annual', amount: first ? String(first.total) : '', method: 'bank', reference: '', paidOn: todayKey(), note: '' });
  const save = useApiMutation<typeof f>('post', `/platform/workspaces/${schoolId}/payments`, {
    invalidate: ['/platform'],
    error: false,
    body: (v) => ({ planCode: v.planCode, amount: Number(v.amount), method: v.method, reference: v.reference || undefined, paidOn: v.paidOn, note: v.note || undefined }),
    onSuccess: onClose,
  });
  const err = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Modal open={open} onClose={onClose} busy={save.isPending} title="Record payment" sub={`A payment ${schoolName} made outside We School. The subscription is extended by the plan and an invoice is created.`}
      foot={<><Button onClick={onClose} disabled={save.isPending}>Cancel</Button><Button variant="primary" icon="check" loading={save.isPending} onClick={() => save.mutate(f)}>Record payment</Button></>}>
      {save.error && !Object.keys(err).length && <div className="mb-4"><InlineError error={save.error} /></div>}
      <div className="form-grid">
        <SelectField label="Plan" required value={f.planCode} onChange={(v) => { const p = d.plans.find((x) => x.code === v); setF((x) => ({ ...x, planCode: v, amount: p ? String(p.total) : x.amount })); }}
          options={d.plans.map((p) => ({ value: p.code, label: `${p.name} (${p.months} month${p.months === 1 ? '' : 's'})` }))} error={err.planCode} />
        <TextField label={`Amount received (${d.currency})`} type="number" min={0} step="0.01" required value={f.amount} onChange={(v) => setF((x) => ({ ...x, amount: v }))} error={err.amount} hint="Including tax" />
        <SelectField label="Method" value={f.method} onChange={(v) => setF((x) => ({ ...x, method: v }))} options={METHODS} />
        <TextField label="Reference" value={f.reference} onChange={(v) => setF((x) => ({ ...x, reference: v }))} placeholder="UTR / cheque number" error={err.reference} />
        <TextField label="Received on" type="date" value={f.paidOn} onChange={(v) => setF((x) => ({ ...x, paidOn: v }))} />
        <TextArea className="span-2" label="Note" rows={2} value={f.note} onChange={(v) => setF((x) => ({ ...x, note: v }))} />
      </div>
    </Modal>
  );
}

function Extend({ open, onClose, schoolId, endsOn }: { open: boolean; onClose: () => void; schoolId: string; endsOn: string | null }) {
  const [f, setF] = useState({ endsOn: '', reason: '' });
  const save = useApiMutation<typeof f>('post', `/platform/workspaces/${schoolId}/subscription/extend`, { invalidate: ['/platform'], error: false, onSuccess: onClose });
  const err = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Modal open={open} onClose={onClose} busy={save.isPending} title="Extend subscription" sub={`Without a payment — e.g. a goodwill extension or an agreed delay. Currently runs until ${endsOn ? fmt.date(endsOn) : '—'}.`}
      foot={<><Button onClick={onClose} disabled={save.isPending}>Cancel</Button><Button variant="primary" icon="check" loading={save.isPending} onClick={() => save.mutate(f)}>Extend</Button></>}>
      {save.error && !Object.keys(err).length && <div className="mb-4"><InlineError error={save.error} /></div>}
      <div className="form-grid">
        <TextField label="New end date" type="date" required value={f.endsOn} onChange={(v) => setF((x) => ({ ...x, endsOn: v }))} error={err.endsOn} />
        <TextArea className="span-2" label="Reason" required rows={2} value={f.reason} onChange={(v) => setF((x) => ({ ...x, reason: v }))} error={err.reason} />
      </div>
    </Modal>
  );
}

function Start({ open, onClose, schoolId, d }: { open: boolean; onClose: () => void; schoolId: string; d: Summary }) {
  const [f, setF] = useState({ planCode: 'annual', startsOn: todayKey(), kind: 'trial', trialDays: '30' });
  const save = useApiMutation<typeof f>('post', `/platform/workspaces/${schoolId}/subscription/start`, {
    invalidate: ['/platform'],
    error: false,
    body: (v) => ({ planCode: v.planCode, startsOn: v.startsOn, trialDays: v.kind === 'trial' ? Number(v.trialDays) : undefined }),
    onSuccess: onClose,
  });
  const err = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Modal open={open} onClose={onClose} busy={save.isPending} title="Start subscription" sub="A trial, or a first plan period without a payment (record the payment separately when it arrives)."
      foot={<><Button onClick={onClose} disabled={save.isPending}>Cancel</Button><Button variant="primary" icon="check" loading={save.isPending} onClick={() => save.mutate(f)}>Start</Button></>}>
      {save.error && !Object.keys(err).length && <div className="mb-4"><InlineError error={save.error} /></div>}
      <div className="form-grid">
        <SelectField label="Start with" value={f.kind} onChange={(v) => setF((x) => ({ ...x, kind: v }))} options={[{ value: 'trial', label: 'A free trial' }, { value: 'plan', label: 'A plan period' }]} />
        <SelectField label="Plan" value={f.planCode} onChange={(v) => setF((x) => ({ ...x, planCode: v }))} options={d.plans.map((p) => ({ value: p.code, label: p.name }))} />
        <TextField label="Starts on" type="date" value={f.startsOn} onChange={(v) => setF((x) => ({ ...x, startsOn: v }))} />
        {f.kind === 'trial' && <TextField label="Trial days" type="number" min={1} max={366} value={f.trialDays} onChange={(v) => setF((x) => ({ ...x, trialDays: v }))} error={err.trialDays} />}
      </div>
    </Modal>
  );
}
