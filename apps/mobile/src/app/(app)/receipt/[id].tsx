import { Share } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useApiQuery } from '@/api/hooks';
import { useI18n } from '@/i18n/I18nProvider';
import { Button, Card, ErrorState, ListItem, Loading, Screen, StatusBadge, Txt } from '@/components/ui';
import { fmt } from '@/lib/format';

interface FamilyReceipt {
  id: string; receiptNo: string; amount: number; method: string; gatewayRef: string | null; status: string; paidAt: string; paidBy: string | null;
  academicYear: string | null; student: { fullName: string; admissionNo: string; grade: string | null; section: string | null; campus: string };
  lines: { feeId: string; description: string; head: string; amount: number }[];
}

/** A past fee receipt: GET /family/receipts/:id. */
export default function ReceiptScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  const q = useApiQuery<FamilyReceipt>(id ? `/family/receipts/${id}` : null);
  const r = q.data;
  if (q.isLoading) return <Screen><Loading /></Screen>;
  if (q.error || !r) return <Screen><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Screen>;

  const share = () => {
    const lines = [
      `${t('Receipt')} ${r.receiptNo}`,
      `${r.student.fullName} · ${r.student.admissionNo}`,
      `${fmt.money(r.amount)} · ${t(r.method)} · ${fmt.dateTime(r.paidAt)}`,
      r.gatewayRef ? `${t('Reference')}: ${r.gatewayRef}` : '',
      ...r.lines.map((l) => `${l.description}: ${fmt.money(l.amount)}`),
    ].filter(Boolean);
    void Share.share({ message: lines.join('\n') });
  };

  return (
    <Screen>
      <Card>
        <Txt variant="micro">{t('Receipt')} {r.receiptNo}</Txt>
        <Txt variant="display">{fmt.money(r.amount)}</Txt>
        <StatusBadge value={r.status} />
        <ListItem title={t('Paid on')} right={<Txt variant="small" weight="semibold">{fmt.dateTime(r.paidAt)}</Txt>} />
        <ListItem title={t('Method')} right={<Txt variant="small" weight="semibold">{t(r.method)}</Txt>} />
        {r.paidBy ? <ListItem title={t('Paid by')} right={<Txt variant="small" weight="semibold">{r.paidBy}</Txt>} /> : null}
        {r.gatewayRef ? <ListItem title={t('Reference')} right={<Txt variant="small" weight="semibold">{r.gatewayRef}</Txt>} /> : null}
        <ListItem title={t('Student')} meta={`${r.student.fullName} · ${r.student.admissionNo}`} />
        <ListItem title={t('Class')} right={<Txt variant="small" weight="semibold">{`${r.student.grade ?? '—'} ${r.student.section ?? ''} · ${r.student.campus}`}</Txt>} />
        {r.academicYear ? <ListItem title={t('Academic year')} right={<Txt variant="small" weight="semibold">{r.academicYear}</Txt>} /> : null}
      </Card>
      {r.lines.length > 0 && (
        <Card title={t('Charges paid')} icon="receipt">
          {r.lines.map((l) => <ListItem key={l.feeId} title={l.description} meta={l.head} right={<Txt variant="body" weight="bold">{fmt.money(l.amount)}</Txt>} />)}
        </Card>
      )}
      <Button label={t('Share receipt')} icon="send" onPress={share} block />
    </Screen>
  );
}
