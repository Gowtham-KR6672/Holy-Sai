import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useApiMutation, useApiQuery, useRefresh } from '@/api/hooks';
import { useAuth, useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import {
  Banner, Button, Card, confirmAction, Empty, ErrorState, Loading, Row, Screen, Select, Txt,
} from '@/components/ui';
import { addDays, fmt, todayKey } from '@/lib/format';
import { colors, radius, space, toneColors, type Tone } from '@/theme/theme';

type Status = 'present' | 'late' | 'absent' | 'leave';
interface SectionRow { id: string; label: string; campusName: string; students: number; marked: number; status: string }
interface RegisterStudent { id: string; admissionNo: string; fullName: string; roll: number | null; status: Status | null; arrivalTime: string | null; parentNotifiedAt: string | null; risk: string }
interface Register {
  section: { id: string; label: string; room: string | null };
  date: string;
  isToday: boolean;
  period: { periodNo: number; startsAt: string; endsAt: string; subject: string | null; room: string | null; teacher: string | null } | null;
  students: RegisterStudent[];
  summary: Record<Status | 'total' | 'unmarked', number>;
  lastMarkedBy: { name: string; at: string } | null;
  editable: boolean;
  readOnlyReason: string | null;
}
interface SaveResult { date: string; section: string; saved: number; changed: number; absenceAlerts: number; lateNotices: number; notificationsQueued: number; signalsRaised: { code: string; reason: string }[] }

/** One tap per student — P / L / A / V, as on the web register. */
const STATUS_BTN: { id: Status; label: string; key: string; tone: Tone }[] = [
  { id: 'present', label: 'Present', key: 'P', tone: 'success' },
  { id: 'late', label: 'Late', key: 'L', tone: 'warning' },
  { id: 'absent', label: 'Absent', key: 'A', tone: 'critical' },
  { id: 'leave', label: 'Leave', key: 'V', tone: 'info' },
];

/**
 * Mark attendance per section: GET /attendance/sections, GET /attendance/register, PUT /attendance/register.
 * Absences notify parents automatically and feed the Early Warning check (server side).
 */
export default function AttendanceScreen() {
  const user = useUser();
  const { can } = useAuth();
  const { t } = useI18n();
  const params = useLocalSearchParams<{ section?: string }>();
  const { refreshing, onRefresh } = useRefresh();
  const today = todayKey();
  const [date, setDate] = useState(today);
  const [sectionId, setSectionId] = useState<string | undefined>(params.section);
  const campus = user.campusId ? { campusId: user.campusId } : {};
  const sections = useApiQuery<SectionRow[]>('/attendance/sections', { ...campus, date });
  const list = sections.data ?? [];
  const current = sectionId && list.some((s) => s.id === sectionId)
    ? sectionId
    : (list.find((s) => s.status === 'Not marked') ?? list.find((s) => s.status === 'Pending') ?? list[0])?.id;

  useEffect(() => {
    if (params.section) setSectionId(params.section);
  }, [params.section]);

  const reg = useApiQuery<Register>(current ? '/attendance/register' : null, { sectionId: current, date });
  const r = reg.data;
  const [marks, setMarks] = useState<Record<string, Status | null>>({});
  const [result, setResult] = useState<SaveResult | null>(null);
  useEffect(() => {
    if (r) setMarks(Object.fromEntries(r.students.map((s) => [s.id, s.status])));
  }, [r]);
  useEffect(() => setResult(null), [current, date]);

  const save = useApiMutation<{ sectionId: string; date: string; marks: { studentId: string; status: Status }[] }, SaveResult>('put', '/attendance/register', {
    invalidate: ['/attendance', '/academics/teacher-dashboard', '/academics/classes', '/notifications'],
    success: 'Attendance saved',
    onSuccess: (res) => setResult(res.data),
  });

  const counts = useMemo(() => {
    const c = { present: 0, late: 0, absent: 0, leave: 0, unmarked: 0 };
    for (const v of Object.values(marks)) c[v ?? 'unmarked']++;
    return c;
  }, [marks]);
  const changed = r ? r.students.filter((s) => (marks[s.id] ?? null) !== s.status).length : 0;
  const dirty = changed > 0;
  const editable = !!r?.editable && can('attendance.mark');
  const mark = (id: string, st: Status) => { setMarks((x) => ({ ...x, [id]: st })); setResult(null); };

  /** Switching section or date drops unsaved marks, so ask first. */
  const leaveRegister = async (go: () => void) => {
    if (dirty && !(await confirmAction({
      title: t('Discard unsaved attendance?'), body: t('{n} changes to this register will be lost.', { n: changed }),
      confirmLabel: t('Discard changes'), cancelLabel: t('Keep editing'), danger: true,
    }))) return;
    go();
  };

  const submit = async () => {
    if (!r || !current || counts.unmarked > 0) return;
    const alerted = r.students.filter((s) => { const m = marks[s.id]; return (m === 'absent' || m === 'late') && m !== s.status; });
    const absent = alerted.filter((s) => marks[s.id] === 'absent').length;
    if (!r.isToday || alerted.length) {
      const body = [
        !r.isToday ? t('You are editing a past register. The change is recorded against your name in the audit trail.') : '',
        alerted.length ? t('Parents of {absent} absent and {late} late students will be alerted on WhatsApp and the parent app. Alerts cannot be recalled once sent.', { absent, late: alerted.length - absent }) : '',
      ].filter(Boolean).join('\n\n');
      const ok = await confirmAction({
        title: r.isToday ? t('Save attendance and alert parents?') : t('Change the register for {date}?', { date: fmt.date(r.date) }),
        body, confirmLabel: t('Save attendance'), cancelLabel: t('Cancel'),
      });
      if (!ok) return;
    }
    save.mutate({ sectionId: current, date, marks: r.students.map((s) => ({ studentId: s.id, status: marks[s.id]! })) });
  };

  if (sections.isLoading) return <Screen><Loading /></Screen>;
  if (sections.error) return <Screen onRefresh={onRefresh}><ErrorState error={sections.error} onRetry={() => void sections.refetch()} /></Screen>;
  if (!list.length) {
    return (
      <Screen refreshing={refreshing} onRefresh={onRefresh}>
        <Card>
          <Empty icon="checkSquare" title={t('No sections to mark')}
            sub={can('students.read') ? t('No sections with students were found for your campus.') : t('You are not assigned to any section yet. Ask the academic office to add your class assignments.')} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      <Txt variant="small">{t('One tap per student. Absences notify parents automatically and feed the Early Warning check.')}</Txt>
      <Select label={t('Section')} value={current ?? ''} options={list.map((s) => ({ value: s.id, label: `${s.label} — ${t(s.status)}` }))}
        onChange={(v) => void leaveRegister(() => setSectionId(v))} />
      <Row style={{ justifyContent: 'space-between' }}>
        <Button size="sm" icon="chevronLeft" label={t('Previous day')} onPress={() => void leaveRegister(() => setDate(addDays(date, -1)))} />
        <Txt variant="body" weight="semibold">{date === today ? t('Today') : fmt.date(date)}</Txt>
        <Button size="sm" icon="chevronRight" label={t('Next day')} disabled={date >= today} onPress={() => void leaveRegister(() => setDate(addDays(date, 1)))} />
      </Row>

      {result && (
        <Banner tone="success" icon="check">
          {t('Attendance saved for {section}. {absent} absence alerts and {late} late notices were queued for parents.', { section: result.section, absent: result.absenceAlerts, late: result.lateNotices })}
          {result.signalsRaised.length ? ` ${t('Early Warning raised for review: {list}.', { list: result.signalsRaised.map((x) => `${x.code} (${x.reason})`).join('; ') })}` : ''}
        </Banner>
      )}

      {reg.error ? <Card><ErrorState error={reg.error} onRetry={() => void reg.refetch()} /></Card> : !r ? <Loading /> : (
        <Card flush>
          <View style={{ padding: space.lg, gap: 4 }}>
            <Txt variant="h3">{r.section.label}{r.period?.subject ? ` · ${r.period.subject}` : ''}</Txt>
            <Txt variant="micro">
              {[r.period ? t('Period {n} · {from}–{to}', { n: r.period.periodNo, from: r.period.startsAt, to: r.period.endsAt }) : t('No period timetabled'),
                t('Room {room}', { room: r.period?.room ?? r.section.room ?? '—' }), t('{n} students', { n: r.students.length })].join(' · ')}
            </Txt>
            {!editable && <Banner tone="neutral" icon="lock">{r.readOnlyReason ? t(r.readOnlyReason) : t('This register is read-only for your role.')}</Banner>}
            <Row gap={space.sm} wrap style={{ marginTop: space.sm }}>
              {STATUS_BTN.map((b) => (
                <View key={b.id} style={[styles.count, { backgroundColor: toneColors[b.tone].bg }]}>
                  <Txt variant="micro" color={toneColors[b.tone].fg}>{t(b.label)} {counts[b.id]}</Txt>
                </View>
              ))}
              {counts.unmarked > 0 && <View style={[styles.count, { backgroundColor: colors.bgSunken }]}><Txt variant="micro">{t('Unmarked')} {counts.unmarked}</Txt></View>}
            </Row>
            {editable && (
              <Row gap={space.sm} style={{ marginTop: space.sm }}>
                <Button size="sm" variant="success" icon="check" label={t('Mark all present')} disabled={!r.students.length}
                  onPress={() => { setMarks(Object.fromEntries(r.students.map((s) => [s.id, 'present' as Status]))); setResult(null); }} />
                <Button size="sm" icon="refresh" label={t('Undo changes')} disabled={!dirty} onPress={() => setMarks(Object.fromEntries(r.students.map((s) => [s.id, s.status])))} />
              </Row>
            )}
          </View>
          {r.students.length === 0 ? <Empty icon="users" title={t('No students in this section')} sub={t('Students appear here once they are enrolled in this section.')} /> : r.students.map((st) => {
            const m = marks[st.id] ?? null;
            const isChanged = m !== st.status;
            return (
              <View key={st.id} style={[styles.row, isChanged && styles.rowChanged, !m && styles.rowUnmarked]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <Txt variant="small" weight="bold" style={{ width: 28 }}>{st.roll ?? '—'}</Txt>
                  <View style={{ flex: 1 }}>
                    <Txt variant="body" weight="semibold" numberOfLines={1}>{st.fullName}</Txt>
                    <Txt variant="micro" numberOfLines={1}>
                      {[st.admissionNo, st.parentNotifiedAt && (st.status === 'absent' || st.status === 'late') ? t('parent notified {time}', { time: fmt.time(st.parentNotifiedAt) }) : null,
                        st.arrivalTime && st.status === 'late' ? t('arrived {time}', { time: st.arrivalTime }) : null].filter(Boolean).join(' · ')}
                    </Txt>
                  </View>
                </View>
                <View style={styles.toggle} accessibilityRole="radiogroup" accessibilityLabel={t('Attendance for {name}', { name: st.fullName })}>
                  {STATUS_BTN.map((b) => {
                    const on = m === b.id;
                    const c = toneColors[b.tone];
                    return (
                      <Pressable key={b.id} disabled={!editable} onPress={() => mark(st.id, b.id)} accessibilityRole="radio" accessibilityState={{ checked: on, disabled: !editable }}
                        accessibilityLabel={t(b.label)} style={[styles.tbtn, { borderColor: on ? c.solid : colors.border, backgroundColor: on ? c.solid : colors.surface }, !editable && { opacity: 0.6 }]}>
                        <Txt variant="body" weight="bold" color={on ? colors.textInvert : c.fg}>{b.key}</Txt>
                        <Txt variant="micro" color={on ? colors.textInvert : colors.textMuted} numberOfLines={1}>{t(b.label)}</Txt>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            );
          })}
          <View style={[styles.savebar, dirty && { backgroundColor: colors.accentTint }]}>
            <Txt variant="small" weight="semibold" color={colors.text}>
              {dirty ? t('{n} unsaved changes', { n: changed }) : r.lastMarkedBy ? t('Saved by {name} · {when}', { name: r.lastMarkedBy.name, when: fmt.dateTime(r.lastMarkedBy.at) }) : t('Not marked yet for this date.')}
            </Txt>
            {editable && counts.unmarked > 0 && <Txt variant="micro" color={colors.warningText}>{t('Mark {n} more students to save', { n: counts.unmarked })}</Txt>}
            {editable && (
              <Button variant="primary" icon="check" label={t('Save attendance ({n})', { n: r.students.length })} onPress={() => void submit()}
                loading={save.isPending} disabled={counts.unmarked > 0 || r.students.length === 0} block />
            )}
          </View>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  count: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  row: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rowChanged: { backgroundColor: '#FFFBEF' },
  rowUnmarked: { borderLeftWidth: 3, borderLeftColor: colors.warning },
  toggle: { flexDirection: 'row', gap: 6 },
  tbtn: { flex: 1, alignItems: 'center', paddingVertical: 6, borderRadius: radius.sm, borderWidth: 1.5, minHeight: 48, justifyContent: 'center' },
  savebar: { padding: space.lg, gap: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg },
});
