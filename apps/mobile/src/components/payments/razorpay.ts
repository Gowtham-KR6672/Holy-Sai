/** The order returned by POST /finance/gateway/orders (Razorpay). */
export interface GatewayOrder {
  paymentId: string;
  orderId: string;
  amount: number;
  amountPaise: number;
  currency: 'INR';
  keyId: string;
  name: string;
  description: string;
  prefill: { name: string | null; email: string | null; contact: string | null };
  notes: Record<string, string>;
  /** A hosted checkout page, if the gateway provides one instead of Checkout.js. */
  checkoutUrl?: string;
}

export type CheckoutResult =
  | { type: 'success'; orderId: string; paymentId: string; signature: string }
  | { type: 'dismiss' }
  | { type: 'failed'; message?: string }
  | { type: 'error'; message?: string };

/** Razorpay Checkout.js page; results are posted back to the app. */
export function checkoutHtml(order: GatewayOrder) {
  const o = JSON.stringify({
    key: order.keyId,
    amount: order.amountPaise,
    currency: order.currency,
    name: order.name,
    description: order.description,
    order_id: order.orderId,
    prefill: { name: order.prefill.name ?? '', email: order.prefill.email ?? '', contact: order.prefill.contact ?? '' },
    notes: order.notes,
    theme: { color: '#990033' },
  }).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<style>html,body{margin:0;height:100%;background:#FAF8F6;font-family:-apple-system,Roboto,sans-serif;color:#171717}
.c{display:flex;height:100%;align-items:center;justify-content:center;text-align:center;padding:24px;font-size:15px}</style></head>
<body><div class="c">Opening secure payment…</div>
<script>
function post(m){ try { (window.ReactNativeWebView||window.parent).postMessage(JSON.stringify(m), '*'); } catch(e) { window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(m)); } }
function start(){
  try {
    var opts = ${o};
    opts.handler = function(r){ post({ type:'success', orderId:r.razorpay_order_id, paymentId:r.razorpay_payment_id, signature:r.razorpay_signature }); };
    opts.modal = { ondismiss: function(){ post({ type:'dismiss' }); }, confirm_close: true };
    var rzp = new Razorpay(opts);
    rzp.on('payment.failed', function(e){ post({ type:'failed', message: e && e.error && e.error.description }); });
    rzp.open();
  } catch (e) { post({ type:'error', message: String(e && e.message || e) }); }
}
</script>
<script src="https://checkout.razorpay.com/v1/checkout.js" onload="start()" onerror="post({type:'error',message:'Could not load the payment page. Check your connection.'})"></script>
</body></html>`;
}
