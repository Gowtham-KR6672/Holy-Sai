import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRefresh } from '@/api/hooks';
import { useI18n } from '@/i18n/I18nProvider';
import { Avatar, Card, Empty, ErrorState, Loading, Screen, Txt } from '@/components/ui';
import { colors, radius, space, type Tone } from '@/theme/theme';
import { useParent, type ChildRow, type ParentMe } from './ParentContext';

export const TODAY_LABEL: Record<string, string> = {
  present: 'Present today', absent: 'Absent today', late: 'Late today', leave: 'On leave today', unmarked: 'Attendance not marked',
};
export const todayTone = (v: string): Tone => (v === 'present' ? 'success' : v === 'late' ? 'warning' : v === 'absent' ? 'critical' : v === 'leave' ? 'info' : 'neutral');
export const trackLabel = (s: string | null | undefined) =>
  s === 'active' ? 'Tracking Active' : s === 'paused' ? 'Tracking Paused' : s === 'offline' ? 'Offline' : 'Tracking Disabled';

/** Child chips shown when a parent has more than one child linked. */
export function ChildSwitcher() {
  const { kids, child, setChild } = useParent();
  const { t } = useI18n();
  if (kids.length < 2 || !child) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }} accessibilityLabel={t('Choose a child')}>
      {kids.map((c) => {
        const on = c.id === child.id;
        return (
          <Pressable key={c.id} onPress={() => setChild(c.id)} style={[styles.chip, on && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
            <Avatar name={c.fullName} size={30} tone={on ? 'brand' : 'neutral'} />
            <View>
              <Txt variant="small" weight="bold" color={on ? colors.brand : colors.text}>{c.firstName}</Txt>
              <Txt variant="micro">{c.grade}{c.section}</Txt>
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/**
 * Wraps every parent screen: loading / error / "no children linked" states, then renders the selected child.
 * GET /parents/me
 */
export function ParentScreen({ children }: { children: (ctx: { me: ParentMe; child: ChildRow }) => ReactNode }) {
  const { query, me, child } = useParent();
  const { t } = useI18n();
  const { refreshing, onRefresh } = useRefresh();
  if (query.isLoading) return <Screen><Loading /></Screen>;
  if (query.error) return <Screen onRefresh={() => void query.refetch()}><ErrorState error={query.error} onRetry={() => void query.refetch()} /></Screen>;
  if (!me || !child) {
    return (
      <Screen onRefresh={() => void query.refetch()}>
        <Card>
          <Empty icon="users" title={t('No children are linked to your account')}
            sub={t("Please contact the school office to link your child's record. Once linked, attendance, homework, fees and bus updates appear here.")} />
        </Card>
      </Screen>
    );
  }
  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      <ChildSwitcher />
      {children({ me, child })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingLeft: 6, paddingRight: 14, borderRadius: radius.pill,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  chipOn: { borderColor: colors.brand, backgroundColor: colors.brandTint },
});
