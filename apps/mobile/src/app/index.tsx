import { Image, StyleSheet, View } from 'react-native';
import { Redirect } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { Button, Loading, Txt } from '@/components/ui';
import { tabsFor } from '@/lib/features';
import { colors, space } from '@/theme/theme';

/** Launch: restore the saved session from the secure refresh token, then go to the role's home tab. */
export default function Index() {
  const { status, user, restoreError, retryRestore, forget } = useAuth();
  const { t } = useI18n();

  if (status === 'loading') {
    return (
      <View style={styles.center}>
        <Image source={require('../../assets/images/logo-mark.png')} style={styles.logo} resizeMode="contain" accessibilityIgnoresInvertColors />
        <Loading label={t('Opening your campus…')} height={80} />
      </View>
    );
  }
  if (status === 'unreachable') {
    return (
      <View style={styles.center}>
        <Image source={require('../../assets/images/logo-mark.png')} style={styles.logo} resizeMode="contain" accessibilityIgnoresInvertColors />
        <Txt variant="h2" center>{t('Cannot reach the school server')}</Txt>
        <Txt variant="small" center>{restoreError ? t(restoreError) : t('Check your internet connection and try again.')}</Txt>
        <Button label={t('Try again')} icon="refresh" variant="primary" onPress={() => void retryRestore()} />
        <Button label={t('Sign in with another account')} variant="ghost" onPress={() => void forget()} />
      </View>
    );
  }
  if (!user) return <Redirect href="/sign-in" />;
  const first = tabsFor(user)[0];
  return <Redirect href={`/${first.key}`} />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl, backgroundColor: colors.bg },
  logo: { width: 88, height: 88 },
});
