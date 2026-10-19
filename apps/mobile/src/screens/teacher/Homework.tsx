import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useApiMutation, useApiQuery, usePagedQuery, useRefresh } from '@/api/hooks';
import { useAuth, useUser } from '@/auth/AuthContext';
import { useI18n } from '@/i18n/I18nProvider';
import {
  Badge, Button, Card, Chips, Empty, ErrorState, Kpi, KpiGrid, ListItem, Loading, Meter, Row, Screen, Sheet, StatusBadge, Txt,
} from '@/components/ui';
import { fmt } from '@/lib/format';
import type { Tone } from '@/theme/theme';

interface HomeworkRow {
  id: string; title: string; instructions: string | null; status: string; displayStatus: string; assignedOn: string; dueOn: string;
  sectionId: string; sectionLabel: string; subjectId: string; subject: string; assignedBy: string | null; submitted: number; of: number;
}
interface Summary { open: number; averageSubmission: number | null; overdue: number; overdueSubjects: string[]; studentsBelow50: number }
interface Submissions {
  homework: HomeworkRow;
  students: { id: string; admissionNo: string; fullName: string; roll: number | null; status: string | null; submittedAt: string | null; feedback: string | null }[];
}
const STATUS_TONE: Record<string, Tone> = { Open: 'info', 'Closing today': 'warning', Overdue: 'critical', Closed: 'neutral', Draft: 'neutral' };
type Filter = 'All' | 'Open' | 'Overdue' | 'Closed';

/** Homework: GET /academics/homework (paged), /academics/homework/summary, /academics/homework/:id/submissions, remind / close. */
export default function HomeworkScreen() {
  const user = useUser();
  const { can } = useAuth();
  const { t } = useI18n();
  const params = useLocalSearchParams<{ sectionId?: string }>();
  const { refreshing, onRefresh } = useRefresh();
  const [status, setStatus] = useState<Filter>('All');
  const [viewing, setViewing] = useState<string | null>(null);
  const campus = user.campusId ? { campusId: user.campusId } : {};
  const q = usePagedQuery<HomeworkRow>('/academics/homework', { sort: 'due', dir: 'asc', pageSize: 50, status: status === 'All' ? undefined : status, sectionId: params.sectionId, ...campus });
  const summary = useApiQuery<Summary>('/academics/homework/summary', campus);
  const s = summary.data;

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      {s && (
        <KpiGrid>
          <Kpi icon="edit" label={t('Open homework')} value={s.open} />
          <Kpi icon="checkSquare" label={t('Average submission')} value={s.averageSubmission != null ? `${Math.round(s.averageSubmission)}%` : '—'} tone="success" />
          <Kpi icon="alert" label={t('Overdue')} value={s.overdue} tone={s.overdue ? 'critical' : undefined} foot={s.overdueSubjects.join(', ') || undefined} />
          <Kpi icon="users" label={t('Students below 50%')} value={s.studentsBelow50} tone={s.studentsBelow50 ? 'warning' : undefined} />
        </KpiGrid>
      )}
      <Chips<Filter> items={[{ id: 'All', label: t('All') }, { id: 'Open', label: t('Open') }, { id: 'Overdue', label: t('Overdue') }, { id: 'Closed', label: t('Closed') }]} value={status} onChange={setStatus} />
      {q.isLoading ? <Loading /> : q.error ? <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card> : q.data?.rows.length ? q.data.rows.map((h) => (
        <Card key={h.id} onPress={() => setViewing(h.id)}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <Txt variant="h3" style={{ flex: 1 }}>{h.title}</Txt>
            <Badge label={t(h.displayStatus)} tone={STATUS_TONE[h.displayStatus] ?? 'neutral'} />
          </Row>
          <Txt variant="small">{h.sectionLabel} · {h.subject} · {t('due {date}', { date: fmt.dateShort(h.dueOn) })}{h.assignedBy ? ` · ${h.assignedBy}` : ''}</Txt>
          <Meter label={t('Submitted')} value={h.of ? (h.submitted / h.of) * 100 : 0} right={`${h.submitted}/${h.of}`} tone={h.of && h.submitted / h.of >= 0.8 ? 'success' : 'warning'} />
        </Card>
      )) : <Card><Empty icon="edit" title={t('No homework found')} sub={t('Homework set for your classes appears here.')} /></Card>}

      {viewing && <SubmissionsSheet id={viewing} manage={can('academics.manage')} onClose={() => setViewing(null)} />}
    </Screen>
  );
}

function SubmissionsSheet({ id, manage, onClose }: { id: string; manage: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const q = useApiQuery<Submissions>(`/academics/homework/${id}/submissions`);
  const remind = useApiMutation<string>('post', (hid) => `/academics/homework/${hid}/remind`, { invalidate: ['/notifications'], body: () => ({}) });
  const close = useApiMutation<string>('post', (hid) => `/academics/homework/${hid}/close`, { invalidate: ['/academics/homework', '/academics/teacher-dashboard'], body: () => ({}), onSuccess: onClose });
  const h = q.data?.homework;
  const open = h && h.status !== 'Closed' && h.status !== 'Draft';
  return (
    <Sheet visible onClose={onClose} title={h?.title ?? t('Homework')} sub={h ? `${h.sectionLabel} · ${h.subject} · ${t('due {date}', { date: fmt.date(h.dueOn) })}` : undefined}
      footer={manage && open ? <>
        <Button size="sm" icon="bell" label={t('Remind pending')} loading={remind.isPending} onPress={() => remind.mutate(id)} />
        <Button size="sm" icon="check" label={t('Close homework')} loading={close.isPending} onPress={() => close.mutate(id)} />
      </> : undefined}>
      {q.isLoading ? <Loading /> : q.error || !q.data ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <>
          {h?.instructions ? <Txt variant="body">{h.instructions}</Txt> : null}
          {q.data.students.map((st) => (
            <ListItem key={st.id} title={st.fullName} meta={[st.admissionNo, st.submittedAt ? t('submitted {when}', { when: fmt.dateTime(st.submittedAt) }) : null, st.feedback].filter(Boolean).join(' · ')}
              right={<StatusBadge value={st.status ?? 'Pending'} />} />
          ))}
        </>
      )}
    </Sheet>
  );
}
