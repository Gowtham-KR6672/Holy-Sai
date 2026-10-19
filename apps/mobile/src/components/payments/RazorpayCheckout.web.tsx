import { useEffect } from 'react';
import type { CheckoutResult, GatewayOrder } from './razorpay';

/** Web build (smoke tests only): Checkout.js is not embedded; the attempt is reported as an error. */
export function RazorpayCheckout({ order, onResult }: { order: GatewayOrder | null; onResult: (r: CheckoutResult) => void }) {
  useEffect(() => {
    if (order) onResult({ type: 'error', message: 'Online payment opens in the iOS and Android app.' });
  }, [order, onResult]);
  return null;
}
