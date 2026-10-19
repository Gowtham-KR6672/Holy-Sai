import { useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import { DateStepper } from '@/components/DateStepper';
import { Badge, Chips, Empty, ErrorState, Field, ListItem, Loading, Row, Segmented, Txt } from '@/components/ui';
import { fmt, todayKey } from '@/lib/format';
import { colors, space } from '@/theme/theme';

interface GateLogRow {
  id: string; admissionNo: string; fullName: string; grade: string | null; section: string | null; firstIn: string | null; lastOut: string | null;
  entryMethod: string | null; exitGate: string | null; arrivalNotified: boolean; exitNotified: boolean; status: 'Inside' | 'Exited' | 'Not arrived';
}
interface GateEventRow {
  id: string; occurredAt: string; direction: 'in' | 'out'; gate: string; method: string; parentNotifiedAt: string | null;
  admissionNo: string; fullName: string; grade: string | null; section: string | null;
}
type View_ = 'students' | 'scans';
type StatusF = 'All' | 'Inside' | 'Exited' | 'Not arrived';

/** Gate Entry / Exit: GET /gate/log (by student) and GET /gate/events (all scans), paged, for a date. */
export default function GateLogScreen() {
  const user = useUser();
  const { t } = useI18n();
  const [view, setView] = useState<View_>('students');
  const [date, setDate] = useState(todayKey());
  const [status, setStatus] = useState<StatusF>('All');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const campus = user.campusId ? { campusId: user.campusId } : {};
  const path = view === 'students' ? '/gate/log' : '/gate/events';
  const params = view === 'students'
    ? { q: q || undefined, date, sort: 'name', dir: 'asc', pageSize: 50, status: status === 'All' ? undefined : status, ...campus }
    : { q: q || undefined, date, sort: 'time', dir: 'desc', pageSize: 50, ...campus };
  const list = useInfiniteQuery({
    queryKey: [path, params],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => api.getPaged<GateLogRow & GateEventRow>(path, { ...params, page: pageParam }, signal),
    getNextPageParam: (last) => (last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined),
  });
  const rows = list.data?.pages.flatMap((p) => p.rows) ?? [];
  const total = list.data?.pages[0]?.meta.total;

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.xs, paddingBottom: 48 }}
      data={rows}
      keyExtractor={(r) => r.id}
      refreshControl={<RefreshControl refreshing={list.isRefetching} onRefresh={() => void list.refetch()} tintColor={colors.brand} />}
      onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && void list.fetchNextPage()}
      onEndReachedThreshold={0.4}
      ListHeaderComponent={
        <View style={{ gap: space.md, paddingBottom: space.sm }}>
          <Txt variant="small">{t('Every scan at the gate, with the method used.')}</Txt>
          <Segmented items={[{ id: 'students', label: t('By student') }, { id: 'scans', label: t('All scans') }]} value={view} onChange={setView} />
          <DateStepper label={t('Date')} value={date} max={todayKey()} onChange={setDate} />
          <Field label={t('Search')} placeholder={t('Search student or admission no.')} value={search} onChangeText={setSearch} returnKeyType="search"
            onSubmitEditing={() => setQ(search.trim())} onBlur={() => setQ(search.trim())} autoCorrect={false} />
          {view === 'students' && (
            <Chips<StatusF> items={[{ id: 'All', label: t('All') }, { id: 'Inside', label: t('Inside') }, { id: 'Exited', label: t('Exited') }, { id: 'Not arrived', label: t('Not arrived') }]} value={status} onChange={setStatus} />
          )}
          {total != null && <Txt variant="micro">{t('{n} records', { n: total })}</Txt>}
        </View>
      }
      ListEmptyComponent={list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : (
        <Empty icon="scan" title={view === 'students' ? t('No students match these filters.') : t('No scans recorded for these filters.')} />
      )}
      ListFooterComponent={list.isFetchingNextPage ? <Loading height={60} /> : undefined}
      renderItem={({ item: r }) => <View style={{ backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: space.md }}>{view === 'students' ? (
        <ListItem icon="user" title={r.fullName}
          meta={[r.admissionNo, r.grade ? `${r.grade}${r.section ?? ''}` : null, r.firstIn ? `${t('In')} ${fmt.time(r.firstIn)}${r.entryMethod ? ` (${r.entryMethod})` : ''}` : null, r.lastOut ? `${t('Out')} ${fmt.time(r.lastOut)}${r.exitGate ? ` · ${r.exitGate}` : ''}` : null].filter(Boolean).join(' · ')}
          right={<Badge label={r.status === 'Inside' ? t('Inside campus') : t(r.status)} tone={r.status === 'Inside' ? 'success' : r.status === 'Exited' ? 'neutral' : 'warning'} dot />} />
      ) : (
        <ListItem icon={r.direction === 'in' ? 'door' : 'logout'} tone={r.direction === 'in' ? 'success' : 'info'} title={r.fullName}
          meta={[fmt.time(r.occurredAt), r.gate, r.method, r.parentNotifiedAt ? t('parent notified') : null].filter(Boolean).join(' · ')}
          right={<Row gap={4}><Badge label={r.direction === 'in' ? t('Entry') : t('Exit')} tone={r.direction === 'in' ? 'success' : 'info'} /></Row>} />
      )}</View>}
    />
  );
}
