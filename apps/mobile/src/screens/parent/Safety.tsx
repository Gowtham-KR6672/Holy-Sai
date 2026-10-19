import { useState } from 'react';
import { View } from 'react-native';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import type { CurrentLocation } from '@/api/types';
import { useI18n } from '@/i18n/I18nProvider';
import {
  Avatar, Badge, Button, Card, confirmAction, Empty, ErrorState, Field, ListItem, Loading, Row, Sheet, StatusBadge, Txt,
} from '@/components/ui';
import { fmt } from '@/lib/format';
import { useNav } from '@/lib/navigation';
import { colors, space, statusTone } from '@/theme/theme';
import { overviewPath, type ChildOverview, type ChildRow, type ParentMe } from './ParentContext';
import { ParentScreen } from './ParentShell';

interface FamilySafety {
  bus: { busLocation: { latitude: number; longitude: number; recordedAt: string } | null } | null;
}

/**
 * Child safety & pickup: overview (gate today, bus, pickup persons), GET /family/children/:id/safety, the child's location,
 * POST /family/children/:id/pickup (add person) and POST /family/children/:id/pickup/:pid/confirm|revoke.
 */
export default function SafetyScreen() {
  return <ParentScreen>{({ me, child }) => <Safety me={me} child={child} />}</ParentScreen>;
}

function Safety({ me, child }: { me: ParentMe; child: ChildRow }) {
  const { t } = useI18n();
  const { open } = useNav();
  const pid = me.id;
  const ov = useApiQuery<ChildOverview>(overviewPath(pid, child.id), undefined, { refetchInterval: 60_000 });
  const extra = useApiQuery<FamilySafety>(`/family/children/${child.id}/safety`, undefined, { refetchInterval: 60_000 });
  const loc = useApiQuery<CurrentLocation>(child.canViewTracking ? `/parents/${pid}/children/${child.id}/location` : null);
  const [adding, setAdding] = useState(false);
  const empty = { personName: '', relation: '', phone: '', method: 'OTP + ID' };
  const [form, setForm] = useState(empty);
  const addPickup = useApiMutation<typeof form>('post', `/family/children/${child.id}/pickup`, {
    invalidate: [`/parents/${pid}/children/${child.id}`, `/family/children/${child.id}`], success: 'Request sent to the school office for verification',
    onSuccess: () => { setAdding(false); setForm(empty); },
  });
  const pickupAction = useApiMutation<{ id: string; action: 'confirm' | 'revoke' }>('post', (v) => `/family/children/${child.id}/pickup/${v.id}/${v.action}`, {
    invalidate: [`/parents/${pid}/children/${child.id}`, `/family/children/${child.id}`],
    success: (_r, v) => (v.action === 'confirm' ? 'Pickup person confirmed' : 'Pickup authorisation revoked'), body: () => ({}),
  });

  if (ov.isLoading) return <Loading />;
  if (ov.error || !ov.data) return <Card><ErrorState error={ov.error} onRetry={() => void ov.refetch()} /></Card>;
  const d = ov.data;
  const events = [
    ...d.gateToday.map((g) => ({ at: g.occurredAt, title: `${g.direction === 'in' ? t('Gate entry') : t('Gate exit')} — ${g.gate}`, icon: g.direction === 'in' ? 'door' : 'logout' })),
    ...(d.bus?.boardingToday ?? []).map((b) => ({ at: b.at, title: b.type === 'boarded' ? t('Boarded {bus}', { bus: d.bus?.busNo ?? t('the bus') }) : t('Exited {bus}', { bus: d.bus?.busNo ?? t('the bus') }), icon: 'bus' })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const entry = d.gateToday.find((g) => g.direction === 'in');
  const phoneOk = /^\+?[0-9 ]{8,16}$/.test(form.phone);
  const valid = form.personName.trim().length >= 2 && form.relation.trim().length >= 2 && phoneOk;

  const revoke = async (p: ChildOverview['pickup'][number]) => {
    const ok = await confirmAction({
      title: t('Revoke pickup authorisation?'),
      body: t('{person} will no longer be allowed to collect {name}.', { person: p.personName, name: child.firstName }),
      confirmLabel: t('Revoke'), cancelLabel: t('Cancel'), danger: true,
    });
    if (ok) pickupAction.mutate({ id: p.id, action: 'revoke' });
  };

  return (
    <>
      <Card title={t('Arrival today')} icon="grid">
        <ListItem icon={entry ? 'shieldCheck' : 'clock'} tone={entry ? 'success' : undefined}
          title={entry ? t('Child arrived safely') : t('Not yet at school today')}
          meta={entry ? `${entry.gate} · ${fmt.time(entry.occurredAt)} · ${t('{method} verified', { method: entry.method })}` : t('Gate entry will appear here')} />
        {events.map((e, i) => <ListItem key={`${e.at}-${i}`} icon={e.icon} title={e.title} meta={fmt.time(e.at)} />)}
      </Card>

      <Card title={t('Live location')} icon="mapPin" right={child.canViewTracking ? <Button size="sm" variant="ghost" label={t('Open map')} onPress={() => open('family-track')} /> : undefined}>
        {!child.canViewTracking ? <Txt variant="small">{t('Location sharing for this child is not enabled on your account. Please contact the school office.')}</Txt>
          : loc.data ? (
            <ListItem icon="mapPin" tone="brand" title={loc.data.placeLabel ?? loc.data.locationStatusLabel ?? '—'}
              meta={loc.data.recordedAt ? t('Updated {time}', { time: fmt.time(loc.data.recordedAt) }) : t('No location yet')}
              right={<Badge label={t(loc.data.displayStatus)} tone={statusTone(loc.data.displayStatus)} dot />} />
          ) : loc.error ? <Txt variant="small">{t('Location is not available.')}</Txt> : <Loading height={40} />}
      </Card>

      {d.bus && (
        <Card title={`${d.bus.busNo ?? t('Bus')} — ${d.bus.routeName}`} icon="bus" right={<StatusBadge value={d.bus.runStatus} />}>
          <Txt variant="body" weight="semibold">{d.bus.runStatus === 'Delayed' ? t('Running {n} min late', { n: d.bus.delayMinutes }) : d.bus.eta ? t('ETA {eta}', { eta: d.bus.eta }) : t(d.bus.runStatus)}</Txt>
          <Txt variant="small">{t('Driver {name}', { name: d.bus.driver ?? '—' })}{d.bus.attendant ? ` · ${t('Attendant {name}', { name: d.bus.attendant })}` : ''}</Txt>
          {extra.data?.bus?.busLocation && <Txt variant="small">{t('Bus position updated {time}', { time: fmt.time(extra.data.bus.busLocation.recordedAt) })}</Txt>}
          <Txt variant="small">{t('stop {stop}', { stop: d.bus.stopName ?? '—' })} · {t('pickup {time}', { time: fmt.hhmm(d.bus.pickupTime) })} · {t('drop {time}', { time: fmt.hhmm(d.bus.dropTime) })}</Txt>
        </Card>
      )}

      <Card title={t('Pickup authorisation')} sub={t('People allowed to collect your child from school')} icon="key"
        right={<Button size="sm" icon="plus" label={t('Add person')} onPress={() => setAdding(true)} />}>
        {d.pickup.length ? d.pickup.map((p) => (
          <View key={p.id} style={{ gap: space.sm, paddingVertical: space.sm }}>
            <ListItem lead={<Avatar name={p.personName} size={36} />} title={p.personName} meta={`${p.relation} · ${p.method}`} right={<StatusBadge value={p.status} />} />
            <Row gap={space.sm} style={{ justifyContent: 'flex-end' }}>
              {p.status === 'Pending' && <Button size="sm" variant="success" label={t('Confirm')} onPress={() => pickupAction.mutate({ id: p.id, action: 'confirm' })} />}
              {p.status !== 'Revoked' && <Button size="sm" icon="x" label={t('Revoke')} onPress={() => void revoke(p)} />}
            </Row>
          </View>
        )) : (
          <Empty icon="users" title={t('No authorised pickup persons')} sub={t('Add a grandparent, driver or relative so the gate can verify them.')}
            action={<Button icon="plus" label={t('Add person')} onPress={() => setAdding(true)} />} />
        )}
      </Card>

      <Sheet visible={adding} onClose={() => setAdding(false)} title={t('Add a pickup person')} sub={t('The school office verifies every new person before the first pickup.')}
        footer={<>
          <Button label={t('Cancel')} onPress={() => setAdding(false)} />
          <Button label={t('Send for verification')} variant="primary" disabled={!valid} loading={addPickup.isPending} onPress={() => addPickup.mutate(form)} />
        </>}>
        <Field label={t('Full name')} required value={form.personName} onChangeText={(v) => setForm({ ...form, personName: v })} maxLength={120} />
        <Field label={t('Relationship')} required value={form.relation} onChangeText={(v) => setForm({ ...form, relation: v })} placeholder={t('Grandfather, driver…')} maxLength={40} />
        <Field label={t('Mobile')} required keyboardType="phone-pad" value={form.phone} onChangeText={(v) => setForm({ ...form, phone: v })}
          error={form.phone && !phoneOk ? t('Enter a valid phone number') : undefined} />
        <Txt variant="micro" color={colors.textMuted}>{t('Verification method: {method}', { method: form.method })}</Txt>
      </Sheet>
    </>
  );
}
