import { useApiQuery, useRefresh } from '@/api/hooks';
import { useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { Card, Empty, ErrorState, Kpi, KpiGrid, ListItem, Loading, Meter, Screen, StatusBadge, Txt } from '@/components/ui';
import { fmt } from '@/lib/format';
import { useNav } from '@/lib/navigation';
import type { Tone } from '@/theme/theme';

interface FeeDashboard {
  kpis: { billed: number; collected: number; collectionPct: number; collected30d: number; collected30dDelta: number | null; outstanding: number; outstandingAccounts: number; overdue: number; overdueAccounts: number; overdueAll: number; expected: number };
  methods: { label: string; amount: number; pct: number }[];
  trend: { month: string; label: string; billed: number; collected: number }[];
  ageing: { label: string; value: number }[];
  attention: { id: string; fullName: string; admissionNo: string; grade: string | null; section: string | null; campus: string; outstanding: number; overdue: number; ageDays: number; feeStatus: string }[];
  academicYear: string;
}
const AGE_TONES: Tone[] = ['success', 'info', 'warning', 'critical'];

/** Fees overview: GET /finance/fees/summary (collection, outstanding, ageing, method mix, overdue accounts). */
export default function FeesScreen() {
  const user = useUser();
  const { t } = useI18n();
  const { openWeb } = useNav();
  const { refreshing, onRefresh } = useRefresh();
  const q = useApiQuery<FeeDashboard>('/finance/fees/summary', user.campusId ? { campusId: user.campusId } : undefined);
  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (q.error || !q.data) return <Screen onRefresh={onRefresh}><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Screen>;
  const d = q.data;
  const k = d.kpis;
  const ageMax = Math.max(1, ...d.ageing.map((a) => a.value));
  const trendMax = Math.max(1, ...d.trend.map((m) => m.billed));

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      <Txt variant="small">{t('Billing, collection, ageing and expected cash flow.')} {d.academicYear}</Txt>
      <KpiGrid>
        <Kpi icon="wallet" label={t('Collected')} value={fmt.money(k.collected, { compact: true })} tone="success" foot={t('{pct}% of {billed} billed', { pct: k.collectionPct.toFixed(1), billed: fmt.money(k.billed, { compact: true }) })} />
        <Kpi icon="clock" label={t('Outstanding')} value={fmt.money(k.outstanding, { compact: true })} tone="warning" foot={t('{n} student accounts', { n: k.outstandingAccounts })} />
        <Kpi icon="alert" label={t('Overdue 30+ days')} value={fmt.money(k.overdue, { compact: true })} tone="critical" foot={t('{n} accounts · {amount} past due in total', { n: k.overdueAccounts, amount: fmt.money(k.overdueAll, { compact: true }) })} />
        <Kpi icon="calendar" label={t('Expected this month')} value={fmt.money(k.expected, { compact: true })} tone="info" foot={t('Instalments falling due')} />
      </KpiGrid>

      <Card title={t('Collection trend')} sub={t('Collected against billed, by month')} icon="barChart">
        {d.trend.some((m) => m.billed || m.collected) ? d.trend.slice(-6).map((m) => (
          <Meter key={m.month} label={m.label} value={(m.collected / trendMax) * 100} right={`${fmt.money(m.collected, { compact: true })} / ${fmt.money(m.billed, { compact: true })}`} tone="success" />
        )) : <Empty icon="barChart" title={t('No billing yet')} sub={t('Invoices and collections will appear here.')} />}
      </Card>

      <Card title={t('Overdue ageing')} sub={t('Outstanding by days past the due date')} icon="wallet">
        {d.ageing.some((a) => a.value > 0) ? d.ageing.map((a, i) => (
          <Meter key={a.label} label={t(a.label)} value={(a.value / ageMax) * 100} right={fmt.money(a.value, { compact: true })} tone={AGE_TONES[i] ?? 'critical'} />
        )) : <Empty icon="check" title={t('Nothing overdue')} sub={t('Every instalment is within its due date.')} />}
      </Card>

      <Card title={t('Payment method')} icon="creditCard">
        {d.methods.length ? d.methods.map((m) => <Meter key={m.label} label={t(m.label)} value={m.pct} right={`${m.pct}% · ${fmt.money(m.amount, { compact: true })}`} />)
          : <Txt variant="small">{t('The method mix appears once the first payment is recorded.')}</Txt>}
      </Card>

      <Card title={t('Overdue accounts')} sub={t('More than 30 days past due')} icon="alert">
        {d.attention.length ? d.attention.slice(0, 15).map((a) => (
          <ListItem key={a.id} icon="user" tone="critical" title={a.fullName}
            meta={`${a.admissionNo} · ${a.grade ?? ''}${a.section ?? ''} · ${t('{n} days', { n: a.ageDays })} · ${t('overdue {amount}', { amount: fmt.money(a.overdue) })}`}
            right={<StatusBadge value={a.feeStatus} />} onPress={() => openWeb(`/student-accounts?q=${encodeURIComponent(a.admissionNo)}`)} />
        )) : <Txt variant="small">{t('No account is more than 30 days overdue.')}</Txt>}
      </Card>
      <Txt variant="micro">{t('Recording payments and sending reminders is done in the web portal.')}</Txt>
    </Screen>
  );
}
