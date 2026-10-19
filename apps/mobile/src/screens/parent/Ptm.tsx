import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { useI18n } from '@/i18n/I18nProvider';
import { Banner, Button, Card, confirmAction, Empty, ErrorState, Loading, Row, Sheet, Txt } from '@/components/ui';
import { fmt } from '@/lib/format';
import { colors, radius, space } from '@/theme/theme';
import type { ChildRow } from './ParentContext';
import { ParentScreen } from './ParentShell';

interface FamilyPtm {
  id: string; teacher: string; subjectLabel: string; sessionDate: string; startsAt: string; slotMinutes: number; totalSlots: number; freeSlots: number[];
  myBooking?: { id: string; slotNo: number; status: string } | null;
}

const slotTime = (s: FamilyPtm, n: number) => {
  const [h, m] = s.startsAt.split(':').map(Number);
  const mins = h * 60 + m + (n - 1) * s.slotMinutes;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
};

/** Parent–teacher meetings: GET /family/ptm?studentId, POST /family/ptm/:id/book, POST /family/ptm/bookings/:id/cancel. */
export default function PtmScreen() {
  return <ParentScreen>{({ child }) => <Ptm child={child} />}</ParentScreen>;
}

function Ptm({ child }: { child: ChildRow }) {
  const { t } = useI18n();
  const q = useApiQuery<FamilyPtm[]>('/family/ptm', { studentId: child.id });
  const [booking, setBooking] = useState<FamilyPtm | null>(null);
  const book = useApiMutation<{ sessionId: string; slotNo: number }>('post', (v) => `/family/ptm/${v.sessionId}/book`, {
    invalidate: ['/family/ptm', '/tasks'], body: (v) => ({ studentId: child.id, slotNo: v.slotNo }), success: 'PTM slot booked', onSuccess: () => setBooking(null),
  });
  const cancel = useApiMutation<string>('post', (id) => `/family/ptm/bookings/${id}/cancel`, { invalidate: ['/family/ptm'], success: 'Booking cancelled', body: () => ({}) });

  const doCancel = async (p: FamilyPtm) => {
    if (!p.myBooking) return;
    const ok = await confirmAction({
      title: t('Cancel this PTM booking?'),
      body: t('Your {time} slot with {teacher} is released for other parents.', { time: slotTime(p, p.myBooking.slotNo), teacher: p.teacher }),
      confirmLabel: t('Cancel booking'), cancelLabel: t('Keep booking'), danger: true,
    });
    if (ok) cancel.mutate(p.myBooking.id);
  };

  return (
    <>
      <Txt variant="h2">{t('Parent–teacher meetings')}</Txt>
      {q.isLoading ? <Loading /> : q.error ? <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card> : q.data?.length ? q.data.map((p) => (
        <Card key={p.id}>
          <Row gap={space.md}>
            <View style={styles.date}>
              <Txt variant="micro" color={colors.brand}>{fmt.dateShort(p.sessionDate).split(' ')[1] ?? ''}</Txt>
              <Txt variant="h2" color={colors.brand}>{fmt.dateShort(p.sessionDate).split(' ')[0]}</Txt>
            </View>
            <View style={{ flex: 1 }}>
              <Txt variant="h3">{p.teacher}</Txt>
              <Txt variant="small">{p.subjectLabel} · {fmt.date(p.sessionDate)}</Txt>
              <Txt variant="small" weight="semibold" color={p.myBooking ? colors.success : p.freeSlots.length ? colors.textMuted : colors.critical}>
                {p.myBooking ? t('Booked {time}', { time: slotTime(p, p.myBooking.slotNo) }) : t('{free} of {total} slots left', { free: p.freeSlots.length, total: p.totalSlots })}
              </Txt>
            </View>
          </Row>
          {p.myBooking ? (
            <Button size="sm" label={t('Cancel')} loading={cancel.isPending && cancel.variables === p.myBooking.id} onPress={() => void doCancel(p)} />
          ) : (
            <Button size="sm" variant={p.freeSlots.length ? 'primary' : 'secondary'} disabled={!p.freeSlots.length} label={p.freeSlots.length ? t('Book slot') : t('Full')} onPress={() => setBooking(p)} />
          )}
        </Card>
      )) : <Card><Empty icon="calendar" title={t('No PTM sessions are open for booking.')} /></Card>}

      <Sheet visible={!!booking} onClose={() => setBooking(null)} title={t('Book a PTM slot')} sub={booking ? `${booking.teacher} · ${fmt.date(booking.sessionDate)}` : undefined}
        footer={<Button label={t('Close')} onPress={() => setBooking(null)} />}>
        {booking && (
          <>
            <View style={styles.slots}>
              {Array.from({ length: booking.totalSlots }, (_, i) => i + 1).map((n) => {
                const free = booking.freeSlots.includes(n);
                return (
                  <Button key={n} size="sm" variant={free ? 'secondary' : 'ghost'} disabled={!free || book.isPending}
                    label={`${slotTime(booking, n)}${free ? '' : ` · ${t('taken')}`}`} onPress={() => book.mutate({ sessionId: booking.id, slotNo: n })}
                    style={{ minWidth: '30%', flexGrow: 1 }} />
                );
              })}
            </View>
            <Banner tone="neutral" icon="clock">{t('Slots are {n} minutes. You will receive a reminder the evening before.', { n: booking.slotMinutes })}</Banner>
          </>
        )}
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  date: { width: 52, height: 56, borderRadius: radius.md, backgroundColor: colors.brandTint, alignItems: 'center', justifyContent: 'center' },
  slots: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
