import { useLocalSearchParams, useRouter } from 'expo-router';
import { useApiMutation } from '@/api/hooks';
import { useI18n } from '@/i18n/I18nProvider';
import { Badge, Banner, Button, Card, Col, Empty, Row, Screen, StatusBadge, Txt } from '@/components/ui';
import { featureForWebPath } from '@/lib/features';
import { fmt } from '@/lib/format';
import { useNav } from '@/lib/navigation';
import { dueInfo, priorityTone, taskCache } from '@/screens/common/MyTasks';

const STEPS = ['Draft', 'Submitted', 'Under Review', 'Approved / Rejected'];

/** "Review" from My Tasks: the task's details, complete / reopen, and the record where it is decided. */
export default function TaskDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  const router = useRouter();
  const { openRoute } = useNav();
  const task = id ? taskCache.get(id) : undefined;
  const update = useApiMutation<{ status: string }>('patch', `/tasks/${id}`, {
    invalidate: ['/tasks', '/notifications/counts'],
    success: (_r, v) => (v.status === 'Completed' ? 'Task marked complete' : 'Task reopened'),
    onSuccess: () => router.back(),
  });

  if (!task) {
    return (
      <Screen>
        <Empty icon="checkSquare" title={t('Task not found')} sub={t('Open My Tasks again to refresh the list.')}
          action={<Button label={t('Back')} icon="arrowLeft" onPress={() => router.back()} />} />
      </Screen>
    );
  }
  const due = dueInfo(task, t);
  const native = !!featureForWebPath(task.route);
  const reviewIdx = task.status === 'Completed' ? 3 : task.status === 'Under Review' ? 2 : 1;

  return (
    <Screen>
      <Card>
        <Txt variant="micro">{task.code} · {t(task.module)}</Txt>
        <Txt variant="h2">{task.title}</Txt>
        <Row gap={6} wrap>
          <StatusBadge value={task.status} />
          <Badge label={t(task.priority)} tone={priorityTone(task.priority)} />
          {due && <Badge label={due.label} tone={due.tone} />}
        </Row>
        <Col gap={4}>
          <Txt variant="small">{t('Due')}: {task.dueOn ? fmt.date(task.dueOn) : t('No due date')}</Txt>
          <Txt variant="small">{t('Module')}: {t(task.module)}</Txt>
        </Col>
      </Card>

      {task.status === 'Under Review' && (
        <Card title={t('Approval path')} icon="shield">
          <Row wrap gap={6}>
            {STEPS.map((s, i) => (
              <Badge key={s} label={`${i + 1}. ${t(s)}`} tone={i < reviewIdx ? 'success' : i === reviewIdx ? 'warning' : 'neutral'} />
            ))}
          </Row>
          <Txt variant="small">{t('Approve or reject inside the record. Your decision is recorded in the audit trail.')}</Txt>
        </Card>
      )}

      {task.route ? (
        <Button
          label={native ? t('Open record') : t('Open in the web portal')}
          icon={native ? 'arrowRight' : 'external'}
          variant="primary"
          onPress={() => openRoute(task.route)}
          block
        />
      ) : (
        <Banner tone="neutral" icon="info">{t('This task has no linked record. Mark it complete when it is done.')}</Banner>
      )}
      {!native && task.route && <Txt variant="micro">{t('This record opens in the web portal; sign in there with the same account.')}</Txt>}

      {task.status === 'Completed' ? (
        <Button label={t('Reopen task')} icon="refresh" onPress={() => update.mutate({ status: 'Pending' })} loading={update.isPending} block />
      ) : (
        <Button label={t('Mark complete')} icon="check" variant="success" onPress={() => update.mutate({ status: 'Completed' })} loading={update.isPending} block />
      )}
    </Screen>
  );
}
