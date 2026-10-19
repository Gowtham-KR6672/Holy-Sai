import { useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import type { StudentRow } from '@/api/types';
import { useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { Icon } from '@/components/Icon';
import { Avatar, Badge, Chips, Empty, ErrorState, Loading, Row, Txt } from '@/components/ui';
import { colors, radius, space, statusTone } from '@/theme/theme';

type Risk = 'All' | 'On Track' | 'Developing Risk' | 'At Risk';
export const TODAY_SHORT: Record<string, string> = { present: 'Present', absent: 'Absent', late: 'Late', leave: 'Leave', unmarked: 'Not marked' };

/** Students search: GET /students (paged, q, risk, campusId) and /students/summary. Opens the student summary. */
export default function StudentsScreen() {
  const user = useUser();
  const { t, font } = useI18n();
  const router = useRouter();
  const params = useLocalSearchParams<{ risk?: string }>();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [risk, setRisk] = useState<Risk>((params.risk as Risk) || 'All');
  const campus = user.campusId ? { campusId: user.campusId } : {};
  const query = { q: q || undefined, risk: risk === 'All' ? undefined : risk, sort: 'name', dir: 'asc', pageSize: 30, ...campus };
  const list = useInfiniteQuery({
    queryKey: ['/students', query],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => api.getPaged<StudentRow>('/students', { ...query, page: pageParam }, signal),
    getNextPageParam: (last) => (last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined),
  });
  const summary = useApiQuery<{ total: number; atRisk: number; developing: number; onTrack: number }>('/students/summary', campus);
  const rows = list.data?.pages.flatMap((p) => p.rows) ?? [];
  const s = summary.data;

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.sm, paddingBottom: 48 }}
      data={rows}
      keyExtractor={(r) => r.id}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={list.isRefetching} onRefresh={() => { void list.refetch(); void summary.refetch(); }} tintColor={colors.brand} />}
      onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && void list.fetchNextPage()}
      onEndReachedThreshold={0.4}
      ListHeaderComponent={
        <View style={{ gap: space.md, paddingBottom: space.sm }}>
          <View style={styles.search}>
            <Icon name="search" size={18} color={colors.textMuted} />
            <TextInputLite value={search} onChange={setSearch} onSubmit={() => setQ(search.trim())} placeholder={t('Search name or admission no.')} fontFamily={font('regular')} />
            {!!search && <Pressable onPress={() => { setSearch(''); setQ(''); }} hitSlop={8} accessibilityLabel={t('Clear')}><Icon name="x" size={16} color={colors.textMuted} /></Pressable>}
          </View>
          <Chips<Risk> items={[
            { id: 'All', label: t('All'), count: s?.total },
            { id: 'On Track', label: t('On Track'), count: s?.onTrack },
            { id: 'Developing Risk', label: t('Developing Risk'), count: s?.developing },
            { id: 'At Risk', label: t('At Risk'), count: s?.atRisk },
          ]} value={risk} onChange={setRisk} />
        </View>
      }
      ListEmptyComponent={list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : (
        <Empty icon="users" title={q || risk !== 'All' ? t('No students match these filters.') : t('No students yet')} />
      )}
      ListFooterComponent={list.isFetchingNextPage ? <Loading height={60} /> : undefined}
      renderItem={({ item: r }) => (
        <Pressable onPress={() => router.push(`/student/${r.id}`)} style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }]} accessibilityRole="button">
          <Avatar name={r.fullName} size={42} />
          <View style={{ flex: 1, gap: 2 }}>
            <Txt variant="body" weight="semibold" numberOfLines={1}>{r.fullName}</Txt>
            <Txt variant="micro" numberOfLines={1}>{[r.admissionNo, `${r.grade}${r.section}`, r.house].filter(Boolean).join(' · ')}</Txt>
            <Row gap={6} wrap>
              <Badge label={t(TODAY_SHORT[r.today] ?? r.today)} tone={statusTone(TODAY_SHORT[r.today] ?? r.today)} dot />
              <Badge label={t(r.risk)} tone={r.risk === 'At Risk' ? 'critical' : r.risk === 'Developing Risk' ? 'warning' : 'success'} />
            </Row>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Txt variant="small" weight="bold" color={r.attendance != null && r.attendance < 85 ? colors.critical : colors.text}>{r.attendance != null ? `${r.attendance}%` : '—'}</Txt>
            <Txt variant="micro">{r.average != null ? `${t('Avg')} ${r.average}` : ''}</Txt>
          </View>
        </Pressable>
      )}
    />
  );
}

function TextInputLite({ value, onChange, onSubmit, placeholder, fontFamily }: { value: string; onChange: (v: string) => void; onSubmit: () => void; placeholder: string; fontFamily: string }) {
  return (
    <TextInput value={value} onChangeText={onChange} onSubmitEditing={onSubmit} onBlur={onSubmit} placeholder={placeholder} placeholderTextColor={colors.textFaint}
      returnKeyType="search" autoCorrect={false} autoCapitalize="none" style={{ flex: 1, fontSize: 15, color: colors.text, paddingVertical: 12, fontFamily }} accessibilityLabel={placeholder} />
  );
}

const styles = StyleSheet.create({
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
});
