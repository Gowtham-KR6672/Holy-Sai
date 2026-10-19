import { Controller, Get, Headers, HttpCode, Logger, Post, Req, Res, type RawBodyRequest } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators';
import { WhatsappService } from './whatsapp.service';

/**
 * Meta WhatsApp Cloud API webhook (no sign-in).
 *   GET  /api/whatsapp/webhook  — subscription check: echoes hub.challenge when hub.verify_token matches the
 *                                  WhatsApp integration's "Webhook verify token".
 *   POST /api/whatsapp/webhook  — deliveries, accepted only with a valid X-Hub-Signature-256 (app secret),
 *                                  acknowledged at once and processed in the background.
 */
@Controller('whatsapp')
@Public()
@SkipThrottle()
export class WhatsappController {
  private readonly log = new Logger(WhatsappController.name);

  constructor(private readonly wa: WhatsappService) {}

  @Get('webhook')
  async verify(@Req() req: Request, @Res() res: Response) {
    const q = req.query as Record<string, unknown>;
    const challenge = await this.wa.verifySubscription(q['hub.mode'], q['hub.verify_token'], q['hub.challenge']);
    if (challenge === null) {
      res.status(403).type('text/plain').send('Verification failed');
      return;
    }
    res.status(200).type('text/plain').send(challenge);
  }

  @Post('webhook')
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature: string | undefined, @Res() res: Response) {
    if (!(await this.wa.verifySignature(req.rawBody, signature))) {
      res.status(401).json({ success: false, message: 'Invalid signature', error: 'UNAUTHORIZED' });
      return;
    }
    // Meta expects a quick 200; replies are sent after the acknowledgement.
    res.status(200).json({ success: true, data: { received: true }, message: 'OK' });
    let payload: unknown = req.body;
    if (req.rawBody) {
      try {
        payload = JSON.parse(req.rawBody.toString('utf8'));
      } catch {
        /* keep the parsed body */
      }
    }
    void this.wa.handle(payload).catch((err) => this.log.error(`WhatsApp webhook failed: ${(err as Error).message}`));
  }
}
