import { useLocalSearchParams } from 'expo-router';
import { useApiQuery } from '@/api/hooks';
import { useI18n } from '@/i18n/I18nProvider';
import { Banner, Card, Divider, ErrorState, ListItem, Loading, Row, Screen, Txt } from '@/components/ui';
import { fmt } from '@/lib/format';
import { colors } from '@/theme/theme';

interface Payslip {
  id: string; employeeName: string; employeeCode: string; designation: string; department: string; campusName: string | null;
  monthLabel: string; earnings: { label: string; amount: number }[]; deductions: { label: string; amount: number }[];
  gross: number; totalDeductions: number; net: number; workingDays: number; daysWorked: number; leaveDays: number; overtimeHours?: number;
  paymentDate?: string | null; bankAccount?: string | null; status: string;
}

/** The employee's own payslip: GET /me/payslips/:id. */
export default function PayslipScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  const q = useApiQuery<Payslip>(id ? `/me/payslips/${id}` : null);
  const s = q.data;
  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (q.error || !s) return <Screen><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Screen>;
  const money = (v: number) => <Txt variant="small" weight="semibold" color={colors.text}>{fmt.money(v)}</Txt>;
  return (
    <Screen>
      <Card>
        <Txt variant="micro">{t('Payslip')} · {s.campusName ?? 'Holy Sai'}</Txt>
        <Txt variant="h2">{s.monthLabel}</Txt>
        <Txt variant="small">{s.employeeName} · {s.employeeCode} · {s.designation}{s.department ? ` · ${s.department}` : ''}</Txt>
        {s.status !== 'Released' && <Banner tone="warning" icon="alert">{t('Draft — this payslip has not been released and may change.')}</Banner>}
      </Card>
      <Card title={t('Earnings')} icon="plus">
        {s.earnings.map((e) => <ListItem key={e.label} title={t(e.label)} right={money(e.amount)} />)}
        <Divider />
        <Row style={{ justifyContent: 'space-between' }}><Txt variant="body" weight="bold">{t('Gross')}</Txt><Txt variant="body" weight="bold">{fmt.money(s.gross)}</Txt></Row>
      </Card>
      <Card title={t('Deductions')} icon="minus">
        {s.deductions.length ? s.deductions.map((e) => <ListItem key={e.label} title={t(e.label)} right={money(e.amount)} />) : <Txt variant="small">—</Txt>}
        <Divider />
        <Row style={{ justifyContent: 'space-between' }}><Txt variant="body" weight="bold">{t('Total deductions')}</Txt><Txt variant="body" weight="bold">{fmt.money(s.totalDeductions)}</Txt></Row>
      </Card>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt variant="h3">{t('Net pay')}</Txt>
          <Txt variant="display" color={colors.brand}>{fmt.money(s.net)}</Txt>
        </Row>
        <Txt variant="small">{t('Days worked {worked} of {working} · leave {leave}', { worked: s.daysWorked, working: s.workingDays, leave: s.leaveDays })}</Txt>
        {s.paymentDate ? <Txt variant="small">{t('Paid on')}: {fmt.date(s.paymentDate)}</Txt> : null}
        {s.bankAccount ? <Txt variant="small">{t('Bank account')}: {s.bankAccount}</Txt> : null}
      </Card>
      <Txt variant="micro">{t('Computer-generated payslip; no signature required.')}</Txt>
    </Screen>
  );
}
