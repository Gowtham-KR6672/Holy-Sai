import { Stack, useLocalSearchParams } from 'expo-router';
import { useI18n } from '@/i18n/I18nProvider';
import { Card, Empty, Screen } from '@/components/ui';
import { FEATURES, type FeatureKey } from '@/lib/features';
import { FeatureScreen } from '@/screens/FeatureScreen';

/** Any feature opened on the stack (from "More", notifications, tasks or another screen) rather than as a tab. */
export default function FeatureView() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const { t } = useI18n();
  const known = !!key && Object.prototype.hasOwnProperty.call(FEATURES, key);
  if (!known) {
    return (
      <Screen>
        <Stack.Screen options={{ title: t('Not found') }} />
        <Card><Empty icon="search" title={t('This screen is not available in the app')} /></Card>
      </Screen>
    );
  }
  const k = key as FeatureKey;
  return (
    <>
      <Stack.Screen options={{ title: t(FEATURES[k].label) }} />
      <FeatureScreen k={k} />
    </>
  );
}
