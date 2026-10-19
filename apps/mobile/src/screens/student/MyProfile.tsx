import { View } from 'react-native';
import { useApiQuery, usePagedQuery, useRefresh } from '@/api/hooks';
import type { NotificationItem, StudentProfile } from '@/api/types';
import { useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { Icon } from '@/components/Icon';
import {
  Avatar, Badge, Button, Card, Empty, ErrorState, ListItem, Loading, Meter, MiniBars, Row, Screen, StatusBadge, Txt,
} from '@/components/ui';
import { fmt, greetingKey, todayKey } from '@/lib/format';
import { useNav } from '@/lib/navigation';
import { AttendanceFigures } from '@/screens/parent/FamilyAcademics';
import { TODAY_LABEL, todayTone } from '@/screens/parent/ParentShell';
import { colors, space } from '@/theme/theme';

/** Student portal "My day": GET /students/:id/profile (the signed-in student) and the latest /notifications. */
export default function MyProfileScreen() {
  const user = useUser();
  const { t } = useI18n();
  if (!user.studentId) {
    return <Screen><Card><Empty icon="user" title={t('No student record is linked to this account')} sub={t('Please contact the school office.')} /></Card></Screen>;
  }
  return <MyDay id={user.studentId} />;
}

function MyDay({ id }: { id: string }) {
  const { t } = useI18n();
  const { open, openRoute } = useNav();
  const { refreshing, onRefresh } = useRefresh();
  const q = useApiQuery<StudentProfile>(`/students/${id}/profile`);
  const notices = usePagedQuery<NotificationItem>('/notifications', { pageSize: 5 });
  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (q.error || !q.data) return <Screen onRefresh={onRefresh}><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Screen>;
  const d = q.data;
  const s = d.student;
  const todayRow = d.attendance.recent.find((r) => r.date.slice(0, 10) === todayKey());
  const low = s.attendance != null && s.attendance < 85;
  const ranked = [...d.academics.subjects].sort((a, b) => b.score - a.score);
  const avg = ranked.length ? Math.round(ranked.reduce((a, x) => a + x.score, 0) / ranked.length) : null;

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      <View style={{ gap: 2 }}>
        <Txt variant="h1">{t(greetingKey())}, {s.firstName}</Txt>
        <Txt variant="small">{t('Your day at school — classes, attendance, results and notices.')}</Txt>
      </View>

      <Card>
        <Row gap={space.md} style={{ alignItems: 'flex-start' }}>
          <Avatar name={s.fullName} size={56} />
          <View style={{ flex: 1, gap: 4 }}>
            <Txt variant="h2">{s.fullName}</Txt>
            <Badge label={t(TODAY_LABEL[s.today] ?? s.today)} tone={todayTone(s.today)} dot />
            <Txt variant="small">{[`${s.grade ?? ''} ${s.section ?? ''}`.trim(), s.rollNo ? t('Roll {n}', { n: s.rollNo }) : null, s.admissionNo, s.campusName].filter(Boolean).join(' · ')}</Txt>
            <Row gap={4}><Icon name="graduation" size={13} color={colors.textMuted} /><Txt variant="micro">{s.classTeacher ?? t('No class teacher yet')}</Txt></Row>
            <Row gap={4}><Icon name="bus" size={13} color={colors.textMuted} /><Txt variant="micro">{d.transport ? `${d.transport.routeName} · ${d.transport.stopName ?? d.transport.area}` : t('Own transport')}</Txt></Row>
          </View>
        </Row>
        <Row gap={space.sm} wrap>
          <Badge label={todayRow?.arrivalTime ? t('In {time}', { time: todayRow.arrivalTime.slice(0, 5) }) : t(TODAY_LABEL[s.today] ?? s.today)} tone={todayTone(s.today)} />
          <Badge label={`${t('Attendance')} ${s.attendance != null ? `${s.attendance}%` : '—'}`} tone={low ? 'critical' : 'success'} />
          <Badge label={`${t('Average')} ${s.average ?? '—'}`} tone="brand" />
          <Badge label={t('{n} achievements', { n: d.achievements.length })} tone="caution" />
        </Row>
        <Button size="sm" icon="lightbulb" label={t('My ideas')} onPress={() => open('my-ideas')} />
      </Card>

      <Card title={t('My Attendance')} icon="checkSquare" sub={low ? t('below the 85% target') : t('this academic year')}>
        {d.attendance.totals ? <AttendanceFigures totals={d.attendance.totals} /> : <Txt variant="small">{t('No attendance marked yet.')}</Txt>}
        {d.attendance.months.length > 1 && <MiniBars points={d.attendance.months.slice(-6)} />}
        {d.attendance.recent.slice(0, 4).map((r) => (
          <ListItem key={r.date} icon="calendar" title={fmt.date(r.date)} meta={r.arrivalTime ? t('Arrived {time}', { time: r.arrivalTime.slice(0, 5) }) : r.remarks ?? undefined} right={<StatusBadge value={r.status} />} />
        ))}
      </Card>

      <Card title={t('My subjects')} icon="trending" sub={avg != null ? t('Overall average {n}%', { n: avg }) : undefined}>
        {ranked.length ? ranked.map((x) => (
          <Meter key={x.name} label={`${x.name}${x.teacher ? ` · ${x.teacher}` : ''}`} value={x.score} right={`${x.score} · ${x.grade}`} tone={x.score >= 80 ? 'success' : x.score >= 70 ? 'info' : 'warning'} />
        )) : <Txt variant="small">{t('Your results appear here after your first assessment.')}</Txt>}
      </Card>

      <Card title={t('Recent assessments')} icon="clipboard">
        {d.academics.assessments.length ? d.academics.assessments.slice(0, 6).map((a) => (
          <ListItem key={a.code} icon="fileText" title={a.name} meta={`${a.subject} · ${fmt.dateShort(a.heldOn)} · ${t('out of {n}', { n: a.maxMarks })}`}
            right={a.isAbsent ? <Badge label={t('Absent')} tone="critical" /> : <Txt variant="body" weight="bold">{`${a.marks ?? '—'}${a.grade ? ` · ${a.grade}` : ''}`}</Txt>} />
        )) : <Txt variant="small">{t('No assessment results yet.')}</Txt>}
      </Card>

      <Card title={t('My activities & achievements')} icon="award">
        {d.activities.length || d.achievements.length ? (
          <>
            {d.achievements.slice(0, 5).map((a) => <ListItem key={a.id} icon="award" tone="brand" title={a.title} meta={`${a.level ?? t('School')} · ${fmt.dateShort(a.date)}`} right={a.verified ? <Badge label={t('Verified')} tone="success" /> : undefined} />)}
            {d.activities.slice(0, 5).map((a) => <ListItem key={a.name} icon="star" title={a.name} meta={`${a.role} · ${t('{n} hours', { n: a.hours })}`} />)}
          </>
        ) : <Txt variant="small">{t('Your clubs, sports and achievements appear here.')}</Txt>}
      </Card>

      <Card title={t('Notices')} icon="bell" right={<Button size="sm" variant="ghost" label={t('All')} onPress={() => open('notifications')} />}>
        {notices.isLoading ? <Loading height={60} /> : notices.error ? <Txt variant="small">{t('Notices are not available right now.')}</Txt> : notices.data?.rows.length ? notices.data.rows.map((n) => (
          <ListItem key={n.id} icon={n.icon || 'bell'} tone={n.tone === 'critical' ? 'critical' : n.tone === 'warning' ? 'warning' : !n.readAt ? 'brand' : undefined}
            title={n.title} meta={fmt.relative(n.createdAt)} onPress={n.route ? () => openRoute(n.route) : undefined} />
        )) : <Txt variant="small">{t('You are all caught up. School notices will appear here.')}</Txt>}
      </Card>

      {d.transport && (
        <Card title={t('My bus')} icon="bus" right={<StatusBadge value={d.transport.runStatus} />}>
          <ListItem icon="bus" tone={d.transport.runStatus === 'Delayed' ? 'warning' : 'brand'} title={`${d.transport.busNo ?? d.transport.routeCode} · ${d.transport.routeName}`}
            meta={`${d.transport.runStatus === 'Delayed' ? t('Running {n} min late', { n: d.transport.delayMinutes }) : d.transport.eta ? t('ETA {eta}', { eta: d.transport.eta }) : t(d.transport.runStatus)} · ${t('stop {stop}', { stop: d.transport.stopName ?? '—' })} · ${t('pickup {time}', { time: fmt.hhmm(d.transport.pickupTime) })}`} />
        </Card>
      )}
    </Screen>
  );
}
