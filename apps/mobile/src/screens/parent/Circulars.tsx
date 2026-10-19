import { useState } from 'react';
import { useApiMutation, useApiQuery, useRefresh } from '@/api/hooks';
import { useI18n } from '@/i18n/I18nProvider';
import { Badge, Button, Card, Empty, ErrorState, ListItem, Loading, Screen, Sheet, Txt } from '@/components/ui';
import { fmt } from '@/lib/format';

interface FamilyCircular { id: string; title: string; publishedAt: string; audience: string; requiresAck: boolean; acknowledged: boolean; body?: string }

/** Circulars: GET /family/circulars, POST /family/circulars/:id/acknowledge. */
export default function CircularsScreen() {
  const { t } = useI18n();
  const { refreshing, onRefresh } = useRefresh();
  const q = useApiQuery<FamilyCircular[]>('/family/circulars');
  const [openC, setOpenC] = useState<FamilyCircular | null>(null);
  const ack = useApiMutation<string>('post', (id) => `/family/circulars/${id}/acknowledge`, {
    invalidate: ['/family/circulars', '/tasks'], success: 'Acknowledged — recorded against your child', body: () => ({}),
  });
  const rows = q.data ?? [];
  const pending = rows.filter((c) => c.requiresAck && !c.acknowledged).length;

  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      <Txt variant="small">{pending ? t('{n} need your acknowledgement', { n: pending }) : t('Notices from the school')}</Txt>
      <Card flush>
        {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : rows.length ? rows.map((c) => (
          <Card key={c.id} style={{ borderWidth: 0, shadowOpacity: 0, elevation: 0 }}>
            <ListItem icon="fileText" tone={c.requiresAck && !c.acknowledged ? 'warning' : undefined} title={c.title}
              meta={`${fmt.date(c.publishedAt)} · ${c.audience}`} onPress={() => setOpenC(c)} />
            {c.requiresAck && (c.acknowledged
              ? <Badge label={t('Acknowledged')} tone="success" icon="check" />
              : <Button size="sm" variant="primary" icon="check" label={t('Acknowledge')} loading={ack.isPending && ack.variables === c.id} onPress={() => ack.mutate(c.id)} />)}
          </Card>
        )) : <Empty icon="megaphone" title={t('No circulars yet')} sub={t('School notices will appear here.')} />}
      </Card>

      <Sheet visible={!!openC} onClose={() => setOpenC(null)} title={openC?.title ?? ''} sub={openC ? `${fmt.date(openC.publishedAt)} · ${openC.audience}` : undefined}
        footer={openC?.requiresAck && !openC.acknowledged
          ? <Button variant="primary" icon="check" label={t('Acknowledge')} onPress={() => { ack.mutate(openC.id); setOpenC(null); }} />
          : <Button label={t('Close')} onPress={() => setOpenC(null)} />}>
        <Txt variant="body" selectable>{openC?.body ?? t('Open the circular from the school notice to read the full text.')}</Txt>
      </Sheet>
    </Screen>
  );
}
