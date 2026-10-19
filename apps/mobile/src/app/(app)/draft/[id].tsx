import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { useI18n } from '@/i18n/I18nProvider';
import { Banner, Button, Card, confirmAction, ErrorState, Loading, Row, Screen, StatusBadge, Txt } from '@/components/ui';
import { fmt } from '@/lib/format';
import { colors, space } from '@/theme/theme';

interface Draft {
  id: string; type: string; status: 'Draft' | 'Under Review' | 'Approved' | 'Rejected';
  output: Record<string, unknown>; title: string; classLabel: string | null; createdAt: string; requestedBy: string; approvedBy: string | null;
}

const humanKey = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Renders an AI draft's structured output (strings, lists and nested sections) as readable text. */
function OutputValue({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (value == null || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <Txt variant="body" selectable>{String(value)}</Txt>;
  }
  if (Array.isArray(value)) {
    return (
      <View style={{ gap: 6 }}>
        {value.map((v, i) => (
          <Row key={i} gap={8} style={{ alignItems: 'flex-start' }}>
            <Txt variant="body" color={colors.brand}>{typeof v === 'object' ? `${i + 1}.` : '•'}</Txt>
            <View style={{ flex: 1 }}><OutputValue value={v} depth={depth + 1} /></View>
          </Row>
        ))}
      </View>
    );
  }
  if (typeof value === 'object') {
    return (
      <View style={{ gap: space.sm }}>
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <View key={k} style={{ gap: 2 }}>
            <Txt variant={depth === 0 ? 'h3' : 'small'} weight="bold" color={colors.text}>{humanKey(k)}</Txt>
            <OutputValue value={v} depth={depth + 1} />
          </View>
        ))}
      </View>
    );
  }
  return null;
}

/** A Co-Pilot draft: GET /copilot/drafts/:id, POST …/approve, POST …/discard. */
export default function DraftScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  const router = useRouter();
  const q = useApiQuery<Draft>(id ? `/copilot/drafts/${id}` : null);
  const approve = useApiMutation('post', `/copilot/drafts/${id}/approve`, { invalidate: ['/copilot'] });
  const discard = useApiMutation('post', `/copilot/drafts/${id}/discard`, { invalidate: ['/copilot'], onSuccess: () => router.back() });
  const d = q.data;
  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (q.error || !d) return <Screen><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Screen>;
  const open = d.status === 'Draft' || d.status === 'Under Review';

  return (
    <Screen>
      <Card>
        <Txt variant="h2">{d.title}</Txt>
        <Txt variant="small">{[d.classLabel, d.requestedBy, fmt.dateTime(d.createdAt)].filter(Boolean).join(' · ')}</Txt>
        <StatusBadge value={d.status === 'Approved' ? 'Approved' : d.status === 'Rejected' ? 'Discarded' : 'Draft — not published'} tone={d.status === 'Approved' ? 'success' : d.status === 'Rejected' ? 'neutral' : 'warning'} />
      </Card>
      {open && <Banner tone="info" icon="sparkle">{t('Nothing is published automatically. Read it, then approve. Your name is recorded as the approver.')}</Banner>}
      <Card><OutputValue value={d.output} /></Card>
      {open && (
        <>
          <Button label={t('Approve')} icon="check" variant="success" loading={approve.isPending} block onPress={async () => {
            if (await confirmAction({ title: t('Approve this draft?'), body: t('Your name is recorded as the approver. Approved drafts can be used with students and parents.'), confirmLabel: t('Approve'), cancelLabel: t('Cancel') })) approve.mutate({});
          }} />
          <Button label={t('Discard')} icon="trash" loading={discard.isPending} block onPress={async () => {
            if (await confirmAction({ title: t('Discard this draft?'), body: t('The draft is kept in the history as discarded and cannot be approved later.'), confirmLabel: t('Discard'), cancelLabel: t('Cancel'), danger: true })) discard.mutate({});
          }} />
          <Txt variant="micro">{t('To edit the text before approving, open the draft in the web portal.')}</Txt>
        </>
      )}
    </Screen>
  );
}
