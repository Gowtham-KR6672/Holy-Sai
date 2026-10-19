import { useLocalSearchParams } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { LocationPanel } from '@/components/LocationPanel';
import { Banner, Screen } from '@/components/ui';

/** A student's location for staff: GET /students/:id/location (every view is audited server-side). */
export default function StudentLocation() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { can } = useAuth();
  const { t } = useI18n();
  return (
    <Screen>
      {id ? (
        <LocationPanel
          locationPath={`/students/${id}/location`}
          historyPath={can('tracking.history') ? `/students/${id}/location/history` : undefined}
          refetchMs={60_000}
        />
      ) : null}
      <Banner tone="neutral" icon="lock">{t("Every view of a student's location is recorded in the audit trail.")}</Banner>
    </Screen>
  );
}
