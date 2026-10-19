import { useEffect, useRef } from 'react';
import { Linking, Modal, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from '../webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '@/i18n/I18nProvider';
import { IconButton, Row, Txt } from '@/components/ui';
import { WEB_URL } from '@/lib/config';
import { colors, space } from '@/theme/theme';
import { checkoutHtml, type CheckoutResult, type GatewayOrder } from './razorpay';

/**
 * Razorpay Checkout in a full-screen WebView. UPI app links (upi://, intent://, tez:// …) are handed to the phone,
 * and the signed result comes back through postMessage for POST /finance/gateway/verify.
 */
export function RazorpayCheckout({ order, onResult }: { order: GatewayOrder | null; onResult: (r: CheckoutResult) => void }) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const done = useRef(false);

  const finish = (r: CheckoutResult) => {
    if (done.current) return;
    done.current = true;
    onResult(r);
  };

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      finish(JSON.parse(e.nativeEvent.data) as CheckoutResult);
    } catch {
      /* ignore unrelated messages */
    }
  };

  useEffect(() => {
    done.current = false;
  }, [order?.orderId]);

  return (
    <Modal visible={!!order} animationType="slide" onRequestClose={() => finish({ type: 'dismiss' })}>
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
        <Row style={{ paddingHorizontal: space.lg, paddingVertical: space.sm, justifyContent: 'space-between' }}>
          <Txt variant="h3">{t('Secure payment')}</Txt>
          <IconButton icon="x" label={t('Close')} onPress={() => finish({ type: 'dismiss' })} />
        </Row>
        {order && (
          <WebView
            source={{ html: checkoutHtml(order), baseUrl: `${WEB_URL}/` }}
            originWhitelist={['*']}
            javaScriptEnabled
            domStorageEnabled
            setSupportMultipleWindows={false}
            onMessage={onMessage}
            onShouldStartLoadWithRequest={(req) => {
              if (/^(https?|about|data|blob):/i.test(req.url)) return true;
              void Linking.openURL(req.url).catch(() => undefined);
              return false;
            }}
            style={{ flex: 1, backgroundColor: colors.bg }}
          />
        )}
      </View>
    </Modal>
  );
}
