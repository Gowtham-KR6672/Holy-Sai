import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { IntegrationsService } from './integrations.service';

export type Channel = 'whatsapp' | 'sms' | 'email' | 'push';

export interface OutboundMessage {
  to: string;
  subject?: string;
  body: string;
  /** WhatsApp template name for business-initiated messages outside the 24-hour window. */
  template?: { name: string; language: string; params: string[] };
}

export interface SendResult {
  ok: boolean;
  channel: Channel;
  providerId?: string;
  error?: string;
}

/** Sends WhatsApp, SMS, email and push messages through whichever providers are configured. */
@Injectable()
export class MessagingService {
  private readonly log = new Logger(MessagingService.name);

  constructor(
    private readonly integrations: IntegrationsService,
    private readonly prisma: PrismaService,
  ) {}

  /** Sends and records the message (with delivery state) in the outbox. */
  async send(channel: Channel, msg: OutboundMessage, link?: { entityType: string; entityId: string }): Promise<SendResult> {
    const row = await this.prisma.outboundMessage.create({
      data: { channel, recipient: msg.to, subject: msg.subject ?? null, body: msg.body, entityType: link?.entityType ?? null, entityId: link?.entityId ?? null },
    });
    const result = await this.dispatch(channel, msg);
    await this.prisma.outboundMessage.update({
      where: { id: row.id },
      data: result.ok ? { status: 'sent', providerId: result.providerId ?? null, sentAt: new Date() } : { status: 'failed', error: result.error?.slice(0, 500) ?? 'Unknown error' },
    });
    return result;
  }

  private async dispatch(channel: Channel, msg: OutboundMessage): Promise<SendResult> {
    try {
      switch (channel) {
        case 'whatsapp':
          return await this.whatsapp(msg);
        case 'sms':
          return await this.sms(msg);
        case 'email':
          return await this.email(msg);
        case 'push':
          return await this.push(msg);
      }
    } catch (err) {
      const error = (err as Error).message;
      this.log.warn(`${channel} to ${msg.to} failed: ${error}`);
      return { ok: false, channel, error };
    }
  }

  private async whatsapp(msg: OutboundMessage): Promise<SendResult> {
    const i = await this.integrations.get('whatsapp');
    if (!i.isEnabled) return { ok: false, channel: 'whatsapp', error: 'WhatsApp is not enabled' };
    const base = i.config.apiBaseUrl || 'https://graph.facebook.com/v21.0';
    const body = msg.template
      ? {
          messaging_product: 'whatsapp',
          to: msg.to.replace(/\D/g, ''),
          type: 'template',
          template: {
            name: msg.template.name,
            language: { code: msg.template.language },
            components: [{ type: 'body', parameters: msg.template.params.map((text) => ({ type: 'text', text })) }],
          },
        }
      : { messaging_product: 'whatsapp', to: msg.to.replace(/\D/g, ''), type: 'text', text: { body: msg.body } };
    const res = await fetch(`${base}/${i.config.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${i.secrets.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error?.message ?? `WhatsApp returned ${res.status}`);
    return { ok: true, channel: 'whatsapp', providerId: json?.messages?.[0]?.id };
  }

  private async sms(msg: OutboundMessage): Promise<SendResult> {
    const i = await this.integrations.get('sms');
    if (!i.isEnabled) return { ok: false, channel: 'sms', error: 'SMS is not enabled' };
    if (i.provider === 'Twilio') {
      const sid = i.config.accountSid;
      const form = new URLSearchParams({ To: msg.to, From: i.config.senderId, Body: msg.body });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`${sid}:${i.secrets.apiKey}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(20_000),
      });
      const json: any = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.message ?? `Twilio returned ${res.status}`);
      return { ok: true, channel: 'sms', providerId: json?.sid };
    }
    // MSG91 (default for India; DLT sender ID and entity ID required)
    const res = await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: { authkey: i.secrets.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ sender: i.config.senderId, recipients: [{ mobiles: msg.to.replace(/\D/g, ''), message: msg.body }] }),
      signal: AbortSignal.timeout(20_000),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || json?.type === 'error') throw new Error(json?.message ?? `MSG91 returned ${res.status}`);
    return { ok: true, channel: 'sms', providerId: json?.request_id };
  }

  private async email(msg: OutboundMessage): Promise<SendResult> {
    const i = await this.integrations.get('email');
    if (!i.isEnabled) return { ok: false, channel: 'email', error: 'Email is not enabled' };
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport({
      host: i.config.host,
      port: Number(i.config.port || 587),
      secure: Number(i.config.port) === 465,
      auth: i.config.user ? { user: i.config.user, pass: i.secrets.password } : undefined,
    });
    const info = await transport.sendMail({ from: i.config.fromAddress, to: msg.to, subject: msg.subject ?? 'Holy Sai International School', text: msg.body });
    return { ok: true, channel: 'email', providerId: info.messageId };
  }

  /** Expo push tokens ("ExponentPushToken[…]") from the mobile app. */
  private async push(msg: OutboundMessage): Promise<SendResult> {
    const i = await this.integrations.get('push');
    if (!i.isEnabled) return { ok: false, channel: 'push', error: 'Push notifications are not enabled' };
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(i.secrets.accessToken ? { authorization: `Bearer ${i.secrets.accessToken}` } : {}) },
      body: JSON.stringify({ to: msg.to, title: msg.subject ?? 'Holy Sai', body: msg.body }),
      signal: AbortSignal.timeout(20_000),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || json?.data?.status === 'error') throw new Error(json?.data?.message ?? `Expo push returned ${res.status}`);
    return { ok: true, channel: 'push', providerId: json?.data?.id };
  }
}
