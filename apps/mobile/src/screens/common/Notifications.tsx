import { useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import type { NotificationCounts, NotificationItem } from '@/api/types';
import { useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { Icon } from '@/components/Icon';
import { Badge, Banner, Button, Chips, Empty, ErrorState, Loading, Row, Segmented, Txt } from '@/components/ui';
import { fmt } from '@/lib/format';
import { useNav } from '@/lib/navigation';
import { colors, radius, space, toneColors, type Tone } from '@/theme/theme';

const TONE: Record<string, Tone> = { Critical: 'critical', Attention: 'warning', Information: 'info', Completed: 'success' };
const SCOPE: Record<string, string> = {
  family: 'Your own children only. You never see another family’s information.',
  class: 'Your classes and your students only.',
  self: 'Your own shifts, leave, pay and the duties assigned to you.',
  school: 'Everything within your remit across the campus.',
};
type Cat = 'All' | 'Critical' | 'Attention' | 'Information' | 'Completed';

/** Notification Center: GET /notifications (paged), /notifications/counts, PATCH /notifications/:id/read, POST /notifications/read-all. */
export default function NotificationsScreen() {
  const user = useUser();
  const { t } = useI18n();
  const { openRoute } = useNav();
  const [cat, setCat] = useState<Cat>('All');
  const [unreadOnly, setUnreadOnly] = useState<'all' | 'unread'>('all');
  const params = { pageSize: 25, category: cat === 'All' ? undefined : cat, unread: unreadOnly === 'unread' ? 'true' : undefined };

  const q = useInfiniteQuery({
    queryKey: ['/notifications', params],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => api.getPaged<NotificationItem>('/notifications', { ...params, page: pageParam }, signal),
    getNextPageParam: (last) => (last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined),
  });
  const counts = useApiQuery<NotificationCounts>('/notifications/counts');
  const markRead = useApiMutation<string>('patch', (id) => `/notifications/${id}/read`, { invalidate: ['/notifications'], success: false, error: false });
  const markAll = useApiMutation('post', '/notifications/read-all', { invalidate: ['/notifications'], success: 'All notifications marked read' });

  const rows = q.data?.pages.flatMap((p) => p.rows) ?? [];
  const c = counts.data;

  const open = (n: NotificationItem) => {
    if (!n.readAt) markRead.mutate(n.id);
    if (n.route) openRoute(n.route);
  };

  const header = (
    <View style={{ gap: space.md, paddingBottom: space.sm }}>
      <Txt variant="small">{t('Categories map to how quickly somebody must act.')} {t(SCOPE[user.role.scope] ?? SCOPE.school)}</Txt>
      {!!c?.critical && cat !== 'Critical' && (
        <Banner tone="critical" icon="alert">
          <Row style={{ justifyContent: 'space-between' }} wrap>
            <Txt variant="small" weight="semibold" color={colors.criticalText}>{t('{n} critical notifications need prompt action.', { n: c.critical })}</Txt>
            <Button size="sm" variant="danger" label={t('Show critical')} onPress={() => setCat('Critical')} />
          </Row>
        </Banner>
      )}
      <Segmented
        items={[{ id: 'all', label: `${t('All')}${c ? ` · ${c.total}` : ''}` }, { id: 'unread', label: `${t('Unread')}${c ? ` · ${c.unread}` : ''}` }]}
        value={unreadOnly}
        onChange={setUnreadOnly}
      />
      <Chips<Cat>
        items={[
          { id: 'All', label: t('Any category') },
          { id: 'Critical', label: t('Critical'), count: c?.critical },
          { id: 'Attention', label: t('Attention'), count: c?.attention },
          { id: 'Information', label: t('Information'), count: c?.information },
          { id: 'Completed', label: t('Completed'), count: c?.completed },
        ]}
        value={cat}
        onChange={setCat}
      />
      <Button label={t('Mark all read')} icon="check" size="sm" onPress={() => markAll.mutate({})} loading={markAll.isPending} disabled={!c?.unread} style={{ alignSelf: 'flex-start' }} />
    </View>
  );

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.sm, paddingBottom: 48 }}
      data={rows}
      keyExtractor={(n) => n.id}
      ListHeaderComponent={header}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { void q.refetch(); void counts.refetch(); }} tintColor={colors.brand} />}
      onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && void q.fetchNextPage()}
      onEndReachedThreshold={0.4}
      ListEmptyComponent={
        q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
          <Empty
            icon="bell"
            title={unreadOnly === 'unread' ? t('You are all caught up') : cat === 'All' ? t('No notifications yet') : t('No notifications in this category')}
            sub={t('Alerts, approvals and updates for your role will appear here as they happen.')}
            action={cat !== 'All' || unreadOnly === 'unread' ? <Button size="sm" label={t('Show all notifications')} onPress={() => { setCat('All'); setUnreadOnly('all'); }} /> : undefined}
          />
        )
      }
      ListFooterComponent={q.isFetchingNextPage ? <Loading height={60} /> : undefined}
      renderItem={({ item: n }) => {
        const unread = !n.readAt;
        const tone = TONE[n.category] ?? 'info';
        return (
          <Pressable onPress={() => open(n)} style={({ pressed }) => [styles.item, unread && styles.unread, n.category === 'Critical' && styles.critical, pressed && { opacity: 0.85 }]}
            accessibilityRole="button" accessibilityLabel={`${unread ? t('Unread') + ': ' : ''}${n.title}`}>
            <View style={[styles.ico, { backgroundColor: toneColors[tone].bg }]}>
              <Icon name={n.icon} size={17} color={toneColors[tone].solid} fallback="bell" />
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <Row gap={6}>
                {unread && <View style={styles.dot} />}
                <Txt variant="body" weight={unread ? 'bold' : 'semibold'} style={{ flex: 1 }}>{n.title}</Txt>
              </Row>
              {n.body ? <Txt variant="small" numberOfLines={3}>{n.body}</Txt> : null}
              <Row gap={8} wrap>
                <Badge label={t(n.category)} tone={tone} />
                <Txt variant="micro">{fmt.relative(n.createdAt)}</Txt>
                {n.route ? <Txt variant="micro" color={colors.brand}>{t('Open')} ›</Txt> : null}
              </Row>
            </View>
            {unread && (
              <Pressable onPress={() => markRead.mutate(n.id)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('Mark as read')} style={styles.read}>
                <Icon name="check" size={16} color={colors.textMuted} />
              </Pressable>
            )}
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  item: {
    flexDirection: 'row', gap: space.md, padding: space.md, backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  unread: { backgroundColor: '#FFFDF8', borderColor: colors.brandLine },
  critical: { borderLeftWidth: 4, borderLeftColor: colors.critical },
  ico: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.brand },
  read: { padding: 6, alignSelf: 'flex-start' },
});
