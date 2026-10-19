import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { visibleNav } from '@holysai/shared';
import { useAuth, useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { Icon } from '@/components/Icon';
import { Avatar, Card, confirmAction, Divider, ListItem, Row, Screen, SectionTitle, Txt } from '@/components/ui';
import { canUseFeature, FEATURES, featureForWebPath, type FeatureKey } from '@/lib/features';
import { useNav } from '@/lib/navigation';
import { colors, radius, space } from '@/theme/theme';

/** Native features in the order they are offered as shortcuts. */
const SHORTCUTS: FeatureKey[] = [
  'family', 'family-track', 'family-academics', 'family-fees', 'circulars', 'messages', 'ptm', 'safety',
  'me', 'my-ideas', 'teacher', 'attendance', 'homework', 'copilot', 'command-center', 'students', 'tracking',
  'admissions', 'fees', 'staff-self', 'transport', 'gate', 'notifications', 'tasks',
];

/**
 * "More": every other feature the role has permission for. Features with a native screen open in the app;
 * the rest of the original's menu (filtered by the same permissions as the web sidebar) opens in the web portal.
 */
export default function MoreScreen() {
  const user = useUser();
  const { signOut } = useAuth();
  const { t, lang, langs, setLang } = useI18n();
  const { open, openWeb, tabs } = useNav();
  const router = useRouter();
  const [expanded, setExpanded] = useState<string | null>(null);

  const shortcuts = useMemo(
    () => SHORTCUTS.filter((k) => canUseFeature(user, k) && !tabs.some((x) => x.key === k)),
    [user, tabs],
  );
  const groups = useMemo(() => visibleNav(user.role.key, user.permissions), [user]);

  const openNavItem = (to: string) => {
    const key = featureForWebPath(to);
    if (key && canUseFeature(user, key)) open(key);
    else openWeb(to);
  };

  const doSignOut = async () => {
    const ok = await confirmAction({ title: t('Sign out?'), body: t('You will need your password to sign in again on this device.'), confirmLabel: t('Sign out'), cancelLabel: t('Cancel') });
    if (!ok) return;
    await signOut();
    router.replace('/sign-in');
  };

  return (
    <Screen>
      <Card onPress={() => open('account')}>
        <Row gap={space.md}>
          <Avatar name={user.fullName} size={48} />
          <View style={{ flex: 1 }}>
            <Txt variant="h3">{user.fullName}</Txt>
            <Txt variant="small">{t(user.role.name)}{user.campus_name ? ` · ${user.campus_name}` : ''}</Txt>
          </View>
          <Icon name="chevronRight" size={18} color={colors.textFaint} />
        </Row>
      </Card>

      {shortcuts.length > 0 && (
        <>
          <SectionTitle>{t('In the app')}</SectionTitle>
          <View style={styles.grid}>
            {shortcuts.map((k) => (
              <Pressable key={k} onPress={() => open(k)} style={({ pressed }) => [styles.tile, pressed && { opacity: 0.8 }]} accessibilityRole="button">
                <View style={styles.tileIcon}><Icon name={FEATURES[k].icon} size={20} color={colors.brand} /></View>
                <Txt variant="small" weight="semibold" color={colors.text} center numberOfLines={2}>{t(FEATURES[k].label)}</Txt>
              </Pressable>
            ))}
          </View>
        </>
      )}

      <SectionTitle>{t('All features')}</SectionTitle>
      <Txt variant="micro">{t('Items marked with ↗ open in the web portal; sign in there with the same account.')}</Txt>
      <Card flush>
        {groups.map((g, gi) => {
          const id = `${g.group}-${gi}`;
          const isOpen = expanded === id;
          return (
            <View key={id}>
              {gi > 0 && <Divider />}
              <Pressable onPress={() => setExpanded(isOpen ? null : id)} style={styles.groupHead} accessibilityRole="button" accessibilityState={{ expanded: isOpen }}>
                <View style={styles.groupIcon}><Icon name={g.icon} size={16} color={colors.brand} /></View>
                <Txt variant="body" weight="semibold" style={{ flex: 1 }}>{t(g.label ?? g.group)}</Txt>
                <Txt variant="micro">{g.items.length}</Txt>
                <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size={16} color={colors.textMuted} />
              </Pressable>
              {isOpen && (
                <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
                  {g.items.map((it) => {
                    const key = it.dynamicHome ? null : featureForWebPath(it.to);
                    const native = it.dynamicHome || (key ? canUseFeature(user, key) : false);
                    return (
                      <ListItem
                        key={`${it.to}-${it.label}`}
                        icon={it.icon}
                        title={t(it.label)}
                        onPress={() => (it.dynamicHome ? router.navigate(`/${tabs[0].key}`) : openNavItem(it.to))}
                        right={native ? <Icon name="chevronRight" size={16} color={colors.textFaint} /> : <Txt variant="small" color={colors.textMuted}>↗</Txt>}
                      />
                    );
                  })}
                </View>
              )}
            </View>
          );
        })}
      </Card>

      <SectionTitle>{t('Language')}</SectionTitle>
      <View style={styles.langs}>
        {langs.map((l) => {
          const on = l.id === lang;
          return (
            <Pressable key={l.id} onPress={() => setLang(l.id)} style={[styles.lang, on && styles.langOn]} accessibilityRole="radio" accessibilityState={{ checked: on }}>
              <Txt variant="body" weight="semibold" color={on ? colors.textInvert : colors.text}>{l.label}</Txt>
            </Pressable>
          );
        })}
      </View>

      <Card flush>
        <View style={{ paddingHorizontal: space.lg }}>
          <ListItem icon="settings" title={t('My account')} onPress={() => open('account')} />
          <Divider />
          <ListItem icon="logout" tone="critical" title={t('Sign out')} onPress={() => void doSignOut()} chevron={false} />
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tile: {
    width: '31.5%', flexGrow: 1, alignItems: 'center', gap: 6, paddingVertical: space.md, paddingHorizontal: 6, backgroundColor: colors.surface,
    borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  tileIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: colors.brandTint, alignItems: 'center', justifyContent: 'center' },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: 14 },
  groupIcon: { width: 30, height: 30, borderRadius: 9, backgroundColor: colors.brandTint, alignItems: 'center', justifyContent: 'center' },
  langs: { flexDirection: 'row', gap: space.sm },
  lang: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface },
  langOn: { backgroundColor: colors.brand, borderColor: colors.brand },
});
