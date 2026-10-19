import { Redirect, Stack } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { Loading } from '@/components/ui';
import { ParentProvider } from '@/screens/parent/ParentContext';
import { colors } from '@/theme/theme';

/** Everything behind sign-in. Losing the session (refresh failed) sends the user back to the start. */
export default function AppLayout() {
  const { status, user } = useAuth();
  const { t, font } = useI18n();
  if (status === 'loading') return <Loading />;
  if (!user) return <Redirect href="/" />;
  return (
    <ParentProvider>
      <Stack
        screenOptions={{
          headerTransparent: false,
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.brand,
          headerTitleStyle: { fontFamily: font('bold'), color: colors.text, fontSize: 17 },
          headerBackTitleStyle: { fontFamily: font('medium') },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: t('Home') }} />
        <Stack.Screen name="view/[key]" />
        <Stack.Screen name="student/[id]" options={{ title: t('Student') }} />
        <Stack.Screen name="task/[id]" options={{ title: t('Review') }} />
        <Stack.Screen name="payslip/[id]" options={{ title: t('Payslip') }} />
        <Stack.Screen name="receipt/[id]" options={{ title: t('Receipt') }} />
        <Stack.Screen name="route/[id]" options={{ title: t('Route') }} />
        <Stack.Screen name="location/[id]" options={{ title: t('Student Tracking') }} />
        <Stack.Screen name="draft/[id]" options={{ title: t('Co-Pilot draft') }} />
      </Stack>
    </ParentProvider>
  );
}
