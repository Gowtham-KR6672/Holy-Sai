import { useMemo } from 'react';
import { useApiQuery } from '@/api/hooks';
import { useI18n } from '@/i18n/I18nProvider';
import { LocationPanel } from '@/components/LocationPanel';
import type { MapMarker } from '@/components/map/leafletHtml';
import { Banner, Card, Empty, Txt } from '@/components/ui';
import { fmt } from '@/lib/format';
import type { ChildRow, ParentMe } from './ParentContext';
import { ParentScreen } from './ParentShell';

interface FamilySafety {
  bus: { busLocation: { latitude: number; longitude: number; recordedAt: string } | null; busNo?: string | null; routeName?: string | null } | null;
}

/** Live child location (GET /parents/:pid/children/:cid/location, history) and the bus position (GET /family/children/:id/safety). */
export default function FamilyTrackScreen() {
  return <ParentScreen>{({ me, child }) => <Track me={me} child={child} />}</ParentScreen>;
}

function Track({ me, child }: { me: ParentMe; child: ChildRow }) {
  const { t } = useI18n();
  const safety = useApiQuery<FamilySafety>(`/family/children/${child.id}/safety`, undefined, { refetchInterval: 30_000 });
  const bus = safety.data?.bus?.busLocation;
  const busMarkers = useMemo<MapMarker[]>(
    () => (bus ? [{ id: 'bus', lat: Number(bus.latitude), lng: Number(bus.longitude), label: safety.data?.bus?.busNo ?? t('Bus'), tone: 'warning', kind: 'bus' }] : []),
    [bus, safety.data, t],
  );

  return (
    <>
      <Txt variant="h2">{t('Track {name}', { name: child.firstName })}</Txt>
      {child.canViewTracking ? (
        <LocationPanel
          locationPath={`/parents/${me.id}/children/${child.id}/location`}
          historyPath={`/parents/${me.id}/children/${child.id}/location/history`}
          historyNote={t("You can review the last 7 days of your child's movements.")}
          refetchMs={30_000}
          extraMarkers={busMarkers}
        />
      ) : (
        <Card>
          <Empty icon="lock" title={t('Tracking is not available')} sub={t('Location sharing for this child is not enabled on your account. Please contact the school office.')} />
        </Card>
      )}
      {bus && <Txt variant="micro">{t('Bus position updated {time}', { time: fmt.time(bus.recordedAt) })}</Txt>}
      <Banner tone="neutral" icon="lock">{t("Only you and authorised school staff can see this location. Every view is recorded in the school's audit trail.")}</Banner>
    </>
  );
}
