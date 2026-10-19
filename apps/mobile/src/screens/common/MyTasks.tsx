import { useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useApiMutation } from '@/api/hooks';
import type { TaskItem } from '@/api/types';
import { useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { Icon } from '@/components/Icon';
import { Badge, Banner, Button, confirmAction, Empty, ErrorState, Loading, Row, Segmented, StatusBadge, Txt } from '@/components/ui';
import { fmt, todayKey } from '@/lib/format';
import { colors, radius, space, type Tone } from '@/theme/theme';

/** Tasks seen in the list, so the Review screen can show them without another request (there is no GET /tasks/:id). */
export const taskCache = new Map<string, TaskItem>();

export function dueInfo(r: TaskItem, t: (s: string, v?: Record<string, string | number>) => string): { label: string; tone: Tone } | null {
  if (!r.dueOn) return null;
  if (r.status === 'Completed') return { label: fmt.dateShort(r.dueOn), tone: 'neutral' };
  if (r.overdue) return { label: t('Overdue · {date}', { date: fmt.dateShort(r.dueOn) }), tone: 'critical' };
  if (r.dueOn === todayKey()) return { label: t('Due today'), tone: 'warning' };
  return { label: t('Due {date}', { date: fmt.dateShort(r.dueOn) }), tone: 'neutral' };
}

export const priorityTone = (p: string): Tone => (p === 'High' ? 'critical' : p === 'Medium' ? 'warning' : 'neutral');

/** My Tasks: GET /tasks?status=open|Completed (paged), PATCH /tasks/:id { status: Completed | Pending }. */
export default function MyTasksScreen() {
  const user = useUser();
  const { t } = useI18n();
  const router = useRouter();
  const [status, setStatus] = useState<'open' | 'Completed'>('open');
  const q = useInfiniteQuery({
    queryKey: ['/tasks', { status }],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => api.getPaged<TaskItem>('/tasks', { status, page: pageParam, pageSize: 25 }, signal),
    getNextPageParam: (last) => (last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined),
  });
  const update = useApiMutation<{ id: string; status: string }>('patch', (v) => `/tasks/${v.id}`, {
    invalidate: ['/tasks', '/notifications/counts'],
    body: (v) => ({ status: v.status }),
    success: (_r, v) => (v.status === 'Completed' ? 'Task marked complete' : 'Task reopened'),
  });

  const rows = q.data?.pages.flatMap((p) => p.rows) ?? [];
  rows.forEach((r) => taskCache.set(r.id, r));
  const total = q.data?.pages[0]?.meta.total ?? 0;
  const review = rows.filter((r) => r.status === 'Under Review').length;
  const overdue = rows.filter((r) => r.overdue && r.status !== 'Completed').length;
  const isFamily = user.role.scope === 'family';

  const toggle = async (r: TaskItem) => {
    const done = r.status !== 'Completed';
    if (!done) {
      const ok = await confirmAction({
        title: t('Reopen this task?'),
        body: t('“{title}” will move back to your open items as Pending.', { title: r.title }),
        confirmLabel: t('Reopen task'),
        cancelLabel: t('Cancel'),
      });
      if (!ok) return;
    }
    update.mutate({ id: r.id, status: done ? 'Completed' : 'Pending' });
  };

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.sm, paddingBottom: 48 }}
      data={rows}
      keyExtractor={(r) => r.id}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} tintColor={colors.brand} />}
      onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && void q.fetchNextPage()}
      onEndReachedThreshold={0.4}
      ListHeaderComponent={
        <View style={{ gap: space.md, paddingBottom: space.sm }}>
          <Txt variant="small">
            {isFamily ? t('Things the school needs from you.') : t('Approvals and actions assigned to you. Open an approval with Review to see it.')}
          </Txt>
          <Segmented items={[{ id: 'open', label: t('Open') }, { id: 'Completed', label: t('Completed') }]} value={status} onChange={setStatus} />
          {status === 'open' && review > 0 && <Banner tone="info" icon="checkSquare">{t('{n} approvals are waiting for your review.', { n: review })}</Banner>}
          {status === 'open' && overdue > 0 && <Banner tone="critical" icon="alert">{t('{n} overdue items — shown first in red.', { n: overdue })}</Banner>}
          <Txt variant="micro">{status === 'Completed' ? t('{n} completed', { n: total }) : t('{n} open, assigned to you', { n: total })}</Txt>
        </View>
      }
      ListEmptyComponent={
        q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
          <Empty icon="checkSquare"
            title={status === 'Completed' ? t('Nothing completed yet') : t('Nothing is assigned to you right now')}
            sub={status === 'Completed' ? t('Tick an open item when you finish it.') : t('New approvals and actions will appear here.')} />
        )
      }
      ListFooterComponent={q.isFetchingNextPage ? <Loading height={60} /> : undefined}
      renderItem={({ item: r }) => {
        const due = dueInfo(r, t);
        const done = r.status === 'Completed';
        return (
          <View style={[styles.item, r.overdue && !done && styles.overdue]}>
            <Pressable onPress={() => void toggle(r)} hitSlop={8} accessibilityRole="checkbox" accessibilityState={{ checked: done }}
              accessibilityLabel={done ? t('Reopen {title}', { title: r.title }) : t('Mark {title} complete', { title: r.title })}
              style={[styles.check, done && styles.checkOn]} disabled={update.isPending}>
              {done && <Icon name="check" size={15} color={colors.textInvert} strokeWidth={3} />}
            </Pressable>
            <Pressable style={{ flex: 1, gap: 4 }} onPress={() => router.push(`/task/${r.id}`)} accessibilityRole="button">
              <Txt variant="body" weight="semibold" style={done ? { textDecorationLine: 'line-through', color: colors.textMuted } : undefined}>{r.title}</Txt>
              <Txt variant="micro">{r.code} · {t(r.module)}</Txt>
              <Row gap={6} wrap>
                <StatusBadge value={r.status} />
                <Badge label={t(r.priority)} tone={priorityTone(r.priority)} />
                {due && <Badge label={due.label} tone={due.tone} icon={due.tone === 'critical' ? 'alert' : 'clock'} />}
              </Row>
            </Pressable>
            <Button size="sm" variant={r.status === 'Under Review' ? 'primary' : 'secondary'} label={r.status === 'Under Review' ? t('Review') : t('Open')} onPress={() => router.push(`/task/${r.id}`)} />
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  item: {
    flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  overdue: { borderLeftWidth: 4, borderLeftColor: colors.critical },
  check: { width: 26, height: 26, borderRadius: 8, borderWidth: 2, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: colors.success, borderColor: colors.success },
});
