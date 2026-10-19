import { useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { useApiQuery, usePagedQuery, useRefresh } from '@/api/hooks';
import type { CurrentLocation } from '@/api/types';
import { useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { LeafletMap } from '@/components/map/LeafletMap';
import type { MapMarker } from '@/components/map/leafletHtml';
import { Badge, Banner, Card, Chips, Empty, ErrorState, Kpi, KpiGrid, ListItem, Loading, Screen, Txt } from '@/components/ui';
import { fmt } from '@/lib/format';
import { statusTone } from '@/theme/theme';

interface TrackingMarker {
  studentId: string; fullName: string; admissionNo: string; grade: string | null; section: string | null; latitude: number; longitude: number;
  locationStatus: string | null; locationStatusLabel: string; displayStatus: string; recordedAt: string | null; isStale: boolean; placeLabel: string | null;
}
interface TrackingMapData {
  summary: { total: number; active: number; paused: number; disabled: number; offline: number; noLocation: number; atSchool: number; inTransit: number; atHome: number; onTrip: number };
  markers: TrackingMarker[];
  campuses: { id: string; name: string; latitude: number; longitude: number; radiusM: number | null }[];
  staleAfterMinutes: number;
  generatedAt: string;
}
type LocF = 'All' | 'at_school' | 'in_transit' | 'at_home';

/** Student tracking overview: GET /tracking/map (summary + pins) and GET /tracking/students (paged list). */
export default function TrackingScreen() {
  const user = useUser();
  const { t } = useI18n();
  const router = useRouter();
  const { refreshing, onRefresh } = useRefresh();
  const [loc, setLoc] = useState<LocF>('All');
  const campus = user.campusId ? { campusId: user.campusId } : {};
  const filters = { ...campus, locationStatus: loc === 'All' ? undefined : loc };
  const map = useApiQuery<TrackingMapData>('/tracking/map', filters, { refetchInterval: 60_000 });
  const rows = usePagedQuery<CurrentLocation & { locationStatusLabel?: string }>('/tracking/students', { sort: 'name', dir: 'asc', page: 1, pageSize: 50, ...filters }, { refetchInterval: 60_000 });
  const s = map.data?.summary;

  const data = useMemo(() => ({
    markers: (map.data?.markers ?? []).map<MapMarker>((m) => ({
      id: m.studentId, lat: Number(m.latitude), lng: Number(m.longitude), label: m.fullName,
      tone: m.isStale ? 'warning' : m.locationStatus === 'at_school' ? 'success' : m.locationStatus === 'in_transit' ? 'info' : 'brand',
    })),
    circles: (map.data?.campuses ?? []).map((c) => ({ lat: Number(c.latitude), lng: Number(c.longitude), radius: c.radiusM ?? 350, label: c.name })),
  }), [map.data]);

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      <KpiGrid>
        <Kpi icon="users" label={t('Students tracked')} value={s ? `${s.active}/${s.total}` : '—'} tone="success" foot={s ? t('{n} paused · {m} disabled', { n: s.paused, m: s.disabled }) : undefined} />
        <Kpi icon="building" label={t('On campus')} value={s?.atSchool ?? '—'} tone="info" />
        <Kpi icon="bus" label={t('In transit')} value={s?.inTransit ?? '—'} tone="warning" foot={s ? t('{n} at home', { n: s.atHome }) : undefined} />
        <Kpi icon="alert" label={t('Offline / no update')} value={s?.offline ?? '—'} tone="critical" foot={map.data ? t('No update for {n}+ min', { n: map.data.staleAfterMinutes }) : undefined} />
      </KpiGrid>
      <Chips<LocF> items={[{ id: 'All', label: t('All') }, { id: 'at_school', label: t('On campus') }, { id: 'in_transit', label: t('In transit') }, { id: 'at_home', label: t('At home') }]} value={loc} onChange={setLoc} />
      {map.isLoading ? <Loading height={240} /> : map.error ? <Card><ErrorState error={map.error} onRetry={() => void map.refetch()} /></Card> : <LeafletMap data={data} height={300} />}
      <Card title={t('Students')} icon="users" sub={rows.data ? t('{n} students', { n: rows.data.meta.total }) : undefined}>
        {rows.isLoading ? <Loading height={80} /> : rows.error ? <ErrorState error={rows.error} onRetry={() => void rows.refetch()} /> : rows.data?.rows.length ? rows.data.rows.map((r) => (
          <ListItem key={r.studentId} icon="mapPin" title={r.fullName}
            meta={[r.admissionNo, r.grade ? `${r.grade}${r.section ?? ''}` : null, r.placeLabel ?? r.locationStatusLabel, r.recordedAt ? fmt.relative(r.recordedAt) : null].filter(Boolean).join(' · ')}
            right={<Badge label={t(r.displayStatus)} tone={statusTone(r.displayStatus)} dot />} onPress={() => router.push(`/location/${r.studentId}`)} />
        )) : <Empty icon="mapPin" title={t('No students match these filters.')} />}
      </Card>
      <Banner tone="neutral" icon="lock">{t("Every view of a student's location is recorded in the audit trail.")}</Banner>
      {map.data && <Txt variant="micro">{t('Updated {time}', { time: fmt.time(map.data.generatedAt) })}</Txt>}
    </Screen>
  );
}
