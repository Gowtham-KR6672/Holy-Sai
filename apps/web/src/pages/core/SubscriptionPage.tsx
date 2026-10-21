import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, api } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';
import { Badge, Banner, Button, Card, DataTable, Kpi, Page, PageHead, QueryState, useToast } from '@/components/ui';
import { useApiQuery } from '@/hooks/useApi';
import { fmt } from '@/lib/format';
import { openCheckout } from '@/lib/razorpay';
import { useQueryClient } from '@tanstack/react-query';

export interface SubscriptionStatusView {
  status: 'none' | 'active' | 'expiring' | 'grace' | 'expired' | 'suspended';
  planCode: string | null;
  startsOn: string | null;
  endsOn: string | null;
  daysLeft: number | null;
  graceEndsOn: string | null;
  warningDays: number;
  graceDays: number;
}

interface Summary {
  currency: string;
  status: SubscriptionStatusView;
  plans: { code: string; name: string; months: number; price: number; total: number; taxPercent: number; available: boolean }[];
  gateways: { gateway: 'razorpay' | 'razorpay_intl' | 'stripe' | 'paypal'; label: string }[];
  periods: { id: string; planCode: string; startsOn: string; endsOn: string; source: string; note: string | null }[];
  payments: { id: string; planCode: string; amount: number; currency: string; gateway: string; method: string | null; status: string; reference: string | null; paidAt: string | null; createdAt: string; invoiceId: string | null }[];
  invoices: { id: string; number: string; total: number; currency: string; issuedAt: string; periodStart: string; periodEnd: string }[];
}

interface Checkout {
  paymentId: string;
  amount: number;
  currency: string;
  razorpay?: { keyId: string; orderId: string; amount: number; currency: string; name: string; description: string; prefill: { name?: string; email?: string } };
  redirectUrl?: string;
}

const STATE: Record<SubscriptionStatusView['status'], { tone: string; label: string }> = {
  none: { tone: 'neutral', label: 'No subscription' },
  active: { tone: 'success', label: 'Active' },
  expiring: { tone: 'warning', label: 'Ending soon' },
  grace: { tone: 'critical', label: 'Ended — grace period' },
  expired: { tone: 'critical', label: 'Ended' },
  suspended: { tone: 'critical', label: 'Suspended' },
};

export const money = (currency: string, n: number) =>
  `${currency === 'INR' ? '₹' : currency === 'USD' ? '$' : `${currency} `}${n.toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

const SOURCE: Record<string, string> = { manual: 'Payment recorded by We School', trial: 'Trial', adjustment: 'Extension', razorpay: 'Paid online (Razorpay)', razorpay_intl: 'Paid online (Razorpay International)', stripe: 'Paid online (Stripe)', paypal: 'Paid online (PayPal)' };

/** The school's We School subscription: status, renewal (online) and invoices. Workspace Admins only. */
export default function SubscriptionPage() {
  const q = useApiQuery<Summary>('/subscription');
  const qc = useQueryClient();
  const toast = useToast();
  const { refreshUser } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [plan, setPlan] = useState<string>('annual');
  const confirmed = useRef(false);

  const done = async (message: string) => {
    toast(message, 'success', 'check');
    await qc.invalidateQueries({ predicate: (k) => typeof k.queryKey[0] === 'string' && (k.queryKey[0] as string).startsWith('/subscription') });
    await refreshUser().catch(() => undefined);
  };

  // Back from Stripe or PayPal: confirm with the gateway, then clean the address.
  useEffect(() => {
    const gateway = sp.get('gateway');
    const ref = gateway === 'stripe' ? sp.get('session_id') : gateway === 'paypal' ? sp.get('token') : null;
    if (sp.get('cancelled')) {
      toast('Payment cancelled — nothing was charged', 'info');
      setSp({}, { replace: true });
      return;
    }
    if (!gateway || !ref || confirmed.current) return;
    confirmed.current = true;
    setBusy('confirm');
    api.post<{ endsOn: string }>('/subscription/confirm', { gateway, ref })
      .then((r) => done(`Thank you — your subscription runs until ${fmt.date(r.data.endsOn)}`))
      .catch((err) => toast(err instanceof ApiError ? err.message : 'The payment could not be confirmed yet. Refresh in a minute.', 'critical'))
      .finally(() => {
        setBusy(null);
        setSp({}, { replace: true });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pay = async (gateway: Summary['gateways'][number]['gateway']) => {
    setBusy(gateway);
    try {
      const r = await api.post<Checkout>('/subscription/checkout', { planCode: plan, gateway });
      const c = r.data;
      if (c.redirectUrl) {
        window.location.assign(c.redirectUrl);
        return;
      }
      if (c.razorpay) {
        const result = await openCheckout({
          paymentId: c.paymentId, orderId: c.razorpay.orderId, amount: c.amount, amountPaise: c.razorpay.amount, currency: c.razorpay.currency, keyId: c.razorpay.keyId,
          name: c.razorpay.name, description: c.razorpay.description, prefill: { name: c.razorpay.prefill.name ?? null, email: c.razorpay.prefill.email ?? null, contact: null }, notes: {},
        });
        if (!result) {
          toast('Payment cancelled — nothing was charged', 'info');
          return;
        }
        const v = await api.post<{ endsOn: string }>('/subscription/razorpay/verify', { paymentId: c.paymentId, razorpayOrderId: result.orderId, razorpayPaymentId: result.paymentId, razorpaySignature: result.signature });
        await done(`Thank you — your subscription runs until ${fmt.date(v.data.endsOn)}`);
      }
    } catch (err) {
      toast(err instanceof ApiError || err instanceof Error ? err.message : 'The payment did not go through', 'critical');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page>
      <PageHead title="Subscription" sub="Your school's We School plan, renewal and invoices" />
      <QueryState query={q}>
        {(d) => {
          const s = d.status;
          const st = STATE[s.status];
          const chosen = d.plans.find((p) => p.code === plan) ?? d.plans.find((p) => p.available);
          return (
            <>
              {s.status === 'expired' && <div className="mb-4"><Banner tone="critical" icon="lock">The subscription ended on {fmt.date(s.endsOn!)}. Staff, parents and students cannot sign in until it is renewed — everything is kept.</Banner></div>}
              {s.status === 'grace' && <div className="mb-4"><Banner tone="warning" icon="alert">The subscription ended on {fmt.date(s.endsOn!)}. Everyone can still sign in until {fmt.date(s.graceEndsOn!)}. Renew now to avoid an interruption.</Banner></div>}
              {s.status === 'expiring' && <div className="mb-4"><Banner tone="warning" icon="calendar">The subscription ends on {fmt.date(s.endsOn!)} ({s.daysLeft} day{s.daysLeft === 1 ? '' : 's'} left).</Banner></div>}

              <div className="wsc__kpis">
                <Kpi label="Status" value={<Badge tone={st.tone} lg>{st.label}</Badge>} icon="shieldCheck" />
                <Kpi label="Plan" value={d.plans.find((p) => p.code === s.planCode)?.name ?? (s.planCode ? s.planCode : '—')} icon="layers" />
                <Kpi label="Runs until" value={s.endsOn ? fmt.date(s.endsOn) : '—'} icon="calendar" foot={s.daysLeft !== null && s.daysLeft >= 0 ? `${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left` : undefined} />
              </div>

              <Card title="Renew" icon="creditCard" sub="A renewal starts the day after the current end date (or today, if it has passed).">
                {!d.plans.some((p) => p.available) ? (
                  <p className="t-sm t-muted">Online renewal is not open for your school yet. Please contact We School.</p>
                ) : (
                  <div className="col g-4">
                    <div className="row g-3 wrap">
                      {d.plans.filter((p) => p.available).map((p) => (
                        <button key={p.code} type="button" className={`card ${plan === p.code ? 'card--selected' : ''}`} onClick={() => setPlan(p.code)}
                          style={{ padding: 16, minWidth: 180, textAlign: 'left', cursor: 'pointer', outline: plan === p.code ? '2px solid var(--primary)' : undefined }}
                          aria-pressed={plan === p.code}>
                          <div className="t-bold">{p.name}</div>
                          <div className="t-lg t-bold" style={{ marginTop: 6 }}>{money(d.currency, p.total)}</div>
                          <div className="t-micro t-muted">{p.months} month{p.months === 1 ? '' : 's'}{p.taxPercent ? ` · incl. ${p.taxPercent}% tax` : ''}</div>
                        </button>
                      ))}
                    </div>
                    {d.gateways.length === 0 ? (
                      <p className="t-sm t-muted">Online payment is not available right now. Please contact We School to renew.</p>
                    ) : (
                      <div className="row g-2 wrap">
                        {d.gateways.map((g) => (
                          <Button key={g.gateway} variant="primary" icon="creditCard" loading={busy === g.gateway} disabled={!!busy || !chosen?.available} onClick={() => pay(g.gateway)}>
                            Pay {chosen ? money(d.currency, chosen.total) : ''} with {g.label}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </Card>

              <Card title="Invoices" icon="receipt" flush>
                <DataTable
                  rows={d.invoices}
                  rowKey={(i) => i.id}
                  emptyText="No invoices yet."
                  columns={[
                    { key: 'number', label: 'Invoice', render: (i) => <span className="t-bold">{i.number}</span> },
                    { key: 'issuedAt', label: 'Date', render: (i) => fmt.date(i.issuedAt) },
                    { key: 'period', label: 'Period', render: (i) => `${fmt.date(i.periodStart)} – ${fmt.date(i.periodEnd)}` },
                    { key: 'total', label: 'Amount', className: 'num', render: (i) => money(i.currency, i.total) },
                    { key: 'pdf', label: '', render: (i) => <Button size="sm" icon="download" onClick={() => api.download(`/subscription/invoices/${i.id}/pdf`, `${i.number}.pdf`)}>PDF</Button> },
                  ]}
                />
              </Card>

              <Card title="History" icon="clock" flush>
                <DataTable
                  rows={d.periods}
                  rowKey={(p) => p.id}
                  emptyText="No subscription periods yet."
                  columns={[
                    { key: 'period', label: 'Period', render: (p) => `${fmt.date(p.startsOn)} – ${fmt.date(p.endsOn)}` },
                    { key: 'planCode', label: 'Plan', render: (p) => d.plans.find((x) => x.code === p.planCode)?.name ?? p.planCode },
                    { key: 'source', label: 'How', render: (p) => <>{SOURCE[p.source] ?? p.source}{p.note ? <div className="t-micro t-muted">{p.note}</div> : null}</> },
                  ]}
                />
              </Card>
            </>
          );
        }}
      </QueryState>
    </Page>
  );
}
