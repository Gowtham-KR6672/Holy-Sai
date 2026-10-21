import { Card, DataTable, Kpi, PageHead, QueryState } from '@/components/ui';
import { useApiQuery } from '@/hooks/useApi';
import { fmt } from '@/lib/format';
import { Badge } from '@/components/ui';
import { useNavigate } from 'react-router-dom';
import { money } from '../core/SubscriptionPage';
import { SUB_STATE } from './SchoolSubscription';

interface Overview {
  schools: { total: number; active: number; suspended: number; failed: number };
  subscriptions: { active: number; expiring: number; grace: number; expired: number; none: number };
  revenueThisMonth: { currency: string; amount: number }[];
  attention: { id: string; code: string; name: string; status: string; endsOn: string | null; daysLeft: number | null }[];
  recent: { id: string; at: string; admin: string | null; action: string; description: string }[];
}

/** The console's first page: schools at a glance and the latest platform activity. */
export default function OverviewPage() {
  const q = useApiQuery<Overview>('/platform/overview');
  const navigate = useNavigate();
  return (
    <>
      <PageHead title="We School" sub="All schools on the platform" crumbs={false} />
      <QueryState query={q}>
        {(d) => (
          <>
            <div className="wsc__kpis">
              <Kpi label="Schools" value={d.schools.total} icon="building" to="/platform/schools" />
              <Kpi label="Active" value={d.schools.active} icon="check" tone="teal" />
              <Kpi label="Suspended" value={d.schools.suspended} icon="pause" tone={d.schools.suspended ? 'critical' : undefined} />
              {d.schools.failed > 0 && <Kpi label="Set-up failed" value={d.schools.failed} icon="alert" tone="critical" to="/platform/schools" />}
              <Kpi label="Ending soon" value={d.subscriptions.expiring} icon="calendar" tone={d.subscriptions.expiring ? 'amber' : undefined} />
              <Kpi label="Grace / ended" value={d.subscriptions.grace + d.subscriptions.expired} icon="lock" tone={d.subscriptions.grace + d.subscriptions.expired ? 'critical' : undefined} />
              <Kpi label="Paid this month" value={d.revenueThisMonth.length ? d.revenueThisMonth.map((r) => money(r.currency, r.amount)).join(' · ') : '—'} icon="wallet" to="/platform/payments" />
            </div>
            {d.attention.length > 0 && (
              <div className="mb-4">
                <Card title="Needs attention" icon="alert" flush>
                  <DataTable
                    rows={d.attention}
                    rowKey={(r) => r.id}
                    onRowClick={(r) => navigate(`/platform/schools/${r.code}`)}
                    columns={[
                      { key: 'name', label: 'School', render: (r) => <span className="t-bold">{r.name}</span> },
                      { key: 'status', label: 'Subscription', render: (r) => <Badge tone={SUB_STATE[r.status]?.tone ?? 'neutral'}>{SUB_STATE[r.status]?.label ?? r.status}</Badge> },
                      { key: 'endsOn', label: 'Ends', render: (r) => (r.endsOn ? `${fmt.date(r.endsOn)}${r.daysLeft !== null ? (r.daysLeft >= 0 ? ` · ${r.daysLeft} days left` : ` · ${-r.daysLeft} days ago`) : ''}` : '—') },
                    ]}
                  />
                </Card>
              </div>
            )}
            <Card title="Recent activity" icon="list" flush>
              <DataTable
                rows={d.recent}
                rowKey={(r) => r.id}
                emptyText="Nothing yet."
                columns={[
                  { key: 'at', label: 'When', render: (r) => <span className="t-xs t-muted">{fmt.dateTime(r.at)}</span>, width: '180px' },
                  { key: 'admin', label: 'By', render: (r) => r.admin ?? '—' },
                  { key: 'description', label: 'What happened' },
                ]}
              />
            </Card>
          </>
        )}
      </QueryState>
    </>
  );
}
