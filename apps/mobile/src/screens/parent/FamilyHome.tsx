import { StyleSheet, View } from 'react-native';
import { useApiQuery } from '@/api/hooks';
import type { StudentProfile } from '@/api/types';
import { useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { Icon } from '@/components/Icon';
import {
  Avatar, Badge, Button, Card, ErrorState, ListItem, Loading, Meter, MiniBars, Row, StatusBadge, Txt,
} from '@/components/ui';
import { firstName, fmt, greetingKey, todayKey } from '@/lib/format';
import { useNav } from '@/lib/navigation';
import { colors, radius, space } from '@/theme/theme';
import { overviewPath, type ChildOverview, type ChildRow, type ParentMe } from './ParentContext';
import { ParentScreen, TODAY_LABEL, todayTone, trackLabel } from './ParentShell';

interface FamilyCircular { id: string; title: string; publishedAt: string; audience: string; requiresAck: boolean; acknowledged: boolean; body?: string }

/** Parent home: GET /parents/me, /parents/:pid/children/:cid/overview, /students/:cid/profile, /family/circulars. */
export default function FamilyHomeScreen() {
  return <ParentScreen>{({ me, child }) => <ChildHome me={me} child={child} />}</ParentScreen>;
}

function ChildHome({ me, child }: { me: ParentMe; child: ChildRow }) {
  const user = useUser();
  const { t } = useI18n();
  const { open, openRoute } = useNav();
  const ov = useApiQuery<ChildOverview>(overviewPath(me.id, child.id), undefined, { refetchInterval: 60_000 });
  const prof = useApiQuery<StudentProfile>(`/students/${child.id}/profile`);
  const circulars = useApiQuery<FamilyCircular[]>('/family/circulars');
  const pendingAck = circulars.data?.filter((c) => c.requiresAck && !c.acknowledged).length ?? 0;
  const d = ov.data;
  const entry = d?.gateToday.find((g) => g.direction === 'in');
  const exit = d ? [...d.gateToday].reverse().find((g) => g.direction === 'out') : undefined;
  const due = d?.fees.outstanding ?? 0;
  const openHw = (d?.homework ?? []).filter((h) => !h.submitted).sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  const subjects = prof.data?.academics.subjects ?? [];
  const achievement = prof.data?.achievements[0];

  return (
    <>
      <View style={{ gap: 2 }}>
        <Txt variant="h1">{t(greetingKey())}, {firstName(user.fullName || me.fullName)}</Txt>
        <Txt variant="small">{t("Here's {name}'s day at a glance — attendance, travel, learning and fees.", { name: child.firstName })}</Txt>
      </View>

      <Card>
        <Row gap={space.md} style={{ alignItems: 'flex-start' }}>
          <Avatar name={child.fullName} size={56} />
          <View style={{ flex: 1, gap: 4 }}>
            <Txt variant="h2">{child.fullName}</Txt>
            <Badge label={t(TODAY_LABEL[child.today] ?? child.today)} tone={todayTone(child.today)} dot />
            <Txt variant="small">
              {[`${child.grade} ${child.section}`, child.admissionNo, child.campusName, child.house ? t('{house} House', { house: child.house }) : null].filter(Boolean).join(' · ')}
            </Txt>
            <Row gap={space.md} wrap>
              <Row gap={4}><Icon name="bus" size={13} color={colors.textMuted} /><Txt variant="micro">{child.busRoute ?? t('Own transport')}</Txt></Row>
              {child.trackingStatus ? <Row gap={4}><Icon name="mapPin" size={13} color={colors.textMuted} /><Txt variant="micro">{t(trackLabel(child.trackingStatus))}</Txt></Row> : null}
              {pendingAck > 0 && <Row gap={4}><Icon name="fileText" size={13} color={colors.warning} /><Txt variant="micro" color={colors.warningText}>{t('{n} circulars to acknowledge', { n: pendingAck })}</Txt></Row>}
            </Row>
          </View>
        </Row>
        <View style={styles.stats}>
          <Stat label={t('Today')} tone={exit || entry ? 'good' : child.today === 'absent' ? 'bad' : undefined}
            value={ov.isLoading ? '…' : exit ? t('Left {time}', { time: fmt.time(exit.occurredAt) }) : entry ? t('In {time}', { time: fmt.time(entry.occurredAt) }) : child.today === 'absent' ? t('Absent') : t('Not in yet')}
            foot={entry ? `${entry.gate} · ${entry.method}` : t('You are notified on arrival')} />
          <Stat label={t('Attendance')} tone={child.attendance != null && child.attendance < 85 ? 'bad' : undefined}
            value={child.attendance != null ? `${child.attendance}%` : '—'} foot={t('this academic year')} />
          <Stat label={t('Average')} value={child.average != null ? String(child.average) : '—'}
            foot={child.average != null ? t('{trend} trend', { trend: `${(child.trend ?? 0) >= 0 ? '+' : ''}${child.trend ?? 0}` }) : t('No results yet')} />
          <Stat label={t('Fees due')} tone={!d ? undefined : due > 0 ? 'bad' : 'good'} value={!d ? '—' : due > 0 ? fmt.money(due, { compact: true }) : t('Cleared')}
            foot={!d ? '' : due > 0 ? (d.fees.nextDue ? t('next due {date}', { date: fmt.date(d.fees.nextDue) }) : t('outstanding')) : t('nothing to pay')} />
        </View>
        <Row gap={space.sm} wrap>
          {due > 0 && <Button size="sm" variant="primary" icon="creditCard" label={`${t('Pay Now')} · ${fmt.money(due, { compact: true })}`} onPress={() => open('family-fees', { pay: '1' })} />}
          {child.canViewTracking && <Button size="sm" variant={due > 0 ? 'secondary' : 'primary'} icon="mapPin" label={t('Track {name}', { name: child.firstName })} onPress={() => open('family-track')} />}
          <Button size="sm" icon="message" label={t('Message teacher')} onPress={() => open('messages', { compose: 'teacher' })} />
        </Row>
      </Card>

      {ov.error ? <Card><ErrorState error={ov.error} onRetry={() => void ov.refetch()} /></Card> : !d ? <Loading /> : (
        <>
          <Card title={t('Today')} sub={fmt.date(new Date())} icon="grid">
            <ListItem
              icon={exit ? 'logout' : entry ? 'shieldCheck' : 'clock'}
              tone={entry ? 'success' : child.today === 'absent' ? 'critical' : undefined}
              title={exit ? t('Left campus at {time}', { time: fmt.time(exit.occurredAt) }) : entry ? t('Arrived safely at {time}', { time: fmt.time(entry.occurredAt) }) : child.today === 'absent' ? t('Marked absent today') : t('No gate entry yet today')}
              meta={entry ? t('{gate} · {method} verified', { gate: entry.gate, method: entry.method }) : t('You will be notified when your child reaches school')}
              onPress={() => open('safety')}
            />
            {d.bus && (
              <ListItem icon="bus" tone={d.bus.runStatus === 'Delayed' ? 'warning' : 'brand'}
                title={`${d.bus.busNo ?? t('Bus')} · ${d.bus.routeName}`}
                meta={`${d.bus.runStatus === 'Delayed' ? t('Running {n} min late', { n: d.bus.delayMinutes }) : d.bus.eta ? t('ETA {eta}', { eta: d.bus.eta }) : t(d.bus.runStatus)} · ${t('stop {stop}', { stop: d.bus.stopName ?? '—' })} · ${t('pickup {time}', { time: fmt.hhmm(d.bus.pickupTime) })}`}
                right={<StatusBadge value={d.bus.runStatus} />} onPress={() => open('safety')} />
            )}
            <ListItem icon="mapPin" tone={child.trackingStatus === 'active' ? 'success' : undefined} title={t('Open live location')}
              meta={`${child.firstName} · ${child.locationRecordedAt ? t('Last update {when}', { when: fmt.relative(child.locationRecordedAt) }) : child.trackingStatus === 'disabled' ? t('Tracking is not enabled') : t('No location yet')}`}
              onPress={() => open('family-track')} />
          </Card>

          <Card title={t('Fees')} icon="wallet">
            <Txt variant="micro">{t('Total outstanding')}</Txt>
            <Txt variant="display" color={d.fees.outstanding > 0 ? colors.critical : colors.success}>{fmt.money(d.fees.outstanding)}</Txt>
            <Txt variant="small">{d.fees.outstanding > 0 ? (d.fees.nextDue ? t('Next instalment due {date}', { date: fmt.date(d.fees.nextDue) }) : t('Payment pending')) : t('All dues cleared — thank you')}</Txt>
            {d.fees.outstanding > 0
              ? <Button variant="primary" icon="creditCard" label={t('Pay Now')} onPress={() => open('family-fees', { pay: '1' })} block />
              : <Button icon="receipt" label={t('View receipts')} onPress={() => open('family-fees')} block />}
          </Card>

          <Card title={t('Homework')} sub={openHw.length ? t('{n} to hand in', { n: openHw.length }) : t('All handed in')} icon="edit"
            right={<Button size="sm" variant="ghost" label={t('All')} onPress={() => open('family-academics')} />}>
            {openHw.length ? openHw.slice(0, 4).map((h) => (
              <ListItem key={h.id} icon="edit" tone={h.dueOn <= todayKey() ? 'warning' : undefined} title={h.title}
                meta={`${h.subject} · ${t('due {date}', { date: fmt.dateShort(h.dueOn) })}`} right={<Badge label={t('Open')} tone="info" />} />
            )) : <Txt variant="small">{t('Nothing due right now. New homework appears here as soon as a teacher sets it.')}</Txt>}
          </Card>

          <Card title={t('Latest updates')} icon="bell" right={<Button size="sm" variant="ghost" label={t('All')} onPress={() => open('notifications')} />}>
            {d.notifications.length ? d.notifications.slice(0, 4).map((n) => (
              <ListItem key={n.id} icon={n.icon} tone={n.tone === 'critical' ? 'critical' : n.tone === 'warning' ? 'warning' : undefined}
                title={n.title} meta={fmt.relative(n.createdAt)} onPress={n.route ? () => openRoute(n.route) : undefined} />
            )) : <Txt variant="small">{t('No new updates. School notices and alerts about {name} will appear here.', { name: child.firstName })}</Txt>}
          </Card>
        </>
      )}

      <Card title={t('Academic progress')} icon="trending" right={<Button size="sm" variant="ghost" label={t('See all')} onPress={() => open('family-academics')} />}>
        {prof.isLoading ? <Loading height={80} /> : subjects.length ? subjects.slice(0, 4).map((s) => (
          <Meter key={s.name} label={s.name} value={s.score} right={`${s.score} · ${s.grade}`} tone={s.score >= 80 ? 'success' : s.score >= 70 ? 'info' : 'warning'} />
        )) : <Txt variant="small">{t('Results will appear after the first assessment.')}</Txt>}
      </Card>

      {(prof.data?.attendance.months.length ?? 0) > 1 && (
        <Card title={t("{name}'s Attendance", { name: child.firstName })} icon="checkSquare">
          <MiniBars points={prof.data!.attendance.months.slice(-6)} />
        </Card>
      )}

      {achievement && (
        <Card title={t('Achievements')} icon="award">
          <ListItem icon="award" tone="brand" title={achievement.title}
            meta={`${fmt.date(achievement.date)} · ${achievement.verified ? t('verified by the school') : t('awaiting verification')}`} />
        </Card>
      )}

      <Card title={t('Quick actions')} icon="grid">
        <ListItem icon="megaphone" title={t('Circulars & acknowledgements')} meta={pendingAck ? t('{n} need your acknowledgement', { n: pendingAck }) : undefined} onPress={() => open('circulars')} />
        <ListItem icon="calendar" title={t('Parent–teacher meetings')} onPress={() => open('ptm')} />
        <ListItem icon="shield" title={t('Safety & Pickup')} onPress={() => open('safety')} />
        <ListItem icon="message" title={t('Message Teacher')} onPress={() => open('messages')} />
      </Card>
    </>
  );
}

function Stat({ label, value, foot, tone }: { label: string; value: string; foot?: string; tone?: 'good' | 'bad' }) {
  return (
    <View style={styles.stat}>
      <Txt variant="micro">{label}</Txt>
      <Txt variant="h3" color={tone === 'good' ? colors.success : tone === 'bad' ? colors.critical : colors.text} numberOfLines={1}>{value}</Txt>
      {foot ? <Txt variant="micro" numberOfLines={1}>{foot}</Txt> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  stat: { flexGrow: 1, flexBasis: '46%', backgroundColor: colors.bg, borderRadius: radius.md, padding: space.md, gap: 2 },
});
