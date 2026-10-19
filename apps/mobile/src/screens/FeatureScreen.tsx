import { useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { Card, Empty, Screen } from '@/components/ui';
import { canUseFeature, type FeatureKey } from '@/lib/features';
import { SCREENS } from './registry';

/** Renders a feature's screen when the signed-in role may use it. */
export function FeatureScreen({ k }: { k: FeatureKey }) {
  const user = useUser();
  const { t } = useI18n();
  if (!canUseFeature(user, k)) {
    return (
      <Screen>
        <Card><Empty icon="lock" title={t('You do not have access to this')} sub={t('Your role does not include this information. Contact the school office if you need it.')} /></Card>
      </Screen>
    );
  }
  const C = SCREENS[k];
  return <C />;
}
