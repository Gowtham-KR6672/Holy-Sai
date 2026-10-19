/**
 * Rebuild addition: Razorpay Checkout for online fee payments. The API creates the order (amount, key id, school
 * name); Checkout runs in the payer's browser; the API then verifies Razorpay's signature and issues the receipt.
 * Card / UPI details never touch this app or the school's server.
 */
export interface GatewayOrder {
  paymentId: string;
  orderId: string;
  amount: number;
  amountPaise: number;
  currency: string;
  keyId: string;
  name: string;
  description: string;
  prefill: { name: string | null; email: string | null; contact: string | null };
  notes: Record<string, string>;
}

export interface CheckoutResult { orderId: string; paymentId: string; signature: string }

interface RazorpayResponse { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }
interface RazorpayInstance { open: () => void; on: (event: string, cb: (r: { error?: { description?: string } }) => void) => void }
type RazorpayCtor = new (options: Record<string, unknown>) => RazorpayInstance;

const SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';
let loading: Promise<RazorpayCtor> | null = null;

function loadCheckout(): Promise<RazorpayCtor> {
  const w = window as unknown as { Razorpay?: RazorpayCtor };
  if (w.Razorpay) return Promise.resolve(w.Razorpay);
  loading ??= new Promise<RazorpayCtor>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (w.Razorpay ? resolve(w.Razorpay) : reject(new Error('The payment page could not be loaded')));
    s.onerror = () => {
      loading = null;
      s.remove();
      reject(new Error('The payment page could not be loaded. Check your internet connection and try again.'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** UPI / Card / Net Banking → the Checkout method to open first. */
const METHOD: Record<string, string> = { UPI: 'upi', Card: 'card', 'Net Banking': 'netbanking' };

/**
 * Opens Razorpay Checkout for an order. Resolves with the signed result to confirm on the server,
 * or null when the payer closes the window without paying. Rejects when the payment fails.
 */
export async function openCheckout(order: GatewayOrder, method?: string): Promise<CheckoutResult | null> {
  const Razorpay = await loadCheckout();
  return new Promise<CheckoutResult | null>((resolve, reject) => {
    let settled = false;
    const rzp = new Razorpay({
      key: order.keyId,
      amount: order.amountPaise,
      currency: order.currency,
      name: order.name,
      description: order.description,
      order_id: order.orderId,
      prefill: {
        name: order.prefill.name ?? undefined,
        email: order.prefill.email ?? undefined,
        contact: order.prefill.contact ?? undefined,
        method: method ? METHOD[method] : undefined,
      },
      notes: order.notes,
      theme: { color: '#990033' },
      handler: (r: RazorpayResponse) => {
        settled = true;
        resolve({ orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature });
      },
      modal: {
        ondismiss: () => {
          if (!settled) resolve(null);
        },
      },
    });
    rzp.on('payment.failed', (r) => {
      settled = true;
      reject(new Error(r.error?.description || 'The payment did not go through. No money was taken; please try again.'));
    });
    rzp.open();
  });
}
