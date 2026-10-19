import { StyleSheet, View } from 'react-native';
import { useApiQuery } from '@/api/hooks';
import type { StudentProfile } from '@/api/types';
import { useI18n } from '@/i18n/I18nProvider';
import { Badge, Card, ErrorState, ListItem, Loading, MiniBars, Row, Txt } from '@/components/ui';
import { fmt } from '@/lib/format';
import { colors, radius, space } from '@/theme/theme';
import { overviewPath, type ChildOverview, type ChildRow, type ParentMe } from './ParentContext';
import { ParentScreen } from './ParentShell';

/** Academics: GET /students/:id/profile (subjects, assessments, attendance) and the overview's homework. */
export default function FamilyAcademicsScreen() {
  return <ParentScreen>{({ me, child }) => <Academics me={me} child={child} />}</ParentScreen>;
}

export function AttendanceFigures({ totals }: { totals: { present: number; late: number; absent: number; leave: number } }) {
  const { t } = useI18n();
  const items = [
    { label: t('Present'), value: totals.present, color: colors.success },
    { label: t('Late'), value: totals.late, color: colors.warning },
    { label: t('Absent'), value: totals.absent, color: colors.critical },
    { label: t('Leave'), value: totals.leave, color: colors.text },
  ];
  return (
    <View style={styles.figs}>
      {items.map((i) => (
        <View key={i.label} style={styles.fig}>
          <Txt variant="micro">{i.label}</Txt>
          <Txt variant="h2" color={i.color}>{String(i.value)}</Txt>
        </View>
      ))}
    </View>
  );
}

function Academics({ me, child }: { me: ParentMe; child: ChildRow }) {
  const { t } = useI18n();
  const prof = useApiQuery<StudentProfile>(`/students/${child.id}/profile`);
  const ov = useApiQuery<ChildOverview>(overviewPath(me.id, child.id), undefined, { refetchInterval: 60_000 });
  if (prof.isLoading) return <Loading />;
  if (prof.error || !prof.data) return <Card><ErrorState error={prof.error} onRetry={() => void prof.refetch()} /></Card>;
  const d = prof.data;
  const hw = [...(ov.data?.homework ?? [])].sort((a, b) => Number(a.submitted) - Number(b.submitted) || a.dueOn.localeCompare(b.dueOn));
  const openHw = hw.filter((h) => !h.submitted).length;

  return (
    <>
      <Card title={t('Progress this year')} icon="trending" right={<Badge label={t(child.risk)} tone={child.risk === 'On Track' ? 'success' : 'warning'} />}>
        {d.academics.termTrend.length > 1 ? <MiniBars points={d.academics.termTrend} unit="" /> : <Txt variant="small">{t('Progress appears after more assessments.')}</Txt>}
      </Card>

      <Card title={t('Attendance')} icon="checkSquare" sub={child.attendance != null ? t('{pct}% this year', { pct: child.attendance }) : undefined}>
        {d.attendance.totals ? <AttendanceFigures totals={d.attendance.totals} /> : <Txt variant="small">{t('No attendance marked yet.')}</Txt>}
        {d.attendance.months.length > 1 && <MiniBars points={d.attendance.months.slice(-6)} />}
      </Card>

      <Card title={t('Homework')} icon="edit" sub={ov.data ? t('{n} open', { n: openHw }) : undefined}>
        {ov.isLoading ? <Loading height={80} /> : hw.length ? hw.map((h) => (
          <ListItem key={h.id} icon={h.submitted ? 'check' : 'edit'} tone={h.submitted ? 'success' : undefined} title={h.title}
            meta={`${h.subject} · ${t('due {date}', { date: fmt.dateShort(h.dueOn) })}`}
            right={<Badge label={h.submitted ? t('Submitted') : t('Open')} tone={h.submitted ? 'success' : 'info'} />} />
        )) : <Txt variant="small">{t('No homework set at the moment.')}</Txt>}
      </Card>

      <Card title={t('Subject performance')} icon="award">
        {d.academics.subjects.length ? d.academics.subjects.map((s) => (
          <ListItem key={s.name} title={s.name} meta={s.teacher ?? undefined}
            right={(
              <View style={{ alignItems: 'flex-end' }}>
                <Txt variant="body" weight="bold">{`${s.score} · ${s.grade}`}</Txt>
                {s.trend != null && <Txt variant="micro" color={s.trend >= 0 ? colors.success : colors.critical}>{`${s.trend >= 0 ? '+' : ''}${s.trend}`}</Txt>}
              </View>
            )} />
        )) : <Txt variant="small">{t('No results yet.')}</Txt>}
      </Card>

      <Card title={t('Recent assessments')} icon="clipboard">
        {d.academics.assessments.length ? d.academics.assessments.slice(0, 8).map((a) => (
          <ListItem key={a.code} title={a.name} meta={`${a.subject} · ${fmt.dateShort(a.heldOn)} · ${t('{n} marks', { n: a.maxMarks })}`}
            right={a.isAbsent ? <Badge label={t('Absent')} tone="critical" /> : (
              <Row gap={4}><Txt variant="body" weight="bold">{a.marks ?? '—'}</Txt>{a.grade ? <Txt variant="micro">{`· ${a.grade}`}</Txt> : null}</Row>
            )} />
        )) : <Txt variant="small">{t('No assessment results yet.')}</Txt>}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  figs: { flexDirection: 'row', gap: space.sm },
  fig: { flex: 1, backgroundColor: colors.bg, borderRadius: radius.md, padding: space.sm, alignItems: 'center' },
});
