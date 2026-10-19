import { useMemo, useState } from 'react';
import { Linking, View } from 'react-native';
import { useApiQuery } from '@/api/hooks';
import type { CurrentLocation } from '@/api/types';
import { useI18n } from '@/i18n/I18nProvider';
import { addDays, fmt, todayKey } from '@/lib/format';
import { colors, statusTone, space } from '@/theme/theme';
import { LeafletMap } from './map/LeafletMap';
import type { MapMarker } from './map/leafletHtml';
import { Badge, Banner, Button, Card, Col, Empty, ErrorState, Kpi, KpiGrid, ListItem, Loading, Row, Segmented, Txt } from './ui';

interface HistoryPoint {
  id: string; latitude: number; longitude: number; recordedAt: string; placeLabel?: string | null; locationStatusLabel?: string | null;
  locationStatus?: string | null; accuracy?: number | null; speed?: number | null;
}
interface History { points: HistoryPoint[]; summary?: { count: number; distanceKm: number } }

/**
 * Current location (and optionally today's / earlier movement) of one student on an OpenStreetMap map.
 * The same panel serves parents (/parents/:pid/children/:cid/location) and staff (/students/:id/location).
 */
export function LocationPanel({
  locationPath, historyPath, refetchMs = 60_000, extraMarkers = [], historyNote,
}: { locationPath: string; historyPath?: string; refetchMs?: number; extraMarkers?: MapMarker[]; historyNote?: string }) {
  const { t } = useI18n();
  const [view, setView] = useState<'current' | 'history'>('current');
  const q = useApiQuery<CurrentLocation>(locationPath, undefined, { refetchInterval: refetchMs });
  const loc = q.data;
  const hasPoint = loc?.latitude != null && loc?.longitude != null;

  const data = useMemo(() => {
    const markers: MapMarker[] = [...extraMarkers];
    if (loc && hasPoint) {
      markers.push({ id: loc.studentId, lat: Number(loc.latitude), lng: Number(loc.longitude), label: loc.fullName, tone: loc.isStale ? 'warning' : 'brand', accuracy: loc.accuracy });
    }
    const circles = loc?.campusLatitude != null && loc?.campusLongitude != null
      ? [{ lat: Number(loc.campusLatitude), lng: Number(loc.campusLongitude), radius: 350, label: loc.campusName ?? undefined }]
      : [];
    return { markers, circles, labels: true };
  }, [loc, hasPoint, extraMarkers]);

  if (q.isLoading) return <Card><Loading height={260} /></Card>;
  if (q.error || !loc) return <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} title={t('Tracking is unavailable')} /></Card>;

  return (
    <Col gap={space.md}>
      {historyPath && (
        <Segmented items={[{ id: 'current', label: t('Current') }, { id: 'history', label: t('History') }]} value={view} onChange={setView} />
      )}
      {view === 'history' && historyPath ? (
        <LocationHistory path={historyPath} note={historyNote} />
      ) : (
        <>
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Txt variant="h3">{loc.fullName}</Txt>
                <Txt variant="micro">{[loc.admissionNo, loc.grade && `${loc.grade}${loc.section ?? ''}`, loc.campusName].filter(Boolean).join(' · ')}</Txt>
              </View>
              <Badge label={t(loc.displayStatus)} tone={statusTone(loc.displayStatus)} dot />
            </Row>
            {hasPoint || extraMarkers.length ? <LeafletMap data={data} height={280} /> : (
              <Empty icon="mapPin" title={loc.trackingEnabled === false ? t('Tracking is disabled for this student.') : t('No location has been recorded for this student yet.')} />
            )}
            <Col gap={4}>
              <Detail label={t('Current Location')} value={hasPoint ? `${loc.placeLabel ?? loc.locationStatusLabel ?? '—'}${loc.isStale ? ` · ${t('last known')}` : ''}` : '—'} />
              <Detail label={t('Last Updated')} value={loc.recordedAt ? `${fmt.time(loc.recordedAt)} · ${fmt.date(loc.recordedAt)}` : '—'} />
              <Detail label={t('Accuracy')} value={loc.accuracy != null ? `± ${Math.round(loc.accuracy)} m` : '—'} />
              {loc.speed != null && <Detail label={t('Speed')} value={`${(loc.speed * 3.6).toFixed(1)} km/h`} />}
              <Detail label={t('Device battery')} value={loc.batteryPct != null ? `${Math.round(loc.batteryPct)}%` : '—'} />
            </Col>
            {loc.isStale && hasPoint && loc.trackingEnabled !== false && (
              <Banner tone="warning" icon="clock">{t('No update for more than 30 minutes. The map shows the last known location.')}</Banner>
            )}
            {loc.isSampleData && <Banner tone="info" icon="info">{t('Sample GPS coordinates for development and demonstration')}</Banner>}
            <Row gap={space.sm} wrap>
              <Button size="sm" icon="refresh" label={t('Refresh')} loading={q.isFetching} onPress={() => void q.refetch()} />
              {hasPoint && (
                <Button size="sm" icon="external" label={t('Open in maps')}
                  onPress={() => void Linking.openURL(`https://www.openstreetmap.org/?mlat=${loc.latitude}&mlon=${loc.longitude}#map=17/${loc.latitude}/${loc.longitude}`)} />
              )}
            </Row>
          </Card>
        </>
      )}
    </Col>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <Row style={{ justifyContent: 'space-between' }} gap={space.md}>
      <Txt variant="small">{label}</Txt>
      <Txt variant="small" weight="semibold" color={colors.text} style={{ flexShrink: 1, textAlign: 'right' }}>{value}</Txt>
    </Row>
  );
}

function LocationHistory({ path, note }: { path: string; note?: string }) {
  const { t } = useI18n();
  const [date, setDate] = useState(todayKey());
  const q = useApiQuery<History>(path, { date });
  const points = q.data?.points ?? [];
  const data = useMemo(() => ({
    markers: points.length
      ? [
        { id: 'start', lat: points[0].latitude, lng: points[0].longitude, label: fmt.time(points[0].recordedAt), tone: 'neutral' as const, kind: 'stop' as const },
        { id: 'end', lat: points[points.length - 1].latitude, lng: points[points.length - 1].longitude, label: fmt.time(points[points.length - 1].recordedAt), tone: 'brand' as const },
      ]
      : [],
    path: points.map((p) => [Number(p.latitude), Number(p.longitude)] as [number, number]),
  }), [points]);

  return (
    <Col gap={space.md}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Button size="sm" icon="chevronLeft" label={t('Earlier')} onPress={() => setDate(addDays(date, -1))} />
        <Txt variant="h3">{fmt.date(date)}</Txt>
        <Button size="sm" icon="chevronRight" label={t('Later')} disabled={date >= todayKey()} onPress={() => setDate(addDays(date, 1))} />
      </Row>
      {note ? <Txt variant="micro">{note}</Txt> : null}
      {q.isLoading ? <Loading height={240} /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <>
          {points.length > 0 && <LeafletMap data={data} height={260} />}
          <KpiGrid>
            <Kpi label={t('Points')} value={q.data?.summary?.count ?? points.length} />
            <Kpi label={t('Distance')} value={q.data?.summary ? `${q.data.summary.distanceKm} km` : '—'} />
          </KpiGrid>
          <Card flush>
            <View style={{ paddingHorizontal: space.lg }}>
              {!points.length ? (
                <Empty icon="mapPin" title={t('No locations recorded')} sub={t('There is no movement recorded for this date.')} />
              ) : [...points].reverse().slice(0, 60).map((p) => (
                <ListItem key={p.id} icon="mapPin" title={fmt.time(p.recordedAt)}
                  meta={[p.placeLabel ?? '—', p.accuracy != null ? `± ${Math.round(p.accuracy)} m` : null].filter(Boolean).join(' · ')}
                  right={p.locationStatusLabel ? <Badge label={t(p.locationStatusLabel)} tone={p.locationStatus === 'at_school' ? 'success' : p.locationStatus === 'in_transit' ? 'warning' : 'neutral'} /> : undefined} />
              ))}
            </View>
          </Card>
        </>
      )}
    </Col>
  );
}
