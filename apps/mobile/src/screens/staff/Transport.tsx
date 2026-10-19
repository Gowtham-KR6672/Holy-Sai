import { useMemo } from 'react';
import { useRouter } from 'expo-router';
import { useApiQuery, useRefresh } from '@/api/hooks';
import { useAuth, useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { LeafletMap } from '@/components/map/LeafletMap';
import type { MapMarker } from '@/components/map/leafletHtml';
import { Badge, Card, Empty, ErrorState, Kpi, KpiGrid, Loading, Row, Screen, SectionTitle, StatusBadge, Txt } from '@/components/ui';
import { fmt } from '@/lib/format';

export interface RouteRow {
  id: string; code: string; name: string; area: string; campusName: string; runStatus: string; delayMinutes: number; eta: string | null;
  busNo: string | null; registrationNo: string | null; driverName: string | null; driverPhone: string | null; attendantId: string | null; attendantName: string | null;
  students: number; stops: number; stopsDone: number; boardedToday: number; deboardedToday: number; onboardNow: number;
  alerts: { tone: string; text?: string; title?: string }[];
  location: { latitude: number; longitude: number; speedKmph: number | null; recordedAt: string } | null;
}
interface RoutesResponse {
  routes: RouteRow[];
  summary: { buses: number; students: number; onboardNow: number; atCampus: number; moving: number; delayed: number; maintenance: number; alerts: number };
  generatedAt: string;
}

/**
 * Transport: GET /transport/routes (buses, live positions, onboard counts). Routes where the signed-in employee is the
 * attendant come first ("My route"); opening a route lets transport.manage confirm boarding.
 */
export default function TransportScreen() {
  const user = useUser();
  const { can } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const { refreshing, onRefresh } = useRefresh();
  const campus = user.campusId ? { campusId: user.campusId } : {};
  const q = useApiQuery<RoutesResponse>('/transport/routes', campus, { refetchInterval: 30_000 });
  const routes = q.data?.routes ?? [];
  const mine = routes.filter((r) => user.employeeId && r.attendantId === user.employeeId);
  const others = routes.filter((r) => !mine.includes(r));
  const markers = useMemo<MapMarker[]>(() => routes.filter((r) => r.location).map((r) => ({
    id: r.id, lat: Number(r.location!.latitude), lng: Number(r.location!.longitude), label: r.busNo ?? r.code, kind: 'bus',
    tone: r.alerts.some((a) => a.tone === 'critical') ? 'critical' : r.runStatus === 'Delayed' ? 'warning' : 'success',
  })), [routes]);

  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (q.error) return <Screen onRefresh={onRefresh}><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Screen>;
  const s = q.data!.summary;

  const RouteCard = ({ r }: { r: RouteRow }) => (
    <Card onPress={() => router.push(`/route/${r.id}`)}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Txt variant="h3" style={{ flex: 1 }}>{r.busNo ?? r.code} · {r.name}</Txt>
        <StatusBadge value={r.runStatus} />
      </Row>
      <Txt variant="small">{r.area} · {r.runStatus === 'Delayed' ? t('Running {n} min late', { n: r.delayMinutes }) : r.eta ? t('ETA {eta}', { eta: r.eta }) : t(r.runStatus)}</Txt>
      <Row gap={6} wrap>
        <Badge label={t('{n} students', { n: r.students })} />
        <Badge label={t('{n} onboard', { n: r.onboardNow })} tone="info" />
        <Badge label={t('Stops {done}/{total}', { done: r.stopsDone, total: r.stops })} />
        {r.alerts.length > 0 && <Badge label={t('{n} alerts', { n: r.alerts.length })} tone="critical" icon="alert" />}
      </Row>
      <Txt variant="micro">{[r.driverName ? t('Driver {name}', { name: r.driverName }) : null, r.attendantName ? t('Attendant {name}', { name: r.attendantName }) : null, r.location ? t('Updated {time}', { time: fmt.time(r.location.recordedAt) }) : null].filter(Boolean).join(' · ')}</Txt>
    </Card>
  );

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      <KpiGrid>
        <Kpi icon="bus" label={t('Buses')} value={s.buses} foot={t('{n} moving · {m} delayed', { n: s.moving, m: s.delayed })} />
        <Kpi icon="users" label={t('Onboard now')} value={s.onboardNow} tone="info" foot={t('{n} at campus', { n: s.atCampus })} />
      </KpiGrid>
      {markers.length > 0 && <LeafletMap data={{ markers, labels: true }} height={240} />}
      {!routes.length ? <Card><Empty icon="bus" title={t('No routes for this campus')} sub={t('Routes are set up in the web portal route planner.')} /></Card> : (
        <>
          {mine.length > 0 && <SectionTitle>{t('My route')}</SectionTitle>}
          {mine.map((r) => <RouteCard key={r.id} r={r} />)}
          {mine.length > 0 && others.length > 0 && <SectionTitle>{t('All routes')}</SectionTitle>}
          {others.map((r) => <RouteCard key={r.id} r={r} />)}
        </>
      )}
      {can('transport.manage') && <Txt variant="micro">{t('Open a route to confirm boarding and de-boarding. Parents are notified immediately.')}</Txt>}
      <Txt variant="micro">{t('Updated {time}', { time: fmt.time(q.data!.generatedAt) })}</Txt>
    </Screen>
  );
}
