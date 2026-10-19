import { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { useI18n } from '@/i18n/I18nProvider';
import { Button, Card, Empty, ErrorState, Field, ListItem, Loading, StatusBadge, Txt } from '@/components/ui';
import { fmt } from '@/lib/format';
import type { ChildRow } from './ParentContext';
import { ParentScreen } from './ParentShell';

interface Thread { id: string; subject: string; lastMessageAt: string; status: string; studentName?: string | null; unread?: boolean }

/** Messages to school: GET /family/messages, POST /family/messages { subject, body, studentId }. */
export default function MessagesScreen() {
  return <ParentScreen>{({ child }) => <Messages child={child} />}</ParentScreen>;
}

function Messages({ child }: { child: ChildRow }) {
  const { t } = useI18n();
  const params = useLocalSearchParams<{ compose?: string }>();
  const threads = useApiQuery<Thread[]>('/family/messages');
  const [composing, setComposing] = useState(!!params.compose);
  const [msg, setMsg] = useState({ subject: '', body: '' });
  const send = useApiMutation<{ subject: string; body: string }>('post', '/family/messages', {
    invalidate: ['/family/messages'], body: (v) => ({ ...v, studentId: child.id }), success: 'Message sent to the class teacher',
    onSuccess: () => { setComposing(false); setMsg({ subject: '', body: '' }); },
  });
  useEffect(() => {
    if (params.compose) setComposing(true);
  }, [params.compose]);

  const valid = msg.subject.trim().length >= 3 && msg.body.trim().length >= 3;

  return (
    <>
      {composing ? (
        <Card title={t('Message the class teacher')} sub={t('About {name}', { name: child.fullName })} icon="message">
          <Field label={t('Subject')} required value={msg.subject} onChangeText={(v) => setMsg({ ...msg, subject: v })} maxLength={160} />
          <Field label={t('Message')} required multiline value={msg.body} onChangeText={(v) => setMsg({ ...msg, body: v })} maxLength={2000}
            hint={t('At least 3 characters. The teacher usually replies within a school day.')} />
          <Button label={t('Send')} icon="send" variant="primary" disabled={!valid} loading={send.isPending}
            onPress={() => send.mutate({ subject: msg.subject.trim(), body: msg.body.trim() })} />
          <Button label={t('Cancel')} variant="ghost" onPress={() => setComposing(false)} />
        </Card>
      ) : (
        <>
          <Button label={t('New message')} icon="plus" variant="primary" onPress={() => setComposing(true)} block />
          <Button label={t('Report an absence')} icon="calendar" onPress={() => { setMsg({ subject: t('Absence — {name}', { name: child.firstName }), body: '' }); setComposing(true); }} block />
        </>
      )}
      <Card title={t('Messages')} icon="message">
        {threads.isLoading ? <Loading height={80} /> : threads.error ? <ErrorState error={threads.error} onRetry={() => void threads.refetch()} /> : threads.data?.length ? threads.data.map((th) => (
          <ListItem key={th.id} icon="message" tone={th.unread ? 'brand' : undefined} title={th.subject}
            meta={`${fmt.relative(th.lastMessageAt)}${th.studentName ? ` · ${th.studentName}` : ''}`} right={<StatusBadge value={th.status} />} />
        )) : <Empty icon="message" title={t('No conversations yet')} sub={t('Messages you send to the class teacher appear here.')} />}
      </Card>
      <Txt variant="micro">{t('Replies from the school arrive as notifications.')}</Txt>
    </>
  );
}
