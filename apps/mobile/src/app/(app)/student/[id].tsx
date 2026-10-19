import { Linking, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useApiQuery, useRefresh } from '@/api/hooks';
import type { StudentProfile } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { Avatar, Badge, Button, Card, ErrorState, ListItem, Loading, Meter, MiniBars, Row, Screen, StatusBadge, Txt } from '@/components/ui';
import { fmt } from '@/lib/format';
import { useNav } from '@/lib/navigation';
import { AttendanceFigures } from '@/screens/parent/FamilyAcademics';
import { TODAY_LABEL, todayTone } from '@/screens/parent/ParentShell';
import { space } from '@/theme/theme';

/** Student summary for staff: GET /students/:id/profile (scoped server-side to what the role may see). */
export default function StudentSummary() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { can } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const { openWeb } = useNav();
  const { refreshing, onRefresh } = useRefresh();
  const q = useApiQuery<StudentProfile>(id ? `/students/${id}/profile` : null);
  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (q.error || !q.data) return <Screen><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Screen>;
  const d = q.data;
  const s = d.student;

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      <Stack.Screen options={{ title: s.fullName }} />
      <Card>
        <Row gap={space.md} style={{ alignItems: 'flex-start' }}>
          <Avatar name={s.fullName} size={56} />
          <View style={{ flex: 1, gap: 4 }}>
            <Txt variant="h2">{s.fullName}</Txt>
            <Txt variant="small">{[`${s.grade ?? ''} ${s.section ?? ''}`.trim(), s.rollNo ? t('Roll {n}', { n: s.rollNo }) : null, s.admissionNo, s.campusName].filter(Boolean).join(' · ')}</Txt>
            <Row gap={6} wrap>
              <Badge label={t(TODAY_LABEL[s.today] ?? s.today)} tone={todayTone(s.today)} dot />
              <Badge label={t(s.risk)} tone={s.risk === 'At Risk' ? 'critical' : s.risk === 'Developing Risk' ? 'warning' : 'success'} />
              {s.feeStatus ? <StatusBadge value={s.feeStatus} /> : null}
            </Row>
            <Txt variant="micro">{s.classTeacher ? t('Class teacher: {name}', { name: s.classTeacher }) : t('No class teacher yet')}{s.house ? ` · ${t('{house} House', { house: s.house })}` : ''}</Txt>
          </View>
        </Row>
        <Row gap={space.sm} wrap>
          <Badge label={`${t('Attendance')} ${s.attendance != null ? `${s.attendance}%` : '—'}`} tone={s.attendance != null && s.attendance < 85 ? 'critical' : 'success'} />
          <Badge label={`${t('Average')} ${s.average ?? '—'}${s.average != null ? ` (${s.trend >= 0 ? '+' : ''}${s.trend})` : ''}`} tone="brand" />
        </Row>
        <Row gap={space.sm} wrap>
          {can(['tracking.read_all', 'tracking.read_assigned']) && <Button size="sm" icon="mapPin" label={t('Location')} onPress={() => router.push(`/location/${s.id}`)} />}
          <Button size="sm" icon="external" label={t('Full Student 360')} onPress={() => openWeb(`/student-360/${s.id}`)} />
        </Row>
      </Card>

      <Card title={t('Attendance')} icon="checkSquare">
        {d.attendance.totals ? <AttendanceFigures totals={d.attendance.totals} /> : <Txt variant="small">{t('No attendance marked yet.')}</Txt>}
        {d.attendance.months.length > 1 && <MiniBars points={d.attendance.months.slice(-6)} />}
        {d.attendance.recent.slice(0, 5).map((r) => (
          <ListItem key={r.date} icon="calendar" title={fmt.date(r.date)} meta={r.arrivalTime ? t('Arrived {time}', { time: r.arrivalTime.slice(0, 5) }) : r.remarks ?? undefined} right={<StatusBadge value={r.status} />} />
        ))}
      </Card>

      <Card title={t('Subject performance')} icon="trending">
        {d.academics.subjects.length ? d.academics.subjects.map((x) => (
          <Meter key={x.name} label={`${x.name}${x.teacher ? ` · ${x.teacher}` : ''}`} value={x.score} right={`${x.score} · ${x.grade}`} tone={x.score >= 80 ? 'success' : x.score >= 70 ? 'info' : 'warning'} />
        )) : <Txt variant="small">{t('No results yet.')}</Txt>}
      </Card>

      <Card title={t('Recent assessments')} icon="clipboard">
        {d.academics.assessments.length ? d.academics.assessments.slice(0, 6).map((a) => (
          <ListItem key={a.code} title={a.name} meta={`${a.subject} · ${fmt.dateShort(a.heldOn)} · ${t('out of {n}', { n: a.maxMarks })}`}
            right={a.isAbsent ? <Badge label={t('Absent')} tone="critical" /> : <Txt variant="body" weight="bold">{`${a.marks ?? '—'}${a.grade ? ` · ${a.grade}` : ''}`}</Txt>} />
        )) : <Txt variant="small">{t('No assessment results yet.')}</Txt>}
      </Card>

      {d.guardians.length > 0 && (
        <Card title={t('Parents & guardians')} icon="users">
          {d.guardians.map((g) => (
            <ListItem key={g.id} icon="user" title={`${g.fullName}${g.isPrimary ? ` · ${t('Primary')}` : ''}`} meta={[t(g.relationship), g.phone, g.email].filter(Boolean).join(' · ')}
              right={g.phone ? <Button size="sm" icon="phone" label={t('Call')} onPress={() => void Linking.openURL(`tel:${g.phone}`)} /> : undefined} />
          ))}
        </Card>
      )}

      {d.transport && (
        <Card title={t('Transport')} icon="bus" right={<StatusBadge value={d.transport.runStatus} />}>
          <Txt variant="small">{`${d.transport.busNo ?? d.transport.routeCode} · ${d.transport.routeName} · ${t('stop {stop}', { stop: d.transport.stopName ?? '—' })} · ${t('pickup {time}', { time: fmt.hhmm(d.transport.pickupTime) })}`}</Txt>
        </Card>
      )}

      {d.achievements.length > 0 && (
        <Card title={t('Achievements')} icon="award">
          {d.achievements.slice(0, 5).map((a) => <ListItem key={a.id} icon="award" tone="brand" title={a.title} meta={`${a.level ?? t('School')} · ${fmt.dateShort(a.date)}`} />)}
        </Card>
      )}
    </Screen>
  );
}
