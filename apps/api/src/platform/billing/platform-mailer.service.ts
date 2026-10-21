import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { PlatformSettings } from '../../tenancy/platform-settings.service';

/** Emails sent by We School itself (renewal reminders, receipts), through the SMTP account in Platform settings. */
@Injectable()
export class PlatformMailer {
  private readonly log = new Logger('PlatformMailer');

  constructor(private readonly settings: PlatformSettings) {}

  async configured(): Promise<boolean> {
    const [host, from] = await Promise.all([this.settings.get<string>('email.smtp_host'), this.settings.get<string>('email.from_address')]);
    return !!host && !!from;
  }

  /** Sends a plain-text email; returns false (and logs) when no sender is set up or sending fails. */
  async send(to: string[], subject: string, text: string, attachments: { filename: string; content: Buffer | Uint8Array; contentType?: string }[] = []): Promise<boolean> {
    const recipients = [...new Set(to.map((t) => t.trim().toLowerCase()).filter((t) => /.+@.+\..+/.test(t) && !t.endsWith('.invalid')))];
    if (!recipients.length) return false;
    const [host, port, user, password, from] = await Promise.all([
      this.settings.get<string>('email.smtp_host'),
      this.settings.get<number>('email.smtp_port'),
      this.settings.get<string>('email.smtp_user'),
      this.settings.get<string>('email.smtp_password'),
      this.settings.get<string>('email.from_address'),
    ]);
    if (!host || !from) {
      this.log.warn(`Not sent ("${subject}"): set up the We School email sender in Platform settings`);
      return false;
    }
    try {
      const transport = nodemailer.createTransport({ host, port: Number(port) || 587, secure: Number(port) === 465, auth: user ? { user, pass: password } : undefined });
      await transport.sendMail({ from, to: recipients, subject, text, attachments: attachments.map((a) => ({ ...a, content: Buffer.from(a.content) })) });
      return true;
    } catch (err) {
      this.log.warn(`Email "${subject}" to ${recipients.join(', ')} failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** Checks the SMTP account (connect and authenticate, nothing is sent). */
  async verify(): Promise<{ ok: boolean; message: string }> {
    const [host, port, user, password] = await Promise.all([
      this.settings.get<string>('email.smtp_host'),
      this.settings.get<number>('email.smtp_port'),
      this.settings.get<string>('email.smtp_user'),
      this.settings.get<string>('email.smtp_password'),
    ]);
    if (!host) return { ok: false, message: 'Enter the SMTP host first' };
    try {
      await nodemailer.createTransport({ host, port: Number(port) || 587, secure: Number(port) === 465, auth: user ? { user, pass: password } : undefined }).verify();
      return { ok: true, message: `Connected to ${host}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message.slice(0, 300) };
    }
  }
}
