import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/api/client';
import { Badge, Button, Card, DataTable, FilterSelect, PageHead, Pagination } from '@/components/ui';
import { usePagedQuery } from '@/hooks/useApi';
import { fmt } from '@/lib/format';
import { money } from '../core/SubscriptionPage';

interface Row {
  id: string;
  school: string;
  schoolCode: string | null;
  schoolDeleted?: boolean;
  planCode: string;
  amount: number;
  currency: string;
  gateway: string;
  method: string | null;
  status: string;
  reference: string | null;
  paidAt: string | null;
  createdAt: string;
  invoiceId: string | null;
  failureReason: string | null;
}

const TONE: Record<string, string> = { paid: 'success', initiated: 'info', failed: 'critical', refunded: 'neutral' };
export const GATEWAY_LABEL: Record<string, string> = { manual: 'Recorded', razorpay: 'Razorpay', razorpay_intl: 'Razorpay Intl', stripe: 'Stripe', paypal: 'PayPal' };
export const PAYMENT_STATUS: Record<string, string> = { paid: 'Paid', initiated: 'Started', failed: 'Failed', refunded: 'Refunded' };
/** Payment methods: the ones recorded by hand plus those Razorpay reports for online payments. */
export const METHOD_LABEL: Record<string, string> = {
  bank: 'Bank transfer', upi: 'UPI', cheque: 'Cheque', cash: 'Cash', card: 'Card', other: 'Other', netbanking: 'Net banking', wallet: 'Wallet', emi: 'EMI',
};

/** Every subscription payment across schools. */
export default function PaymentsPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const q = usePagedQuery<Row>('/platform/payments', { page, pageSize: 25, status: status || undefined });
  return (
    <>
      <PageHead title="Payments" sub="Subscription payments from all schools — recorded by hand or paid online" crumbs={false} />
      <Card flush
        actions={<FilterSelect label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[{ value: 'paid', label: 'Paid' }, { value: 'initiated', label: 'Started' }, { value: 'failed', label: 'Failed' }]} />}
        foot={<Pagination meta={q.data?.meta} onPage={setPage} />}>
        <DataTable
          rows={q.data?.rows}
          loading={q.isLoading}
          rowKey={(r) => r.id}
          emptyText="No payments yet."
          onRowClick={(r) => r.schoolCode && navigate(`/platform/schools/${r.schoolCode}`)}
          columns={[
            { key: 'createdAt', label: 'Date', render: (r) => <span className="t-xs">{fmt.dateTime(r.paidAt ?? r.createdAt)}</span>, width: '160px' },
            { key: 'school', label: 'School', render: (r) => <><span className="t-bold">{r.school}</span>{r.schoolDeleted && <div className="t-micro t-muted">Deleted school</div>}</> },
            { key: 'amount', label: 'Amount', className: 'num', render: (r) => money(r.currency, r.amount) },
            { key: 'gateway', label: 'Via', render: (r) => <>{GATEWAY_LABEL[r.gateway] ?? r.gateway}{r.method ? <span className="t-micro t-muted"> · {METHOD_LABEL[r.method] ?? r.method}</span> : null}</> },
            { key: 'reference', label: 'Reference', render: (r) => <span className="t-micro">{r.reference ?? '—'}</span> },
            { key: 'status', label: 'Status', render: (r) => <span title={r.failureReason ?? undefined}><Badge tone={TONE[r.status] ?? 'neutral'}>{PAYMENT_STATUS[r.status] ?? r.status}</Badge></span> },
            { key: 'invoice', label: '', render: (r) => (r.invoiceId ? <Button size="sm" icon="download" onClick={(e) => { e.stopPropagation(); void api.download(`/platform/invoices/${r.invoiceId}/pdf`, 'invoice.pdf'); }}>Invoice</Button> : null) },
          ]}
        />
      </Card>
    </>
  );
}
