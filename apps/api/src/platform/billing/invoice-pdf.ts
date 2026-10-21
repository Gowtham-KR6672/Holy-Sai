import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export interface InvoiceForPdf {
  number: string;
  issuedAt: Date;
  currency: string;
  subtotal: number;
  taxPercent: number;
  taxAmount: number;
  total: number;
  taxLabel: string;
  description: string;
  periodStart: string;
  periodEnd: string;
  seller: { name: string; address?: string; taxId?: string; email?: string };
  billTo: { name: string; address?: string | null; taxId?: string | null; contact?: string | null; email?: string | null };
  payment: { method: string | null; reference: string | null; paidAt: Date | null; gateway: string };
}

/** The standard PDF fonts only cover Latin-1: keep text readable and never fail on other characters. */
const pdfSafe = (s: string | null | undefined) =>
  (s ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/•/g, '-')
    .replace(/₹/g, 'INR ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

const money = (currency: string, n: number) =>
  `${currency} ${n.toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const day = (d: Date | string) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** A one-page A4 invoice for a subscription payment. */
export async function renderInvoicePdf(inv: InvoiceForPdf): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${inv.number}`);
  doc.setAuthor(pdfSafe(inv.seller.name));
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.13, 0.13, 0.16);
  const muted = rgb(0.42, 0.42, 0.46);
  const brand = rgb(0.6, 0, 0.2);
  const left = 48;
  const right = 547;
  let y = 790;

  const text = (s: string, x: number, size = 10, f = font, color = ink) => page.drawText(pdfSafe(s), { x, y, size, font: f, color });
  const textRight = (s: string, x: number, size = 10, f = font, color = ink) => {
    const safe = pdfSafe(s);
    page.drawText(safe, { x: x - f.widthOfTextAtSize(safe, size), y, size, font: f, color });
  };
  const lines = (s: string | null | undefined) => pdfSafe(s).split(/\r?\n/).filter(Boolean);

  // Seller and invoice heading.
  text(inv.seller.name, left, 18, bold, brand);
  textRight(inv.taxPercent > 0 ? 'TAX INVOICE' : 'INVOICE', right, 16, bold);
  y -= 18;
  for (const l of lines(inv.seller.address)) {
    text(l, left, 9, font, muted);
    y -= 12;
  }
  if (inv.seller.taxId) {
    text(`${inv.taxLabel}: ${inv.seller.taxId}`, left, 9, font, muted);
    y -= 12;
  }
  if (inv.seller.email) {
    text(inv.seller.email, left, 9, font, muted);
    y -= 12;
  }
  y = Math.min(y, 730);
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: rgb(0.88, 0.88, 0.9) });
  y -= 24;

  // Invoice details and bill-to.
  const top = y;
  text('Invoice number', left, 9, font, muted);
  y -= 13;
  text(inv.number, left, 11, bold);
  y -= 20;
  text('Date', left, 9, font, muted);
  y -= 13;
  text(day(inv.issuedAt), left, 11);
  y -= 20;
  text('Subscription period', left, 9, font, muted);
  y -= 13;
  text(`${day(inv.periodStart)} - ${day(inv.periodEnd)}`, left, 11);
  const leftBottom = y;

  y = top;
  const billX = 320;
  text('Bill to', billX, 9, font, muted);
  y -= 13;
  text(inv.billTo.name, billX, 11, bold);
  y -= 14;
  for (const l of [...lines(inv.billTo.address), inv.billTo.contact, inv.billTo.email, inv.billTo.taxId ? `${inv.taxLabel}: ${inv.billTo.taxId}` : null].filter(Boolean) as string[]) {
    text(l, billX, 9, font, muted);
    y -= 12;
  }
  y = Math.min(y, leftBottom) - 30;

  // Line item.
  page.drawRectangle({ x: left, y: y - 6, width: right - left, height: 22, color: rgb(0.96, 0.95, 0.96) });
  text('Description', left + 8, 9, bold, muted);
  textRight('Amount', right - 8, 9, bold, muted);
  y -= 26;
  text(inv.description, left + 8, 10);
  textRight(money(inv.currency, inv.subtotal), right - 8, 10);
  y -= 28;
  page.drawLine({ start: { x: 320, y: y + 10 }, end: { x: right, y: y + 10 }, thickness: 0.6, color: rgb(0.88, 0.88, 0.9) });

  // Totals.
  const row = (label: string, value: string, f = font, size = 10) => {
    text(label, 330, size, f);
    textRight(value, right - 8, size, f);
    y -= 18;
  };
  row('Subtotal', money(inv.currency, inv.subtotal));
  if (inv.taxPercent > 0) row(`${inv.taxLabel} (${inv.taxPercent}%)`, money(inv.currency, inv.taxAmount));
  row('Total', money(inv.currency, inv.total), bold, 12);
  y -= 8;
  text('Paid', 330, 10, bold, rgb(0.1, 0.5, 0.3));
  textRight(money(inv.currency, inv.total), right - 8, 10, bold, rgb(0.1, 0.5, 0.3));
  y -= 40;

  // Payment.
  text('Payment', left, 9, font, muted);
  y -= 13;
  const via = inv.payment.gateway === 'manual' ? (inv.payment.method ? inv.payment.method.toUpperCase() : 'Recorded by We School') : `Online (${inv.payment.gateway.replace('_intl', ' International').replace(/^./, (c) => c.toUpperCase())})`;
  text(`${via}${inv.payment.reference ? ` - reference ${inv.payment.reference}` : ''}${inv.payment.paidAt ? ` - ${day(inv.payment.paidAt)}` : ''}`, left, 10);

  y = 60;
  text('Thank you for choosing We School.', left, 9, font, muted);
  return doc.save();
}
