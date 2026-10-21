import { useMemo } from 'react';
import { Image, Pressable, View } from 'react-native';
import { Tabs } from 'expo-router/js-tabs';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApiQuery } from '@/api/hooks';
import type { NotificationCounts } from '@/api/types';
import { useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { Icon } from '@/components/Icon';
import { Avatar } from '@/components/ui';
import { TAB_KEYS, tabsFor } from '@/lib/features';
import { colors } from '@/theme/theme';

/**
 * Role-based bottom tabs. Which tabs a user sees comes from the original's mobile bottom navigation
 * (shared BOTTOM_NAV) for their role; every other tab route stays registered but hidden.
 */
export default function TabsLayout() {
  const user = useUser();
  const { t, font } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabs = useMemo(() => tabsFor(user), [user]);
  const counts = useApiQuery<NotificationCounts>('/notifications/counts', undefined, { refetchInterval: 60_000 });
  const hidden = TAB_KEYS.filter((k) => !tabs.some((x) => x.key === k));

  const badgeFor = (b?: 'alerts' | 'tasks') => {
    const c = counts.data;
    if (!c || !b) return undefined;
    const n = b === 'alerts' ? c.alerts || c.unread : c.openTasks;
    return n > 0 ? (n > 99 ? '99+' : n) : undefined;
  };

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerShadowVisible: false,
        headerTitleStyle: { fontFamily: font('bold'), color: colors.text, fontSize: 17 },
        headerTitleAlign: 'left',
        headerLeft: () => (
          <View style={{ paddingLeft: 14 }}>
            <Image source={require('../../../../assets/images/logo-mark.png')} style={{ width: 28, height: 28 }} resizeMode="contain" accessibilityIgnoresInvertColors />
          </View>
        ),
        headerRight: () => (
          <Pressable onPress={() => router.push('/view/account')} style={{ paddingRight: 14 }} accessibilityRole="button" accessibilityLabel={t('My account')} hitSlop={8}>
            <Avatar name={user.fullName} size={32} />
          </Pressable>
        ),
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border, height: 60 + insets.bottom, paddingTop: 6 },
        tabBarLabelStyle: { fontFamily: font('semibold'), fontSize: 11 },
        tabBarBadgeStyle: { backgroundColor: colors.critical, fontSize: 10 },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      {tabs.map((tab) => (
        <Tabs.Screen
          key={tab.key}
          name={tab.key}
          options={{
            title: t(tab.label),
            tabBarIcon: ({ color, size }) => <Icon name={tab.icon} color={String(color)} size={Math.min(size, 24)} />,
            tabBarBadge: badgeFor(tab.badge),
            tabBarAccessibilityLabel: t(tab.label),
          }}
        />
      ))}
      {hidden.map((k) => (
        <Tabs.Screen key={k} name={k} options={{ href: null }} />
      ))}
    </Tabs>
  );
}
