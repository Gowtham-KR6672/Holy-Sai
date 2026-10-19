import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ApiError } from '@/api/client';
import { useApiMutation, useApiQuery, useRefresh } from '@/api/hooks';
import { useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { DateStepper } from '@/components/DateStepper';
import { Icon } from '@/components/Icon';
import {
  Badge, Banner, Button, Card, confirmAction, Empty, ErrorState, Field, Kpi, KpiGrid, ListItem, Loading, Meter, Row, Screen, Select, Sheet,
  StatusBadge, Txt,
} from '@/components/ui';
import { addDays, firstName, fmt, greetingKey, todayKey } from '@/lib/format';
import { useNav } from '@/lib/navigation';
import { colors, radius, space } from '@/theme/theme';

interface MyEmployee {
  today: string;
  employee: { id: string; fullName: string; designation?: string | null; shift?: string | null; today?: string | null; checkIn: string | null; checkOut: string | null; leaveBalance: number; leaveEntitled: number };
  shift: { id: string; name: string; startsAt: string; endsAt: string } | null;
  rosterToday: { id: string; group: string; duty: string | null; shiftName: string; status: string } | null;
  overtime: { hours: number; pending: number };
  lastPayslip: { id: string; monthLabel: string; net: number } | null;
}
interface MyRosterDay { date: string; shift: string | null; group: string | null; duty: string | null; onLeave: boolean; attendance: string | null; rosterStatus: string | null }
interface LeaveBalance { leaveTypeId: string; code: string; type: string; entitled: number; used: number; pending: number; balance: number }
interface LeaveRow { id: string; code: string; leaveType: string; fromDate: string; toDate: string; days: number; status: string; decisionNote: string | null }
interface OvertimeRow { id: string; workDate: string; hours: number; reason: string; status: string }
interface Attendance { from: string; to: string; rows: { date: string; status: string; checkIn: string | null; checkOut: string | null; source: string }[]; summary: Record<string, number> }
interface Slip { id: string; payMonth: string; monthLabel: string; gross: number; deductions: number; net: number; releasedAt: string }
interface Request { id: string; kind: string; title: string; status: string; at: string }
interface TaskRow { id: string; title: string; module: string; dueOn: string | null; priority: string; overdue: boolean; route: string | null }

const COVER = ['Team rota', 'Named colleague', 'Substitute teacher', 'Not required'];
const dayName = (d: string) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(`${d}T00:00:00Z`).getUTCDay()];

/**
 * Staff self-service: GET /me/employee, /me/roster, /me/attendance, /me/leave-balances, /me/leave-requests, /me/overtime,
 * /me/payslips, /me/requests, /me/tasks; POST check-in / check-out, leave requests (apply, withdraw) and overtime claims.
 */
export default function StaffSelfScreen() {
  const user = useUser();
  const { t } = useI18n();
  const router = useRouter();
  const { open, openRoute } = useNav();
  const { refreshing, onRefresh } = useRefresh();
  const me = useApiQuery<MyEmployee>('/me/employee');
  const linked = !(me.error instanceof ApiError && me.error.code === 'EMPLOYEE_NOT_LINKED');
  const on = !!me.data;
  const [week, setWeek] = useState<string | undefined>(undefined);
  const roster = useApiQuery<{ weekStart: string; defaultShift: string | null; days: MyRosterDay[] }>(on ? '/me/roster' : null, { weekStart: week });
  const attendance = useApiQuery<Attendance>(on ? '/me/attendance' : null);
  const balances = useApiQuery<LeaveBalance[]>(on ? '/me/leave-balances' : null);
  const leave = useApiQuery<LeaveRow[]>(on ? '/me/leave-requests' : null);
  const overtime = useApiQuery<OvertimeRow[]>(on ? '/me/overtime' : null);
  const slips = useApiQuery<Slip[]>(on ? '/me/payslips' : null);
  const tasks = useApiQuery<TaskRow[]>(on ? '/me/tasks' : null);
  const requests = useApiQuery<Request[]>(on ? '/me/requests' : null);
  const [applying, setApplying] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const checkIn = useApiMutation<void>('post', '/me/attendance/check-in', { invalidate: ['/me'], body: () => ({}), success: 'Checked in' });
  const checkOut = useApiMutation<void>('post', '/me/attendance/check-out', { invalidate: ['/me'], body: () => ({}), success: 'Checked out' });
  const cancel = useApiMutation<string>('post', (id) => `/me/leave-requests/${id}/cancel`, { invalidate: ['/me'], body: () => ({}) });

  if (me.isLoading) return <Screen><Loading /></Screen>;
  if (!linked) {
    return (
      <Screen onRefresh={onRefresh} refreshing={refreshing}>
        <Card><Empty icon="idCard" title={t('No employee record is linked to your account')}
          sub={t('Signed in as {name}. Ask HR to link your account to your employee profile to see shifts, leave and payslips.', { name: user.fullName })} /></Card>
      </Screen>
    );
  }
  if (me.error || !me.data) return <Screen onRefresh={onRefresh}><ErrorState error={me.error} onRetry={() => void me.refetch()} /></Screen>;

  const d = me.data;
  const e = d.employee;
  const shiftName = d.shift?.name ?? e.shift ?? t('No fixed shift');
  const checkedIn = !!e.checkIn;
  const onLeave = e.today === 'On Leave';
  const awaiting = (requests.data ?? []).filter((r) => r.status === 'Submitted' || r.status === 'Under Review').length;
  const overdue = (tasks.data ?? []).filter((x) => x.overdue).length;

  const doCheckOut = async () => {
    if (await confirmAction({ title: t('Check out now?'), body: t('You checked in at {time}.', { time: e.checkIn ?? '' }), confirmLabel: t('Check out'), cancelLabel: t('Cancel') })) checkOut.mutate();
  };
  const withdraw = async (r: LeaveRow) => {
    if (await confirmAction({ title: t('Withdraw {code}?', { code: r.code }), body: t('The request is cancelled and HR no longer needs to review it.'), confirmLabel: t('Withdraw'), cancelLabel: t('Cancel'), danger: true })) cancel.mutate(r.id);
  };

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      <View style={{ gap: 2 }}>
        <Txt variant="h1">{t(greetingKey())}, {firstName(e.fullName)}</Txt>
        <Txt variant="small">
          {d.rosterToday ? t('{shift} shift today — {duty}.', { shift: shiftName, duty: d.rosterToday.duty ?? d.rosterToday.group }) : t('No roster line today ({shift}).', { shift: shiftName })}
        </Txt>
      </View>
      <Row gap={space.sm} wrap>
        {!onLeave && (!checkedIn
          ? <Button variant="primary" icon="clock" label={t('Check in')} loading={checkIn.isPending} onPress={() => checkIn.mutate()} />
          : !e.checkOut && <Button icon="logout" label={t('Check out')} loading={checkOut.isPending} onPress={() => void doCheckOut()} />)}
        <Button icon="calendar" variant={!onLeave && !checkedIn ? 'secondary' : 'primary'} label={t('Apply for leave')} onPress={() => setApplying(true)} />
        <Button icon="clock" label={t('Claim overtime')} onPress={() => setClaiming(true)} />
      </Row>
      {(awaiting > 0 || overdue > 0) && (
        <Banner tone={overdue ? 'warning' : 'neutral'} icon={overdue ? 'alert' : 'clock'}>
          {[awaiting ? t('{n} requests awaiting a decision', { n: awaiting }) : '', overdue ? t('{n} tasks overdue', { n: overdue }) : ''].filter(Boolean).join(' · ')}
        </Banner>
      )}

      <KpiGrid>
        <Kpi icon="clock" label={t('Shift today')} value={shiftName.split(' ')[0]}
          foot={e.checkIn ? t('Clocked in at {time}', { time: e.checkIn }) + (e.checkOut ? ` · ${t('out {time}', { time: e.checkOut })}` : '') : onLeave ? t('On leave today') : t('Not clocked in yet')} />
        <Kpi icon="calendar" label={t('Leave balance')} value={t('{n} days', { n: e.leaveBalance })} tone="success" foot={t('Of {n} days this year', { n: e.leaveEntitled })} />
        <Kpi icon="zap" label={t('Overtime this month')} value={t('{n} h', { n: d.overtime.hours })} tone="warning"
          foot={d.overtime.pending ? t('{n} h pending approval', { n: d.overtime.pending }) : d.overtime.hours ? t('Approved') : t('No claims this month')} />
        <Kpi icon="receipt" label={t('Last payslip')} value={d.lastPayslip ? fmt.money(d.lastPayslip.net) : '—'} tone="info" foot={d.lastPayslip ? d.lastPayslip.monthLabel : t('None released yet')}
          onPress={d.lastPayslip ? () => router.push(`/payslip/${d.lastPayslip!.id}`) : undefined} />
      </KpiGrid>

      <Card title={t('My roster this week')} icon="calendar" right={(
        <Row gap={4}>
          <Pressable onPress={() => setWeek(addDays(roster.data?.weekStart ?? todayKey(), -7))} hitSlop={8} accessibilityLabel={t('Previous week')} style={styles.nav}><Icon name="chevronLeft" size={18} color={colors.brand} /></Pressable>
          <Pressable onPress={() => setWeek(addDays(roster.data?.weekStart ?? todayKey(), 7))} hitSlop={8} accessibilityLabel={t('Next week')} style={styles.nav}><Icon name="chevronRight" size={18} color={colors.brand} /></Pressable>
        </Row>
      )}>
        {roster.isLoading ? <Loading height={80} /> : roster.error ? <ErrorState error={roster.error} onRetry={() => void roster.refetch()} /> : (roster.data?.days ?? []).map((r) => (
          <View key={r.date} style={[styles.rosterRow, r.date === d.today && styles.rosterToday]}>
            <View style={{ width: 92 }}>
              <Txt variant="small" weight="semibold">{t(dayName(r.date))}</Txt>
              <Txt variant="micro">{fmt.dateShort(r.date)}</Txt>
            </View>
            <View style={{ flex: 1 }}>
              <Txt variant="small" color={colors.text}>{r.onLeave ? t('Off') : r.shift ? r.shift.replace(/^\S+\s/, '') : t('Off')}</Txt>
              <Txt variant="micro">{r.onLeave ? '—' : r.duty ?? '—'}</Txt>
            </View>
            {r.onLeave ? <StatusBadge value="Leave" /> : r.date <= d.today && r.attendance ? <StatusBadge value={r.attendance} /> : r.rosterStatus ? <StatusBadge value={r.rosterStatus} /> : null}
          </View>
        ))}
      </Card>

      <Card title={t('My requests')} icon="grid">
        {requests.isLoading ? <Loading height={60} /> : requests.error ? <ErrorState error={requests.error} onRetry={() => void requests.refetch()} /> : requests.data?.length ? requests.data.map((r) => (
          <ListItem key={r.kind + r.id} icon={r.kind === 'leave' ? 'calendar' : r.kind === 'overtime' ? 'clock' : 'fileText'} title={r.title} meta={fmt.relative(r.at)} right={<StatusBadge value={r.status} />} />
        )) : <Txt variant="small">{t('No requests yet')}</Txt>}
      </Card>

      <Card title={t('Leave')} icon="calendar" right={<Button size="sm" icon="plus" label={t('Apply')} onPress={() => setApplying(true)} />}>
        {(balances.data ?? []).map((b) => (
          <Meter key={b.leaveTypeId} label={t(b.type)} value={b.entitled ? (b.used / b.entitled) * 100 : 0} right={t('{left} of {total} left', { left: b.balance, total: b.entitled })} tone={b.balance ? 'success' : 'critical'} />
        ))}
        {leave.isLoading ? <Loading height={60} /> : leave.error ? <ErrorState error={leave.error} onRetry={() => void leave.refetch()} /> : leave.data?.length ? leave.data.slice(0, 8).map((r) => (
          <View key={r.id} style={{ gap: 4, paddingVertical: 6 }}>
            <ListItem title={`${t(r.leaveType)} · ${r.code}`}
              meta={`${fmt.dateShort(r.fromDate)}${r.toDate !== r.fromDate ? ` – ${fmt.dateShort(r.toDate)}` : ''} · ${t('{n} d', { n: r.days })}${r.decisionNote ? ` · ${r.decisionNote}` : ''}`}
              right={<StatusBadge value={r.status} />} />
            {['Submitted', 'Under Review'].includes(r.status) && (
              <Button size="sm" variant="ghost" label={t('Withdraw')} loading={cancel.isPending && cancel.variables === r.id} onPress={() => void withdraw(r)} style={{ alignSelf: 'flex-end' }} />
            )}
          </View>
        )) : <Txt variant="small">{t('No leave requests.')}</Txt>}
      </Card>

      <Card title={t('Overtime claims')} icon="clock" right={<Button size="sm" icon="plus" label={t('Claim')} onPress={() => setClaiming(true)} />}>
        {overtime.isLoading ? <Loading height={60} /> : overtime.error ? <ErrorState error={overtime.error} onRetry={() => void overtime.refetch()} /> : overtime.data?.length ? overtime.data.slice(0, 8).map((r) => (
          <ListItem key={r.id} title={`${fmt.dateShort(r.workDate)} · ${t('{n} h', { n: r.hours })}`} meta={r.reason} right={<StatusBadge value={r.status} />} />
        )) : <Txt variant="small">{t('No overtime claims.')}</Txt>}
      </Card>

      <Card title={t('Payslips')} icon="receipt">
        {slips.isLoading ? <Loading height={60} /> : slips.error ? <ErrorState error={slips.error} onRetry={() => void slips.refetch()} /> : slips.data?.length ? slips.data.slice(0, 12).map((s) => (
          <ListItem key={s.id} icon="receipt" title={s.monthLabel} meta={t('Net pay')} right={<Txt variant="body" weight="bold">{fmt.money(s.net)}</Txt>} onPress={() => router.push(`/payslip/${s.id}`)} />
        )) : <Txt variant="small">{t('No payslips released yet.')}</Txt>}
      </Card>

      <Card title={t('My attendance')} icon="checkSquare" sub={attendance.data ? `${fmt.dateShort(attendance.data.from)} – ${fmt.dateShort(attendance.data.to)}` : undefined}>
        {attendance.data && (
          <Row gap={6} wrap>
            <Badge label={t('{n} present', { n: attendance.data.summary.present ?? 0 })} tone="success" />
            <Badge label={t('{n} late', { n: attendance.data.summary.late ?? 0 })} tone="warning" />
            <Badge label={t('{n} leave', { n: attendance.data.summary.leave ?? 0 })} tone="info" />
            <Badge label={t('{n} absent', { n: attendance.data.summary.absent ?? 0 })} tone="critical" />
          </Row>
        )}
        {attendance.isLoading ? <Loading height={60} /> : attendance.error ? <ErrorState error={attendance.error} onRetry={() => void attendance.refetch()} /> : (attendance.data?.rows ?? []).slice(0, 10).map((r) => (
          <ListItem key={r.date} title={`${fmt.dateShort(r.date)} · ${t(dayName(r.date)).slice(0, 3)}`} meta={`${t('In')} ${r.checkIn ?? '—'} · ${t('Out')} ${r.checkOut ?? '—'}`} right={<StatusBadge value={r.status} />} />
        ))}
      </Card>

      <Card title={t('My tasks')} icon="checkSquare" right={<Button size="sm" variant="ghost" label={t('All')} onPress={() => open('tasks')} />}>
        {tasks.isLoading ? <Loading height={60} /> : tasks.error ? <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} /> : tasks.data?.length ? tasks.data.map((x) => (
          <ListItem key={x.id} icon="checkSquare" tone={x.overdue ? 'critical' : x.priority === 'High' ? 'warning' : 'info'} title={x.title}
            meta={`${t(x.module)} · ${x.dueOn ? t('due {date}', { date: fmt.date(x.dueOn) }) : t('No due date')}${x.overdue ? ` · ${t('overdue')}` : ''}`}
            onPress={() => (x.route ? openRoute(x.route) : open('tasks'))} />
        )) : <Empty icon="check" title={t('No open tasks')} sub={t('You are all caught up.')} />}
      </Card>

      {applying && <LeaveSheet balances={balances.data ?? []} onClose={() => setApplying(false)} />}
      {claiming && <OvertimeSheet onClose={() => setClaiming(false)} />}
    </Screen>
  );
}

function serverErrors(err: unknown, t: (s: string) => string): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  return Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => [k, t(v)]));
}

/** POST /me/leave-requests { leaveTypeId, fromDate, toDate, halfDay?, reason, coverArrangement }. */
function LeaveSheet({ balances, onClose }: { balances: LeaveBalance[]; onClose: () => void }) {
  const { t } = useI18n();
  const today = todayKey();
  const [f, setF] = useState({ leaveTypeId: '', cover: COVER[0], coverName: '', fromDate: today, toDate: today, halfDay: false, reason: '' });
  const [touched, setTouched] = useState(false);
  const submit = useApiMutation<void>('post', '/me/leave-requests', {
    invalidate: ['/me'], onSuccess: onClose, error: false,
    body: () => ({
      leaveTypeId: f.leaveTypeId, fromDate: f.fromDate, toDate: f.toDate, halfDay: f.halfDay || undefined, reason: f.reason.trim(),
      coverArrangement: f.cover === 'Named colleague' ? f.coverName.trim() : f.cover === 'Not required' ? null : f.cover,
    }),
  });
  const errors: Record<string, string> = {};
  if (!f.leaveTypeId) errors.leaveTypeId = t('Choose a leave type');
  if (f.toDate < f.fromDate) errors.toDate = t('End date must be on or after the start date');
  if (f.halfDay && f.fromDate !== f.toDate) errors.halfDay = t('A half day starts and ends on the same date');
  if (f.reason.trim().length < 3) errors.reason = t('Give a short reason');
  if (f.cover === 'Named colleague' && !f.coverName.trim()) errors.coverName = t('Name the colleague');
  const server = serverErrors(submit.error, t);
  const err = (k: string) => (touched ? errors[k] : undefined) ?? server[k];
  const selected = balances.find((b) => b.leaveTypeId === f.leaveTypeId);

  return (
    <Sheet visible onClose={onClose} title={t('Apply for leave')} sub={t('Your request goes to HR for review')}
      footer={<>
        <Button label={t('Cancel')} onPress={onClose} disabled={submit.isPending} />
        <Button label={t('Submit request')} icon="send" variant="primary" loading={submit.isPending} onPress={() => { setTouched(true); if (!Object.keys(errors).length) submit.mutate(); }} />
      </>}>
      {submit.error && !Object.keys(server).length ? <Banner tone="critical" icon="alert">{t(submit.error.message)}</Banner> : null}
      <Select label={t('Leave type')} required value={f.leaveTypeId} onChange={(v) => setF({ ...f, leaveTypeId: v })} error={err('leaveTypeId')}
        options={balances.map((b) => ({ value: b.leaveTypeId, label: t('{type} — {left} of {total} days left', { type: t(b.type), left: b.balance, total: b.entitled }) }))} />
      <DateStepper label={t('From')} value={f.fromDate} onChange={(v) => setF({ ...f, fromDate: v, toDate: v > f.toDate ? v : f.toDate })} />
      <DateStepper label={t('To')} value={f.toDate} min={f.fromDate} onChange={(v) => setF({ ...f, toDate: v })} error={err('toDate')} />
      <Pressable onPress={() => setF({ ...f, halfDay: !f.halfDay })} style={styles.toggle} accessibilityRole="checkbox" accessibilityState={{ checked: f.halfDay }}>
        <View style={[styles.box, f.halfDay && styles.boxOn]}>{f.halfDay && <Icon name="check" size={13} color={colors.textInvert} strokeWidth={3} />}</View>
        <Txt variant="body">{t('Half day')}</Txt>
      </Pressable>
      {err('halfDay') ? <Txt variant="micro" color={colors.critical}>{err('halfDay')}</Txt> : null}
      <Select label={t('Cover arrangement')} value={f.cover} onChange={(v) => setF({ ...f, cover: v })} options={COVER.map((c) => ({ value: c, label: t(c) }))} />
      {f.cover === 'Named colleague' && <Field label={t('Colleague covering')} required value={f.coverName} onChangeText={(v) => setF({ ...f, coverName: v })} error={err('coverName')} />}
      <Field label={t('Reason')} required multiline maxLength={500} value={f.reason} onChangeText={(v) => setF({ ...f, reason: v })} error={err('reason')} />
      {selected && selected.balance <= 0 && <Banner tone="warning" icon="alert">{t('No {type} left this year.', { type: t(selected.type) })}</Banner>}
    </Sheet>
  );
}

/** POST /me/overtime { workDate, hours, reason }. */
function OvertimeSheet({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const today = todayKey();
  const [f, setF] = useState({ workDate: today, hours: '', reason: '' });
  const [touched, setTouched] = useState(false);
  const h = Number(f.hours);
  const errors: Record<string, string> = {};
  if (f.workDate > today) errors.workDate = t('Choose a date up to today');
  else if (f.workDate < addDays(today, -60)) errors.workDate = t('Only the last 60 days can be claimed here');
  if (!(h > 0 && h <= 16 && Number.isInteger(h * 2))) errors.hours = t('Between 0.5 and 16, in half-hour steps');
  if (f.reason.trim().length < 3) errors.reason = t('Say what the extra hours covered');
  const save = useApiMutation<void>('post', '/me/overtime', {
    invalidate: ['/me'], success: 'Overtime claim submitted — awaiting approval', onSuccess: onClose, error: false,
    body: () => ({ workDate: f.workDate, hours: h, reason: f.reason.trim() }),
  });
  const server = serverErrors(save.error, t);
  const err = (k: string) => (touched ? errors[k] : undefined) ?? server[k];
  return (
    <Sheet visible onClose={onClose} title={t('Claim overtime')} sub={t('Approved hours are paid in the next payroll run')}
      footer={<>
        <Button label={t('Cancel')} onPress={onClose} />
        <Button label={t('Submit claim')} variant="primary" loading={save.isPending} onPress={() => { setTouched(true); if (!Object.keys(errors).length) save.mutate(); }} />
      </>}>
      {save.error && !Object.keys(server).length ? <Banner tone="critical" icon="alert">{t(save.error.message)}</Banner> : null}
      <DateStepper label={t('Date worked')} value={f.workDate} max={today} min={addDays(today, -60)} onChange={(v) => setF({ ...f, workDate: v })} error={err('workDate')} />
      <Field label={t('Hours')} required keyboardType="decimal-pad" value={f.hours} onChangeText={(v) => setF({ ...f, hours: v.replace(',', '.') })} error={err('hours')} />
      <Field label={t('Reason')} required multiline maxLength={300} value={f.reason} onChangeText={(v) => setF({ ...f, reason: v })} error={err('reason')} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  nav: { padding: 6, borderRadius: 8, backgroundColor: colors.brandTint },
  rosterRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 8, paddingHorizontal: 6, borderRadius: radius.sm },
  rosterToday: { backgroundColor: colors.brandTint },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 4 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.brand, borderColor: colors.brand },
});
