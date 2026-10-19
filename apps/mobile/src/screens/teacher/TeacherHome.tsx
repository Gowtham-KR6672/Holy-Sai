import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useApiQuery, useRefresh } from '@/api/hooks';
import { useAuth, useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import {
  Badge, Button, Card, Empty, ErrorState, Kpi, KpiGrid, ListItem, Loading, Meter, Row, Screen, Txt,
} from '@/components/ui';
import { fmt, greetingKey, todayKey } from '@/lib/format';
import { useNav } from '@/lib/navigation';
import { colors, radius, space, type Tone } from '@/theme/theme';

interface DashClass { id: string; name: string; subject: string; students: number; marked: number; next: string; attendance: string; isClassTeacher: boolean; hasClassToday: boolean }
interface DashPeriod { periodNo: number; startsAt: string; endsAt: string; what: string; where: string; state: 'now' | 'done' | 'upcoming'; free?: boolean; cover?: boolean; sectionId?: string }
interface DashSignal { id: string; code: string; signal: string; signalType: string; stage: number; studentId: string; name: string; admissionNo: string; sectionLabel: string }
interface DashTask { id: string; title: string; module: string; dueOn: string | null; route: string | null; overdue: boolean; priority: string }
interface DashHomework { id: string; title: string; subject: string; sectionLabel: string; dueOn: string; submitted: number; of: number }
interface TeacherDashboard {
  date: string; dayName: string; lede: string;
  employee: { id: string; fullName: string; designation: string } | null;
  kpis: { classes: number; students: number; toMark: number; toMarkNames: string[]; marksPending: number; marksPendingFoot: string | null; watch: number } | null;
  classes: DashClass[]; today: DashPeriod[]; watchlist: DashSignal[]; watchCount: number; tasks: DashTask[]; homework: DashHomework[];
}

const ATT_TONE: Record<string, Tone> = { Marked: 'success', Pending: 'warning', 'Not marked': 'critical' };

/** Teacher today: GET /academics/teacher-dashboard (classes, timetable, registers to mark, homework, watchlist). */
export default function TeacherHomeScreen() {
  const user = useUser();
  const { can } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const { open, openRoute } = useNav();
  const { refreshing, onRefresh } = useRefresh();
  const q = useApiQuery<TeacherDashboard>('/academics/teacher-dashboard', undefined, { refetchInterval: 120_000 });

  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (q.error || !q.data) return <Screen onRefresh={onRefresh}><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Screen>;
  const d = q.data;
  const name = (d.employee?.fullName ?? user.fullName).split(' ').slice(0, 2).join(' ');
  const toMark = d.classes.filter((c) => c.attendance !== 'Marked' && (c.isClassTeacher || c.hasClassToday));
  const first = toMark[0];
  const markAttendance = (sectionId?: string) => open('attendance', sectionId ? { section: sectionId } : undefined);
  const classById = new Map(d.classes.map((c) => [c.id, c]));

  const head = (
    <View style={{ gap: space.sm }}>
      <Txt variant="h1">{t(greetingKey())}, {name}</Txt>
      {d.lede ? <Txt variant="small">{d.lede}</Txt> : null}
      <Row gap={space.sm} wrap>
        <Button variant="primary" icon="checkSquare" label={first ? t('Mark attendance · {name}', { name: first.name }) : t('Mark attendance')} onPress={() => markAttendance(first?.id)} />
        {can('ai.use') && <Button icon="sparkle" label={t('AI Co-Pilot')} onPress={() => open('copilot')} />}
      </Row>
    </View>
  );

  if (!d.employee || !d.kpis) {
    return (
      <Screen refreshing={refreshing} onRefresh={onRefresh}>
        {head}
        <Card>
          <Empty icon="bookOpen" title={t('No teaching record linked to your account')}
            sub={t('Classes, timetable and watchlist appear here once your account is linked to a staff record with class assignments. You can still open attendance for any section.')}
            action={<Button icon="checkSquare" label={t('Open attendance')} onPress={() => markAttendance()} />} />
        </Card>
      </Screen>
    );
  }
  const k = d.kpis;
  const nowPeriod = d.today.find((p) => p.state === 'now');

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      {head}
      <KpiGrid>
        <Kpi icon="checkSquare" label={t('Attendance to mark')} value={k.toMark} tone={k.toMark ? 'critical' : 'success'}
          foot={k.toMark ? k.toMarkNames.join(', ') : t('All registers up to date')} onPress={() => markAttendance(first?.id)} />
        <Kpi icon="clipboard" label={t('Marks pending')} value={k.marksPending} tone={k.marksPending ? 'warning' : 'success'} foot={k.marksPendingFoot ?? t('Nothing waiting')} />
        <Kpi icon="alert" label={t('Students to watch')} value={k.watch} tone="info" foot={t('Open Early Warning signals')} />
        <Kpi icon="users" label={t('My classes')} value={k.classes} foot={t('{n} students in total', { n: k.students })} onPress={() => open('students')} />
      </KpiGrid>

      <Card title={t("Today's timetable")} sub={`${t(d.dayName)} ${fmt.date(d.date)}${nowPeriod ? ` · ${t('now: Period {n}', { n: nowPeriod.periodNo })}` : ''}`} icon="clock">
        {d.today.length === 0 ? <Empty icon="calendar" title={t('No periods today')} sub={t('Your timetable has no lessons on this day.')} /> : d.today.map((p) => {
          const cls = p.sectionId ? classById.get(p.sectionId) : undefined;
          const needsRegister = !!p.sectionId && !p.free && p.state !== 'upcoming' && (!cls || cls.attendance !== 'Marked');
          return (
            <View key={p.periodNo} style={[styles.period, p.state === 'now' && styles.periodNow, p.state === 'done' && { opacity: 0.7 }]}>
              <View style={styles.periodTime}>
                <Txt variant="small" weight="bold">P{p.periodNo}</Txt>
                <Txt variant="micro">{p.startsAt}–{p.endsAt}</Txt>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt variant="body" weight="semibold">{p.free ? t('Free period') : p.what}</Txt>
                <Txt variant="micro">{p.where}{p.cover ? ` · ${t('cover lesson')}` : ''}</Txt>
                {p.state === 'now' && <Badge label={t('Now')} tone="info" dot />}
              </View>
              {needsRegister && <Button size="sm" variant={p.state === 'now' ? 'primary' : 'secondary'} label={t('Register')} onPress={() => markAttendance(p.sectionId)} />}
            </View>
          );
        })}
      </Card>

      <Card title={t('My classes')} sub={t('Register, timetable and homework for each class')} icon="users">
        {d.classes.length === 0 ? <Empty icon="users" title={t('No classes assigned')} sub={t('Class assignments are managed by the academic office.')} /> : d.classes.map((c) => (
          <View key={c.id} style={{ gap: 6, paddingVertical: 8 }}>
            <Row>
              <View style={styles.classMark}><Txt variant="small" weight="bold" color={colors.brand}>{c.name.replace('Grade ', 'G')}</Txt></View>
              <View style={{ flex: 1 }}>
                <Txt variant="body" weight="semibold">{c.name} · {c.subject}{c.isClassTeacher ? ` · ${t('Class teacher')}` : ''}</Txt>
                <Txt variant="micro">{t('{n} students', { n: c.students })} · {t('next {when}', { when: c.next })}</Txt>
              </View>
              <Badge label={t(c.attendance)} tone={ATT_TONE[c.attendance] ?? 'neutral'} dot />
            </Row>
            <Row gap={space.sm}>
              <Button size="sm" icon="checkSquare" label={t('Attendance')} onPress={() => markAttendance(c.id)} />
              {can('academics.read') && <Button size="sm" icon="edit" label={t('Homework')} onPress={() => open('homework', { sectionId: c.id })} />}
            </Row>
          </View>
        ))}
      </Card>

      <Card title={t('Needs your attention')} sub={t('Registers still to mark and tasks due')} icon="alert">
        {toMark.length === 0 && d.tasks.length === 0 ? (
          <Empty icon="checkSquare" title={t('You are all caught up')} sub={t('Registers are marked and nothing is pending.')} />
        ) : (
          <>
            {toMark.map((c) => (
              <ListItem key={`att-${c.id}`} icon="checkSquare" tone={c.attendance === 'Not marked' ? 'critical' : 'warning'}
                title={t('Mark attendance — {name}', { name: c.name })} meta={`${t(c.attendance)} · ${t('{n} students', { n: c.students })}`} onPress={() => markAttendance(c.id)} />
            ))}
            {d.tasks.map((tk) => (
              <ListItem key={tk.id} icon="list" title={tk.title} meta={t(tk.module)}
                right={<Badge label={tk.overdue ? t('Overdue') : tk.dueOn === todayKey() ? t('Today') : tk.dueOn ? fmt.dateShort(tk.dueOn) : t('No date')} tone={tk.overdue ? 'critical' : tk.dueOn === todayKey() ? 'warning' : 'neutral'} />}
                onPress={() => (tk.route ? openRoute(tk.route) : open('tasks'))} />
            ))}
          </>
        )}
      </Card>

      <Card title={t('Homework to review')} sub={t('Open assignments in your classes')} icon="edit"
        right={can('academics.read') ? <Button size="sm" variant="ghost" label={t('All')} onPress={() => open('homework')} /> : undefined}>
        {d.homework.length === 0 ? <Empty icon="edit" title={t('No open homework')} sub={t('Homework you set appears here with its submission rate.')} /> : d.homework.map((h) => (
          <View key={h.id} style={{ gap: 4, paddingVertical: 6 }}>
            <Meter label={`${h.sectionLabel} ${h.subject} — ${h.title}`} value={h.of ? (h.submitted / h.of) * 100 : 0} right={`${h.submitted}/${h.of}`}
              tone={h.of && h.submitted / h.of >= 0.8 ? 'success' : h.of && h.submitted / h.of >= 0.5 ? 'warning' : 'critical'} />
            <Txt variant="micro">{t('due {date}', { date: fmt.dateShort(h.dueOn) })}</Txt>
          </View>
        ))}
      </Card>

      <Card title={t('Students requiring attention')} sub={t('Select a name to open the student summary')} icon="alert">
        {d.watchlist.length === 0 ? <Empty icon="shieldCheck" title={t('No open signals')} sub={t('None of your students has an open Early Warning signal.')} /> : d.watchlist.map((w) => (
          <ListItem key={w.id} icon="user" tone={w.signalType === 'attendance' ? 'critical' : 'warning'} title={w.name} meta={`${w.sectionLabel} · ${w.signal}`}
            onPress={() => router.push(`/student/${w.studentId}`)} />
        ))}
        <Txt variant="micro">{t('Signals are advisory. You decide whether they need action.')}</Txt>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  period: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 10, paddingHorizontal: 8, borderRadius: radius.md },
  periodNow: { backgroundColor: colors.brandTint },
  periodTime: { width: 72 },
  classMark: { width: 40, height: 40, borderRadius: 10, backgroundColor: colors.brandTint, alignItems: 'center', justifyContent: 'center' },
});
