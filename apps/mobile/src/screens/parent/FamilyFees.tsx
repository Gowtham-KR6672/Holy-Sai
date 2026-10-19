import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { api, ApiError, errorMessage } from '@/api/client';
import { useApiQuery, useInvalidate } from '@/api/hooks';
import { useI18n } from '@/i18n/I18nProvider';
import { Icon } from '@/components/Icon';
import { RazorpayCheckout } from '@/components/payments/RazorpayCheckout';
import type { CheckoutResult, GatewayOrder } from '@/components/payments/razorpay';
import { Banner, Button, Card, Col, ErrorState, ListItem, Loading, Row, Sheet, StatusBadge, Txt } from '@/components/ui';
import { fmt } from '@/lib/format';
import { colors, radius, space } from '@/theme/theme';
import type { ChildRow } from './ParentContext';
import { ParentScreen } from './ParentShell';

interface FamilyFees {
  summary: { billed: number; paid: number; outstanding: number; nextDue: string | null };
  lines: { id: string; description: string; head: string; amountDue: number; concession: number; amountPaid: number; balance: number; dueDate: string; status: string }[];
  payments: { id: string; receiptNo: string; amount: number; method: string; paidAt: string; status: string }[];
}
interface PaidReceipt { receiptNo: string | null; amount: number; method: string; paidAt: string; gatewayRef?: string | null }
type Method = 'UPI' | 'Card' | 'Net Banking';

/** iOS cannot present a modal while another is still dismissing, so the next sheet waits for the animation. */
const afterModal = (fn: () => void) => setTimeout(fn, Platform.OS === 'ios' ? 450 : 50);

/**
 * Fees: GET /family/children/:id/fees (dues, receipts). Pay Now creates a gateway order
 * (POST /finance/gateway/orders), opens Razorpay Checkout, then confirms it (POST /finance/gateway/verify).
 * A 503 means online payment is not configured yet.
 */
export default function FamilyFeesScreen() {
  return <ParentScreen>{({ child }) => <Fees child={child} />}</ParentScreen>;
}

function Fees({ child }: { child: ChildRow }) {
  const { t } = useI18n();
  const router = useRouter();
  const params = useLocalSearchParams<{ pay?: string }>();
  const invalidate = useInvalidate();
  const q = useApiQuery<FamilyFees>(`/family/children/${child.id}/fees`);
  const gateway = useApiQuery<{ configured: boolean; provider: string }>('/finance/gateway/status', undefined, { staleTime: 5 * 60_000 });
  const [paying, setPaying] = useState(false);
  const [method, setMethod] = useState<Method>('UPI');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [order, setOrder] = useState<GatewayOrder | null>(null);
  const [receipt, setReceipt] = useState<PaidReceipt | null>(null);
  const [autoDone, setAutoDone] = useState(false);

  const open = useMemo(() => (q.data?.lines ?? []).filter((l) => l.balance > 0), [q.data]);
  useEffect(() => setSelected(new Set(open.map((l) => l.id))), [open]);
  const total = open.filter((l) => selected.has(l.id)).reduce((a, l) => a + l.balance, 0);

  // "Pay Now" from the home tab opens the payment sheet directly.
  useEffect(() => {
    if (autoDone || params.pay !== '1' || !q.data) return;
    setAutoDone(true);
    if (q.data.summary.outstanding > 0) setPaying(true);
  }, [params.pay, q.data, autoDone]);

  const refreshAll = useCallback(() => {
    void invalidate(`/family/children/${child.id}`, '/parents', '/notifications', '/tasks');
  }, [invalidate, child.id]);

  const startPayment = async () => {
    setBusy(true);
    setPayError(null);
    try {
      const r = await api.post<GatewayOrder>('/finance/gateway/orders', { studentId: child.id, amount: Math.round(total * 100) / 100, feeIds: [...selected], method });
      const o = r.data;
      if (o.checkoutUrl) {
        setPaying(false);
        await WebBrowser.openBrowserAsync(o.checkoutUrl, { toolbarColor: colors.brand });
        refreshAll();
        return;
      }
      setPaying(false);
      afterModal(() => setOrder(o));
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) setPayError(t('Online payment is not set up yet. Please pay at the school office, or try again later.'));
      else if (err instanceof ApiError && (err.status === 404 || err.status === 501)) setPayError(t('Online payment is not available yet. Please pay at the school office.'));
      else setPayError(t(errorMessage(err)));
    } finally {
      setBusy(false);
    }
  };

  const onCheckout = useCallback(async (r: CheckoutResult) => {
    const current = order;
    setOrder(null);
    if (r.type === 'success') {
      setBusy(true);
      try {
        const v = await api.post<PaidReceipt>('/finance/gateway/verify', { orderId: r.orderId, paymentId: r.paymentId, signature: r.signature });
        afterModal(() => setReceipt(v.data));
      } catch (err) {
        setPayError(t(errorMessage(err)));
        afterModal(() => setPaying(true));
      } finally {
        setBusy(false);
        refreshAll();
      }
    } else if (r.type === 'failed' || r.type === 'error') {
      setPayError(r.message ? t(r.message) : t('The payment did not go through. No money was taken; please try again.'));
      afterModal(() => setPaying(true));
      if (current) refreshAll();
    }
  }, [order, refreshAll, t]);

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card>;
  const d = q.data;
  const notConfigured = gateway.data?.configured === false;

  return (
    <>
      <Card title={t('Total outstanding')} icon="wallet">
        <Txt variant="display" color={d.summary.outstanding > 0 ? colors.critical : colors.success}>{fmt.money(d.summary.outstanding)}</Txt>
        <Txt variant="small">{d.summary.nextDue ? t('Next instalment due {date}', { date: fmt.date(d.summary.nextDue) }) : t('All dues cleared')}</Txt>
        <Txt variant="micro">{t('Billed {billed} · paid {paid}', { billed: fmt.money(d.summary.billed), paid: fmt.money(d.summary.paid) })}</Txt>
        {d.summary.outstanding > 0 && <Button variant="primary" icon="creditCard" label={t('Pay Now')} onPress={() => { setPayError(null); setPaying(true); }} loading={busy} block />}
        {notConfigured && d.summary.outstanding > 0 && <Banner tone="warning" icon="info">{t('Online payment is not set up yet. Please pay at the school office, or try again later.')}</Banner>}
      </Card>

      <Card title={t('Receipts')} icon="receipt">
        {d.payments.length ? d.payments.map((p) => (
          <ListItem key={p.id} icon="receipt" tone="success" title={p.receiptNo} meta={`${t('Paid {date}', { date: fmt.date(p.paidAt) })} · ${t(p.method)}`}
            right={<Txt variant="body" weight="bold">{fmt.money(p.amount)}</Txt>} onPress={() => router.push(`/receipt/${p.id}`)} />
        )) : <Txt variant="small">{t('No payments yet. Receipts appear here after each payment.')}</Txt>}
      </Card>

      <Card title={t('Account breakdown')} sub={t('Every charge for this academic year')} icon="grid">
        {d.lines.length ? d.lines.map((l) => (
          <ListItem key={l.id} title={l.description}
            meta={`${t('Due {date}', { date: fmt.date(l.dueDate) })}${l.concession ? ` · ${t('concession {amount}', { amount: fmt.money(l.concession) })}` : ''}`}
            right={<View style={{ alignItems: 'flex-end', gap: 4 }}><Txt variant="small" weight="bold">{fmt.money(l.amountDue - l.concession)}</Txt><StatusBadge value={l.status} /></View>} />
        )) : <Txt variant="small">{t('No charges this year.')}</Txt>}
      </Card>

      <Sheet visible={paying} onClose={() => !busy && setPaying(false)} title={t('Pay fees')} sub={`${child.fullName} · ${child.grade}${child.section}`}
        footer={<>
          <Button label={t('Cancel')} onPress={() => setPaying(false)} disabled={busy} />
          <Button label={t('Pay {amount}', { amount: fmt.money(total) })} variant="primary" icon="lock" loading={busy} disabled={!total} onPress={() => void startPayment()} />
        </>}>
        {payError && <Banner tone="critical" icon="alert">{payError}</Banner>}
        <View style={styles.paybox}>
          {open.map((l) => {
            const on = selected.has(l.id);
            return (
              <Pressable key={l.id} style={styles.payline} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
                onPress={() => setSelected((s) => { const n = new Set(s); if (on) n.delete(l.id); else n.add(l.id); return n; })}>
                <View style={[styles.check, on && styles.checkOn]}>{on && <Icon name="check" size={13} color={colors.textInvert} strokeWidth={3} />}</View>
                <Txt variant="small" color={colors.text} style={{ flex: 1 }}>{l.description}</Txt>
                <Txt variant="small" weight="bold" color={colors.text}>{fmt.money(l.balance)}</Txt>
              </Pressable>
            );
          })}
          <Row style={{ justifyContent: 'space-between', paddingTop: space.sm }}>
            <Txt variant="body" weight="bold">{t('Total')}</Txt>
            <Txt variant="h2">{fmt.money(total)}</Txt>
          </Row>
        </View>
        <Txt variant="eyebrow">{t('Payment method')}</Txt>
        <Col gap={space.sm}>
          {(['UPI', 'Card', 'Net Banking'] as const).map((m) => (
            <Pressable key={m} onPress={() => setMethod(m)} style={[styles.method, method === m && styles.methodOn]} accessibilityRole="radio" accessibilityState={{ checked: method === m }}>
              <Icon name={m === 'UPI' ? 'zap' : m === 'Card' ? 'creditCard' : 'building'} size={18} color={method === m ? colors.brand : colors.textMuted} />
              <Txt variant="body" weight="semibold" style={{ flex: 1 }}>{t(m)}</Txt>
              {method === m && <Icon name="check" size={18} color={colors.brand} />}
            </Pressable>
          ))}
        </Col>
        <Banner tone="neutral" icon="lock">{t('Payments are processed securely by the school’s payment gateway. Card and UPI details never reach this app.')}</Banner>
      </Sheet>

      <Sheet visible={!!receipt} onClose={() => setReceipt(null)} title={t('Payment successful')} footer={<Button label={t('Done')} variant="primary" onPress={() => setReceipt(null)} />}>
        {receipt && (
          <Col gap={space.sm}>
            <View style={styles.done}><Icon name="check" size={28} color={colors.success} strokeWidth={3} /></View>
            <Txt variant="h1" center>{t('{amount} paid', { amount: fmt.money(receipt.amount) })}</Txt>
            <Txt variant="small" center>{receipt.receiptNo ? t('Receipt {no} issued. A copy has been queued to your registered WhatsApp number.', { no: receipt.receiptNo }) : t('Your payment is being confirmed.')}</Txt>
            <ListItem title={t('Paid on')} right={<Txt variant="small" weight="semibold">{fmt.dateTime(receipt.paidAt)}</Txt>} />
            <ListItem title={t('Method')} right={<Txt variant="small" weight="semibold">{t(receipt.method)}</Txt>} />
            {receipt.gatewayRef ? <ListItem title={t('Reference')} right={<Txt variant="small" weight="semibold">{receipt.gatewayRef}</Txt>} /> : null}
            <ListItem title={t('Student')} right={<Txt variant="small" weight="semibold">{`${child.fullName} · ${child.admissionNo}`}</Txt>} />
          </Col>
        )}
      </Sheet>

      <RazorpayCheckout order={order} onResult={(r) => void onCheckout(r)} />
    </>
  );
}

const styles = StyleSheet.create({
  paybox: { backgroundColor: colors.bg, borderRadius: radius.md, padding: space.md, gap: space.sm },
  payline: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 6 },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: colors.brand, borderColor: colors.brand },
  method: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  methodOn: { borderColor: colors.brand, backgroundColor: colors.brandTint },
  done: { alignSelf: 'center', width: 56, height: 56, borderRadius: 28, backgroundColor: colors.successTint, alignItems: 'center', justifyContent: 'center' },
});
