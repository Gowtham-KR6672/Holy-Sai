import { useMemo } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useApiMutation, useApiQuery, useRefresh } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { LeafletMap } from '@/components/map/LeafletMap';
import type { MapMarker } from '@/components/map/leafletHtml';
import { Badge, Button, Card, confirmAction, Empty, ErrorState, ListItem, Loading, Row, Screen, StatusBadge, Txt } from '@/components/ui';
import { fmt } from '@/lib/format';
import type { RouteRow } from '@/screens/staff/Transport';
import { space } from '@/theme/theme';

interface StopRow { id: string; sequence: number; name: string; latitude: number; longitude: number; pickupTime: string; dropTime: string | null; students: number; boarded: number; done: boolean }
interface RouteStudent {
  id: string; admissionNo: string; fullName: string; grade: string | null; section: string | null; stopName: string | null; pickupTime: string | null;
  boardedAt: string | null; deboardedAt: string | null; lastEvent: 'boarded' | 'deboarded' | null;
}
interface RouteDetail extends Omit<RouteRow, 'students'> {
  stopList: StopRow[];
  students: RouteStudent[];
  trail: { latitude: number; longitude: number; recordedAt: string }[];
}

/** One bus route: GET /transport/routes/:id; boarding confirmations POST /transport/boarding (transport.manage). */
export default function RouteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { can } = useAuth();
  const { t } = useI18n();
  const { refreshing, onRefresh } = useRefresh();
  const q = useApiQuery<RouteDetail>(id ? `/transport/routes/${id}` : null, undefined, { refetchInterval: 30_000 });
  const board = useApiMutation<{ studentId: string; routeId: string; eventType: 'boarded' | 'deboarded'; method: string }>('post', '/transport/boarding', {
    invalidate: ['/transport'],
  });
  const d = q.data;
  const data = useMemo(() => {
    if (!d) return { markers: [] as MapMarker[] };
    const markers: MapMarker[] = d.stopList.map((s) => ({ id: s.id, lat: Number(s.latitude), lng: Number(s.longitude), label: `${s.sequence}. ${s.name}`, kind: 'stop', tone: s.done ? 'success' : 'neutral' }));
    if (d.location) markers.push({ id: 'bus', lat: Number(d.location.latitude), lng: Number(d.location.longitude), label: d.busNo ?? d.code, kind: 'bus', tone: 'brand' });
    return { markers, path: d.trail.map((p) => [Number(p.latitude), Number(p.longitude)] as [number, number]) };
  }, [d]);

  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (q.error || !d) return <Screen><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Screen>;
  const manage = can('transport.manage') && d.runStatus !== 'Maintenance';

  const confirmEvent = async (s: RouteStudent, eventType: 'boarded' | 'deboarded') => {
    const ok = await confirmAction({
      title: eventType === 'boarded' ? t('Confirm {name} boarded?', { name: s.fullName }) : t('Confirm {name} got off?', { name: s.fullName }),
      body: t("{name}'s parents are notified immediately.", { name: s.fullName }),
      confirmLabel: eventType === 'boarded' ? t('Confirm boarding') : t('Confirm de-boarding'), cancelLabel: t('Cancel'),
    });
    if (ok) board.mutate({ studentId: s.id, routeId: d.id, eventType, method: 'Manual' });
  };

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      <Stack.Screen options={{ title: `${d.busNo ?? d.code} · ${d.name}` }} />
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Txt variant="h3" style={{ flex: 1 }}>{d.name}</Txt>
          <StatusBadge value={d.runStatus} />
        </Row>
        <Txt variant="small">{d.area} · {d.runStatus === 'Delayed' ? t('Running {n} min late', { n: d.delayMinutes }) : d.eta ? t('ETA {eta}', { eta: d.eta }) : t(d.runStatus)}</Txt>
        <Txt variant="micro">{[d.driverName ? t('Driver {name}', { name: d.driverName }) : null, d.attendantName ? t('Attendant {name}', { name: d.attendantName }) : null].filter(Boolean).join(' · ')}</Txt>
        {(data.markers.length > 0) && <LeafletMap data={data} height={240} />}
      </Card>

      <Card title={t('Stops')} icon="route">
        {d.stopList.length ? d.stopList.map((s) => (
          <ListItem key={s.id} icon={s.done ? 'check' : 'mapPin'} tone={s.done ? 'success' : undefined} title={`${s.sequence}. ${s.name}`}
            meta={`${t('pickup {time}', { time: fmt.hhmm(s.pickupTime) })}${s.dropTime ? ` · ${t('drop {time}', { time: fmt.hhmm(s.dropTime) })}` : ''} · ${t('{a}/{b} boarded', { a: s.boarded, b: s.students })}`} />
        )) : <Txt variant="small">{t('No stops on this route yet.')}</Txt>}
      </Card>

      <Card title={t('Students')} icon="users" sub={manage ? t('Confirmations notify parents') : undefined}>
        {!d.students.length ? <Empty icon="users" title={t('No students on this route')} /> : d.students.map((s) => (
          <View key={s.id} style={{ gap: 6, paddingVertical: 6 }}>
            <ListItem title={s.fullName} meta={[s.admissionNo, s.grade ? `${s.grade}${s.section ?? ''}` : null, s.stopName, s.pickupTime ? fmt.hhmm(s.pickupTime) : null].filter(Boolean).join(' · ')}
              right={s.lastEvent === 'boarded' ? <Badge label={t('On the bus')} tone="info" dot /> : s.lastEvent === 'deboarded' ? <Badge label={t('Off the bus')} tone="success" /> : <Badge label={t('Not boarded')} tone="warning" />} />
            <Row gap={space.sm} style={{ justifyContent: 'flex-end' }}>
              {s.boardedAt && <Txt variant="micro">{t('Boarded {time}', { time: fmt.time(s.boardedAt) })}</Txt>}
              {s.deboardedAt && <Txt variant="micro">{t('Off {time}', { time: fmt.time(s.deboardedAt) })}</Txt>}
              {manage && (s.lastEvent === 'boarded'
                ? <Button size="sm" icon="check" label={t('De-boarded')} loading={board.isPending && board.variables?.studentId === s.id} onPress={() => void confirmEvent(s, 'deboarded')} />
                : <Button size="sm" variant="primary" icon="check" label={t('Boarded')} loading={board.isPending && board.variables?.studentId === s.id} onPress={() => void confirmEvent(s, 'boarded')} />)}
            </Row>
          </View>
        ))}
      </Card>
    </Screen>
  );
}
