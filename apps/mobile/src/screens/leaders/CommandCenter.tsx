import { View } from 'react-native';
import { useApiQuery, useRefresh } from '@/api/hooks';
import { useAuth, useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import {
  Badge, Card, Empty, ErrorState, Kpi, KpiGrid, ListItem, Loading, Meter, MiniBars, Screen, SectionTitle, Txt,
} from '@/components/ui';
import { firstName, fmt, greetingKey } from '@/lib/format';
import { useNav } from '@/lib/navigation';
import type { Tone } from '@/theme/theme';

interface Dashboard {
  scope: 'campus' | 'group';
  generatedAt: string;
  students: { total: number; atRisk: number; developing: number; onTrack: number };
  attendance: {
    today: { present: number; late: number; absent: number; leave: number; marked: number; total: number };
    todayPct: number | null;
    trend: { label: string; date: string; value: number }[];
    repeatAbsentees: number;
  };
  staff: { total: number; present: number; absent: number; onLeave: number; late: number; teaching: number; nonTeaching: number; teachingPresent: number; nonTeachingPresent: number };
  admissions?: { enquiries: number; admitted: number; thisMonth: number; unassigned: number; conversion: number; funnel: { label: string; value: number }[]; overdueFollowUps: number };
  finance?: { billed: number; collected: number; outstanding: number; overdue: number; overdueAccounts: number; collectedToday: number; collectionPct: number };
  earlyWarning?: { open: number; awaitingReview: number; inIntervention: number; closedThisTerm: number };
  parentEngagement: { score: number | null; unanswered: number; oldestUnanswered: string | null };
  academic: { byGrade: { grade: string; level: number; average: number }[] };
  approvals: { total: number; expenses: number; leave: number; overtime: number; concessions: number; reimbursements: number; certificates: number; payroll: number };
  tracking?: { total: number; active: number; offline: number; paused: number; disabled: number; atSchool: number; inTransit: number; atHome: number };
  attention: { tone: string; icon: string; title: string; meta: string; route: string; count: number }[];
  activity: { at: string; text: string; module: string; by: string; icon: string }[];
}

const toTone = (v: string): Tone => (['success', 'warning', 'critical', 'info', 'neutral', 'brand', 'caution'].includes(v) ? (v as Tone) : 'info');

/** Pulse / Command Center: GET /dashboard/command-center { scope: campus, campusId } — today's figures, attention list, activity. */
export default function CommandCenterScreen() {
  const user = useUser();
  const { can } = useAuth();
  const { t } = useI18n();
  const { open, openRoute } = useNav();
  const { refreshing, onRefresh } = useRefresh();
  const q = useApiQuery<Dashboard>('/dashboard/command-center', { scope: 'campus', campusId: user.campusId ?? undefined }, { refetchInterval: 120_000 });

  const welcome = (
    <View style={{ gap: 2 }}>
      <Txt variant="h1">{t(greetingKey())}, {/administrat/i.test(user.fullName) ? user.fullName : firstName(user.fullName)}</Txt>
      <Txt variant="small">{t("Here's what's happening at {campus} today.", { campus: user.campus_name ?? t('your school') })}</Txt>
    </View>
  );
  if (q.isLoading) return <Screen>{welcome}<Loading /></Screen>;
  if (q.error || !q.data) return <Screen onRefresh={onRefresh}>{welcome}<ErrorState error={q.error} onRetry={() => void q.refetch()} /></Screen>;
  const d = q.data;
  const a = d.attendance;

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      {welcome}
      <KpiGrid>
        <Kpi icon="checkSquare" label={t('Attendance today')} value={a.todayPct != null ? `${Math.round(a.todayPct)}%` : '—'} tone="success"
          foot={t('{marked} of {total} marked', { marked: a.today.marked, total: a.today.total })} onPress={can(['attendance.read', 'attendance.mark']) ? () => open('attendance') : undefined} />
        <Kpi icon="userCheck" label={t('Absent Today')} value={fmt.n(a.today.absent)} tone="critical" foot={t('{late} late · {n} absent 3+ days running', { late: a.today.late, n: a.repeatAbsentees })} />
        <Kpi icon="alert" label={t('Students Requiring Attention')} value={d.students.atRisk} tone="critical"
          foot={d.earlyWarning ? t('{n} signals awaiting review', { n: d.earlyWarning.awaitingReview }) : t('+ {n} developing', { n: d.students.developing })}
          onPress={can(['students.read', 'students.read_assigned']) ? () => open('students', { risk: 'At Risk' }) : undefined} />
        <Kpi icon="users" label={t('Staff present')} value={`${d.staff.present}/${d.staff.total}`} foot={t('{n} on leave · {m} late', { n: d.staff.onLeave, m: d.staff.late })} />
        {d.finance && (
          <Kpi icon="wallet" label={t('Outstanding Fees')} value={fmt.money(d.finance.outstanding, { compact: true })} tone="warning"
            foot={t('{pct}% collected · {n} overdue accounts', { pct: Math.round(d.finance.collectionPct), n: d.finance.overdueAccounts })} onPress={can('finance.read') ? () => open('fees') : undefined} />
        )}
        {d.admissions && (
          <Kpi icon="target" label={t('Admissions Pipeline')} value={fmt.n(d.admissions.funnel[1]?.value ?? 0)} foot={t('{n} admitted · {m} enquiries this month', { n: d.admissions.admitted, m: d.admissions.thisMonth })}
            onPress={can('admissions.read') ? () => open('admissions') : undefined} />
        )}
        {d.tracking && (
          <Kpi icon="mapPin" label={t('Student Tracking')} value={`${d.tracking.active}/${d.tracking.total}`} foot={t('{n} on campus · {m} offline', { n: d.tracking.atSchool, m: d.tracking.offline })}
            onPress={can(['tracking.read_all', 'tracking.read_assigned']) ? () => open('tracking') : undefined} />
        )}
        <Kpi icon="checkSquare" label={t('Approvals waiting')} value={d.approvals.total} tone={d.approvals.total ? 'warning' : undefined} foot={t('Leave {a} · expenses {b} · overtime {c}', { a: d.approvals.leave, b: d.approvals.expenses, c: d.approvals.overtime })}
          onPress={() => open('tasks')} />
      </KpiGrid>

      <Card title={t("Today's Attention")} sub={t('Ranked by urgency. Every row opens the screen where it is resolved.')} icon="alert">
        {d.attention.length ? d.attention.map((i) => (
          <ListItem key={i.title} icon={i.icon} tone={toTone(i.tone)} title={i.title} meta={i.meta} right={<Badge label={String(i.count)} tone={toTone(i.tone)} />} onPress={() => openRoute(i.route)} />
        )) : <Empty icon="check" title={t('All clear')} sub={t('Nothing needs attention right now.')} />}
        <Txt variant="micro">{t('Signals are advisory. Nothing is actioned automatically.')}</Txt>
      </Card>

      {a.trend.length > 1 && (
        <Card title={t('Attendance trend')} icon="trending">
          <MiniBars points={a.trend.slice(-7)} />
        </Card>
      )}

      <Card title={t('Live activity')} sub={t('Gate, transport and system events')} icon="activity">
        {d.activity.length ? d.activity.slice(0, 8).map((x, i) => (
          <ListItem key={i} icon={x.icon} title={x.text} meta={`${fmt.time(x.at)} · ${x.by} · ${t(x.module)}`} numberOfLines={3} />
        )) : <Empty icon="activity" title={t('No activity yet today')} />}
      </Card>

      {d.academic.byGrade.length > 0 && (
        <Card title={t('Results by grade')} sub={t('Latest-term average by grade')} icon="trending">
          {d.academic.byGrade.map((g) => (
            <Meter key={g.grade} label={g.grade} value={g.average} right={`${g.average}/100`} tone={g.average >= 75 ? 'success' : g.average >= 60 ? 'info' : 'critical'} />
          ))}
        </Card>
      )}

      <SectionTitle>{t('School at a glance')}</SectionTitle>
      <KpiGrid>
        <Kpi label={t('Students')} value={fmt.n(d.students.total)} foot={t('{n} on track', { n: d.students.onTrack })} />
        <Kpi label={t('Teaching Staff')} value={fmt.n(d.staff.teaching)} foot={t('{n} present today', { n: d.staff.teachingPresent })} />
        <Kpi label={t('Non-Teaching Staff')} value={fmt.n(d.staff.nonTeaching)} foot={t('{n} present today', { n: d.staff.nonTeachingPresent })} />
        <Kpi label={t('Parent Engagement')} value={d.parentEngagement.score != null ? `${d.parentEngagement.score}/100` : '—'} foot={t('{n} queries awaiting reply', { n: d.parentEngagement.unanswered })} />
      </KpiGrid>
      <Txt variant="micro">{t('Students are never auto-labelled. Risk bands are decision support; a teacher confirms every signal.')}</Txt>
    </Screen>
  );
}
