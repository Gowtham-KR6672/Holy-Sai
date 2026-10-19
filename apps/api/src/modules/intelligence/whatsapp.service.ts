import { Injectable, Logger } from '@nestjs/common';
import type { AdmissionLead, WhatsappConversation } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../common/prisma.service';
import { LeadsService, type Actor as LeadActor } from '../admissions/leads.service';
import { AiService } from '../ai/ai.service';
import { AuditService } from '../audit/audit.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { MessagingService } from '../integrations/messaging.service';
import { CommunicationsService } from '../parents/communications.service';
import { gradeIn, normalizeQuestion, truncate } from './intel.util';
import { KnowledgeLive } from './knowledge.live';
import { KnowledgeService, type Hit } from './knowledge.service';
import { IntelPeople } from './people.service';

/**
 * WhatsApp AI assistant (Meta WhatsApp Cloud API).
 *  - The webhook is verified with the integration's verify token (GET) and every delivery with the app
 *    secret (X-Hub-Signature-256 over the raw body).
 *  - Each inbound text is matched to a family (guardian phone) or treated as a prospective parent, answered
 *    only from approved school records and documents (AI purpose "whatsapp", or deterministic replies when
 *    no AI provider is connected), and escalated to people for complaints, safeguarding, discounts and
 *    anything it cannot answer.
 *  - Every message is logged: the conversation, admissions CRM communications (automated replies are
 *    flagged), the family's communication log, and a WhatsApp admissions enquiry for prospective parents.
 */

type Intent = 'answer' | 'admission' | 'visit' | 'fees' | 'complaint' | 'safeguarding' | 'human' | 'unknown';

interface Inbound {
  id: string;
  from: string;
  name: string | null;
  type: string;
  text: string;
  timestamp: Date;
}

interface Sender {
  kind: 'family' | 'prospect';
  guardian: { id: string; fullName: string; language: string } | null;
  children: { id: string; firstName: string; fullName: string; grade: string; gradeLevel: number; campusId: string }[];
  lead: AdmissionLead | null;
  campusId: string | null;
}

interface Decision {
  reply: string;
  intent: Intent;
  escalate: boolean;
  reason: string | null;
  generator: string;
  sourceIds: string[];
  lead: { parentName?: string | null; studentName?: string | null; grade?: string | number | null; curriculum?: string | null; campus?: string | null; visitRequested?: boolean; visitPreference?: string | null; transportRequired?: boolean | null } | null;
}

const SAFEGUARDING = /\b(abus\w*|harass\w*|molest\w*|touch(ed|ing) (me|her|him|my)|bull(y|ied|ying)|beat(en|ing)?|hit (my|him|her)|slap\w*|suicid\w*|self[- ]?harm|kill (my|him|her)self|unsafe|threat\w*|ragging|assault\w*|sexual\w*|inappropriate(ly)?|scared to go|hurt (my|him|her))\b/i;
const COMPLAINT = /\b(complain\w*|unhappy|disappoint\w*|angry|worst|pathetic|rude|negligen\w*|refund|not satisfied|dissatisfied|escalate|unacceptable|terrible)\b/i;
const HUMAN = /\b(talk|speak|connect)\s+(to|with)\s+(a\s+)?(person|human|someone|staff|counsel+or|principal|teacher|office|agent)\b|\bcall me\b|\bcall back\b/i;
const DISCOUNT = /\b(discount|concession|waive\w*|scholarship|fee reduction|reduce the fee|cheaper|offer price|negotiat\w*)\b/i;
const ADMISSION = /\b(admission|admit|enrol\w*|seat|join|apply|application|prospectus|visit|tour|fees?|curriculum|igcse|cambridge|grade|class|transport|bus)\b/i;
const GREETING = /^(hi|hello|hey|hai|good (morning|afternoon|evening)|namaste|vanakkam)\b/i;
const HOLD = 'Thank you for your message. A member of our team will reply to you here shortly.';

export const WHATSAPP_GUARDRAILS = [
  'Answer from approved information only: curriculum, fees, transport and timings come from the SCHOOL FACTS and APPROVED EXCERPTS below, never from general knowledge. If the answer is not there, say a member of the team will reply and set escalate=true.',
  'Hand over cleanly: anything you cannot answer goes to a named counsellor or the office with the conversation attached (set escalate=true and give the reason).',
  'Never quote, offer or negotiate a discount, concession, scholarship amount or fee waiver. Fee concessions are a human conversation (intent "fees", escalate=true).',
  'Never promise admission or a seat. You may offer to book a campus visit or an assessment; a counsellor confirms the time (intent "visit").',
  'Never share any child’s records (attendance, marks, behaviour, health or location) on WhatsApp; offer the Parent app or a call back.',
  'Complaints: reply with a short, warm acknowledgement only (intent "complaint", escalate=true).',
  'If a child may be unsafe, harmed, bullied or abused: reply calmly that the school’s safeguarding lead will contact them today, and add “If anyone is in immediate danger, please call 112.” (intent "safeguarding", escalate=true).',
];

@Injectable()
export class WhatsappService {
  private readonly log = new Logger(WhatsappService.name);
  private warnedSecret = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly messaging: MessagingService,
    private readonly ai: AiService,
    private readonly audit: AuditService,
    private readonly knowledge: KnowledgeService,
    private readonly live: KnowledgeLive,
    private readonly people: IntelPeople,
    private readonly leads: LeadsService,
    private readonly comms: CommunicationsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Webhook verification
  // ---------------------------------------------------------------------------

  private safeEqual(a: string, b: string) {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  }

  /** GET verification: returns the challenge when the verify token matches. */
  async verifySubscription(mode: unknown, token: unknown, challenge: unknown): Promise<string | null> {
    const i = await this.integrations.get('whatsapp');
    const expected = i.secrets.webhookVerifyToken || i.config.webhookVerifyToken;
    if (mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string' || !expected) return null;
    return this.safeEqual(token, expected) ? challenge : null;
  }

  /** POST verification: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body). */
  async verifySignature(raw: Buffer | undefined, header: string | undefined): Promise<boolean> {
    const i = await this.integrations.get('whatsapp');
    const secret = i.secrets.appSecret || i.config.appSecret || process.env.WHATSAPP_APP_SECRET || '';
    if (!secret) {
      if (!this.warnedSecret) {
        this.warnedSecret = true;
        this.log.warn('WhatsApp webhook deliveries are refused: no app secret is configured (integration field "appSecret" or WHATSAPP_APP_SECRET).');
      }
      return false;
    }
    if (!raw || !header) return false;
    const sig = header.trim().replace(/^sha256=/i, '').toLowerCase();
    return this.safeEqual(createHmac('sha256', secret).update(raw).digest('hex'), sig);
  }

  // ---------------------------------------------------------------------------
  // Deliveries
  // ---------------------------------------------------------------------------

  /** Handles one webhook delivery (messages and delivery statuses). */
  async handle(payload: unknown): Promise<void> {
    const i = await this.integrations.get('whatsapp');
    const body = payload as { object?: string; entry?: { changes?: { field?: string; value?: Record<string, unknown> }[] }[] };
    if (body?.object !== 'whatsapp_business_account') return;
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages' || !change.value) continue;
        const v = change.value as {
          metadata?: { phone_number_id?: string };
          contacts?: { wa_id?: string; profile?: { name?: string } }[];
          messages?: Record<string, unknown>[];
          statuses?: { id?: string; status?: string; errors?: { title?: string; message?: string }[] }[];
        };
        if (i.config.phoneNumberId && v.metadata?.phone_number_id && v.metadata.phone_number_id !== i.config.phoneNumberId) continue;
        for (const s of v.statuses ?? []) await this.status(s).catch((e) => this.log.warn(`Status update failed: ${(e as Error).message}`));
        if (!i.isEnabled) continue;
        for (const m of v.messages ?? []) {
          const msg = this.parse(m, v.contacts ?? []);
          if (!msg) continue;
          try {
            await this.process(msg);
          } catch (err) {
            this.log.error(`WhatsApp message ${msg.id} failed: ${(err as Error).stack ?? (err as Error).message}`);
          }
        }
      }
    }
  }

  private async status(s: { id?: string; status?: string; errors?: { title?: string; message?: string }[] }) {
    if (!s.id || !s.status) return;
    const map: Record<string, string> = { delivered: 'delivered', read: 'delivered', failed: 'failed' };
    const to = map[s.status];
    if (!to) return;
    await this.prisma.outboundMessage.updateMany({
      where: { providerId: s.id, channel: 'whatsapp', ...(to === 'delivered' ? { status: { in: ['sent', 'queued'] } } : {}) },
      data: { status: to, ...(to === 'failed' ? { error: (s.errors?.[0]?.message ?? s.errors?.[0]?.title ?? 'Delivery failed').slice(0, 500) } : {}) },
    });
  }

  private parse(m: Record<string, unknown>, contacts: { wa_id?: string; profile?: { name?: string } }[]): Inbound | null {
    const id = typeof m.id === 'string' ? m.id : null;
    const from = typeof m.from === 'string' ? m.from.replace(/\D/g, '') : null;
    if (!id || !from) return null;
    const type = typeof m.type === 'string' ? m.type : 'unknown';
    let text = '';
    if (type === 'text') text = String((m.text as { body?: string } | undefined)?.body ?? '');
    else if (type === 'button') text = String((m.button as { text?: string } | undefined)?.text ?? '');
    else if (type === 'interactive') {
      const it = m.interactive as { button_reply?: { title?: string }; list_reply?: { title?: string } } | undefined;
      text = String(it?.button_reply?.title ?? it?.list_reply?.title ?? '');
    }
    const ts = Number(m.timestamp);
    return {
      id, from, type, text: text.trim().slice(0, 2000),
      name: contacts.find((c) => c.wa_id === from)?.profile?.name ?? contacts[0]?.profile?.name ?? null,
      timestamp: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date(),
    };
  }

  // ---------------------------------------------------------------------------
  // One message
  // ---------------------------------------------------------------------------

  private async identify(waId: string): Promise<Sender> {
    const key = waId.slice(-10);
    const candidates = await this.prisma.guardian.findMany({ where: { phone: { contains: key.slice(-4) } }, select: { id: true, fullName: true, phone: true, language: true } });
    let guardian = candidates.find((g) => g.phone.replace(/\D/g, '').slice(-10) === key) ?? null;
    if (!guardian) {
      const alt = await this.prisma.parentProfile.findMany({ where: { altPhone: { contains: key.slice(-4) } }, select: { guardianId: true, altPhone: true } });
      const hit = alt.find((a) => (a.altPhone ?? '').replace(/\D/g, '').slice(-10) === key);
      if (hit) guardian = await this.prisma.guardian.findUnique({ where: { id: hit.guardianId }, select: { id: true, fullName: true, phone: true, language: true } });
    }
    if (guardian) {
      const links = await this.prisma.studentGuardian.findMany({
        where: { guardianId: guardian.id, student: { status: 'active' } },
        select: { student: { select: { id: true, firstName: true, fullName: true, campusId: true, section: { select: { name: true, class: { select: { name: true, gradeLevel: true } } } } } } },
      });
      const children = links.map((l) => ({
        id: l.student.id, firstName: l.student.firstName, fullName: l.student.fullName, grade: `${l.student.section.class.name}${l.student.section.name}`,
        gradeLevel: l.student.section.class.gradeLevel, campusId: l.student.campusId,
      }));
      if (children.length) return { kind: 'family', guardian, children, lead: null, campusId: children[0].campusId };
    }
    const lead = await this.prisma.admissionLead.findFirst({ where: { phoneKey: key, stage: { notIn: ['Enrolled', 'Lost'] } }, orderBy: { createdAt: 'desc' } });
    return { kind: 'prospect', guardian: null, children: [], lead, campusId: lead?.campusId ?? null };
  }

  private async process(msg: Inbound) {
    const sender = await this.identify(msg.from);
    const conv = await this.prisma.whatsappConversation.upsert({
      where: { waId: msg.from },
      create: { waId: msg.from, phoneKey: msg.from.slice(-10), profileName: msg.name, kind: sender.kind, guardianId: sender.guardian?.id ?? null, leadId: sender.lead?.id ?? null, campusId: sender.campusId },
      update: { profileName: msg.name ?? undefined, kind: sender.kind, guardianId: sender.guardian?.id ?? null, ...(sender.lead ? { leadId: sender.lead.id } : {}), ...(sender.campusId ? { campusId: sender.campusId } : {}) },
    });
    // Each Meta message id is processed once (webhook retries are ignored).
    try {
      await this.prisma.whatsappMessage.create({
        data: { conversationId: conv.id, direction: 'inbound', providerMessageId: msg.id, messageType: msg.type === 'text' || msg.type === 'button' || msg.type === 'interactive' ? 'text' : msg.type, body: msg.text || `[${msg.type}]`, status: 'received' },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      throw err;
    }
    await this.prisma.whatsappConversation.update({ where: { id: conv.id }, data: { lastInboundAt: msg.timestamp, messageCount: { increment: 1 } } });

    const name = sender.guardian?.fullName ?? msg.name ?? `+${msg.from}`;
    let lead = sender.lead;
    let decision: Decision;
    const recentlyEscalated = conv.status === 'escalated' && conv.escalatedAt && Date.now() - conv.escalatedAt.getTime() < 12 * 60 * 60_000;
    const repliesToday = await this.prisma.whatsappMessage.count({ where: { conversationId: conv.id, direction: 'outbound', createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } } });

    if (!msg.text) {
      decision = { reply: 'Thank you. I can only read typed messages — please type your question, and a member of our team will help if needed.', intent: 'unknown', escalate: false, reason: null, generator: 'template', sourceIds: [], lead: null };
    } else if (recentlyEscalated && !SAFEGUARDING.test(msg.text)) {
      const lastOut = await this.prisma.whatsappMessage.findFirst({ where: { conversationId: conv.id, direction: 'outbound' }, orderBy: { createdAt: 'desc' } });
      const quiet = lastOut && Date.now() - lastOut.createdAt.getTime() < 30 * 60_000;
      decision = { reply: quiet ? '' : 'Thank you — our team has your conversation and will reply to you here shortly.', intent: 'human', escalate: false, reason: null, generator: 'template', sourceIds: [], lead: null };
    } else if (repliesToday >= 40) {
      decision = { reply: '', intent: 'unknown', escalate: false, reason: null, generator: 'template', sourceIds: [], lead: null };
    } else {
      decision = await this.decide(msg, sender, conv);
    }

    // Prospective parents: every conversation is an admissions enquiry.
    if (sender.kind === 'prospect' && msg.text && decision.intent !== 'safeguarding' && (lead || ADMISSION.test(msg.text) || GREETING.test(msg.text) || decision.intent !== 'unknown')) {
      lead = await this.upsertLead(lead, msg, decision, conv).catch((e) => {
        this.log.warn(`WhatsApp enquiry not saved: ${(e as Error).message}`);
        return lead;
      });
    }

    // Reply.
    let sent: { ok: boolean; error?: string } = { ok: false };
    if (decision.reply) {
      sent = await this.messaging.send('whatsapp', { to: msg.from, body: decision.reply }, { entityType: 'whatsapp_conversation', entityId: conv.id });
      await this.prisma.whatsappMessage.create({
        data: {
          conversationId: conv.id, direction: 'outbound', body: decision.reply, intent: decision.intent, escalated: decision.escalate, generator: decision.generator,
          status: sent.ok ? 'sent' : 'failed', error: sent.error?.slice(0, 500) ?? null, sourceIds: decision.sourceIds,
        },
      });
      await this.prisma.whatsappConversation.update({ where: { id: conv.id }, data: { lastOutboundAt: new Date() } });
    }
    await this.prisma.whatsappMessage.updateMany({ where: { providerMessageId: msg.id }, data: { intent: decision.intent, escalated: decision.escalate } });

    await this.log2Crm(msg, decision, sent, sender, lead, name);
    // Informational questions only (never complaints, concerns or personal requests) count towards "most asked".
    if (msg.text && ['answer', 'admission', 'visit', 'fees'].includes(decision.intent) && !DISCOUNT.test(msg.text)) {
      await this.prisma.knowledgeQuestion.create({
        data: {
          channel: 'whatsapp', roleKey: sender.kind === 'family' ? 'parent' : 'prospect', campusId: lead?.campusId ?? sender.campusId, question: truncate(msg.text, 300),
          normalized: normalizeQuestion(truncate(msg.text, 300)), found: !decision.escalate && decision.intent !== 'unknown', kind: 'documents', sourceIds: decision.sourceIds,
        },
      }).catch(() => undefined);
    }
    if (decision.escalate) await this.escalate(conv, decision, msg, sender, lead, name);
  }

  /** Chooses the reply: deterministic escalations first, then the AI (or templates without one). */
  private async decide(msg: Inbound, sender: Sender, conv: WhatsappConversation): Promise<Decision> {
    const text = msg.text;
    const base = { generator: 'template', sourceIds: [] as string[], lead: null };
    if (SAFEGUARDING.test(text)) {
      return { ...base, intent: 'safeguarding', escalate: true, reason: 'Possible safeguarding concern', reply: 'Thank you for telling us. I have passed your message to the school’s safeguarding lead, who will contact you today. If anyone is in immediate danger, please call 112.' };
    }
    if (COMPLAINT.test(text)) {
      return { ...base, intent: 'complaint', escalate: true, reason: 'Complaint', reply: 'Thank you for letting us know, and I am sorry for the trouble. I have passed your message to the school office, and a member of staff will contact you shortly.' };
    }
    if (DISCOUNT.test(text)) {
      return { ...base, intent: 'fees', escalate: true, reason: 'Fee concession or discount request', reply: 'Fee concessions and scholarships are discussed personally with our admissions team. I have asked a counsellor to contact you.' };
    }
    if (HUMAN.test(text)) {
      return { ...base, intent: 'human', escalate: true, reason: 'Asked to speak to a person', reply: 'Of course — I have asked a member of our team to contact you. They will reply here or call you shortly.' };
    }

    const grade = gradeIn(text) ?? (sender.lead?.gradeLevel || null) ?? (sender.children.length === 1 ? sender.children[0].gradeLevel : null);
    const campusId = sender.campusId;
    const [facts, search] = await Promise.all([
      this.live.whatsappFacts({ campusId, grade, family: sender.kind === 'family' }),
      this.knowledge.search(text, { kind: 'whatsapp', family: sender.kind === 'family', campusId }, 3),
    ]);
    const hits: Hit[] = search.hits.filter((h) => h.coverage >= 0.5);
    const status = await this.ai.status('whatsapp');
    if (status.available) {
      try {
        return await this.aiDecide(msg, sender, conv, facts, hits);
      } catch (err) {
        this.log.warn(`WhatsApp AI unavailable, using templates: ${(err as Error).message}`);
      }
    }
    return this.templateDecide(text, sender, facts, hits, grade);
  }

  private async aiDecide(msg: Inbound, sender: Sender, conv: WhatsappConversation, facts: string[], hits: Hit[]): Promise<Decision> {
    const history = await this.prisma.whatsappMessage.findMany({ where: { conversationId: conv.id, NOT: { providerMessageId: msg.id } }, orderBy: { createdAt: 'desc' }, take: 8 });
    const who = sender.kind === 'family'
      ? `a parent of current students (${sender.children.map((c) => `${c.firstName}, ${c.grade}`).join('; ')})`
      : `a prospective parent${sender.lead ? ` (enquiry ${sender.lead.code}: ${sender.lead.studentName}, ${sender.lead.grade})` : ''}`;
    const system = [
      'You are the WhatsApp assistant of Holy Sai International School, a Cambridge curriculum school in India. Follow these rules strictly:',
      ...WHATSAPP_GUARDRAILS.map((g, i) => `${i + 1}. ${g}`),
      `${WHATSAPP_GUARDRAILS.length + 1}. Keep replies under 90 words, warm and plain. No markdown. Reply in Tamil or Hindi only if the parent wrote in it.`,
      `You are talking to ${who}.`,
      '',
      'SCHOOL FACTS (from school records):',
      ...(facts.length ? facts.map((f) => `- ${f}`) : ['- (none recorded)']),
      '',
      'APPROVED EXCERPTS:',
      ...(hits.length ? hits.map((h, i) => `[${i + 1}] ${h.title}${h.heading ? ` — ${h.heading}` : ''}: ${truncate(h.text, 700)}`) : ['(none matched)']),
      '',
      'Return JSON only: {"reply":"…","intent":"answer|admission|visit|fees|complaint|safeguarding|human|unknown","escalate":true|false,"reason":"…or null","lead":{"parentName":null,"studentName":null,"grade":null,"curriculum":null,"campus":null,"visitRequested":false,"visitPreference":null,"transportRequired":null}}',
      'Fill "lead" only with details the parent actually stated.',
    ].join('\n');
    const messages = [
      ...history.reverse().map((h) => ({ role: (h.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant', content: h.body })),
      { role: 'user' as const, content: msg.text },
    ];
    // Providers need alternating turns starting with the user.
    const merged: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of messages) {
      if (merged.length && merged[merged.length - 1].role === m.role) merged[merged.length - 1].content += `\n${m.content}`;
      else merged.push({ ...m });
    }
    while (merged.length && merged[0].role !== 'user') merged.shift();
    const r = await this.ai.completeJson<{ reply?: string; intent?: string; escalate?: boolean; reason?: string | null; lead?: Decision['lead'] }>('whatsapp', { system, messages: merged, maxTokens: 500, temperature: 0.2 });
    const intents: Intent[] = ['answer', 'admission', 'visit', 'fees', 'complaint', 'safeguarding', 'human', 'unknown'];
    let intent: Intent = intents.includes(r.data.intent as Intent) ? (r.data.intent as Intent) : 'unknown';
    let reply = (r.data.reply ?? '').trim().replace(/\*\*/g, '').slice(0, 1200);
    let escalate = !!r.data.escalate || intent === 'complaint' || intent === 'safeguarding' || intent === 'human' || intent === 'unknown';
    let reason = r.data.reason ?? (escalate ? 'The assistant could not answer from approved information' : null);
    // Guardrails on the reply itself: amounts must come from the records, and no discounts or promises.
    const known = facts.join(' ') + ' ' + hits.map((h) => h.text).join(' ');
    const knownDigits = new Set((known.match(/\d[\d,]*/g) ?? []).map((x) => x.replace(/,/g, '')));
    const amounts = (reply.match(/(₹|rs\.?|inr)\s?\d[\d,]*/gi) ?? []).map((a) => a.replace(/\D/g, ''));
    if (amounts.some((a) => !knownDigits.has(a)) || /\b(discount|guarantee\w*|assured (seat|admission)|confirmed (seat|admission)|seat is (yours|confirmed))\b/i.test(reply)) {
      reply = HOLD;
      escalate = true;
      intent = 'human';
      reason = 'Reply withheld by guardrails (unverified amount, discount or promise)';
    }
    if (!reply) {
      reply = HOLD;
      escalate = true;
    }
    if (intent === 'safeguarding' && !/112/.test(reply)) reply += ' If anyone is in immediate danger, please call 112.';
    return { reply, intent, escalate, reason, generator: `${r.provider}:${r.model}`, sourceIds: [...new Set(hits.map((h) => h.sourceId))], lead: r.data.lead ?? null };
  }

  /** Replies without a language model: record-based facts, best document passage, or a hand-over. */
  private templateDecide(text: string, sender: Sender, facts: string[], hits: Hit[], grade: number | null): Decision {
    const base = { generator: 'template', lead: null, sourceIds: [] as string[] };
    const lower = text.toLowerCase();
    if (/\b(fees?|tuition|cost)\b/.test(lower)) {
      const lines = facts.filter((f) => f.startsWith('Fees ') && (!grade || new RegExp(`Grade ${grade}\\b`).test(f)));
      if (grade && lines.length) {
        return { ...base, intent: 'fees', escalate: sender.kind === 'prospect', reason: sender.kind === 'prospect' ? 'Admissions enquiry — counsellor follow-up' : null, reply: `${lines.slice(0, 3).map((l) => l.replace(/^Fees\s+/, 'Fees ').replace(/; heads:.*?; total/, '; total')).join('\n')}\n\nA counsellor can explain what is included. Would you like to book a campus visit?` };
      }
      return { ...base, intent: 'fees', escalate: true, reason: 'Fee question without an approved fee structure for the grade', reply: `Thank you. ${grade ? `I will ask our admissions team to share the Grade ${grade} fee details with you.` : 'Which grade are you asking about? Our admissions team will share the exact fee details.'}` };
    }
    if (hits.length && hits[0].coverage >= 0.6) {
      const passage = this.knowledge.extractive(hits.slice(0, 1), [...new Set(hits[0].matched)]) || truncate(hits[0].text, 400);
      return { ...base, intent: 'answer', escalate: false, reason: null, sourceIds: [hits[0].sourceId], reply: `${truncate(passage, 700)}\n\n(From: ${hits[0].title})` };
    }
    if (sender.kind === 'prospect') {
      const campuses = facts.filter((f) => f.startsWith('Campus: ')).map((f) => f.replace('Campus: ', ''));
      const intro = campuses.length ? `Holy Sai International School offers the Cambridge curriculum${campuses.length ? ` at ${campuses.map((c) => c.split(' — ')[0]).join(', ')}` : ''}.` : 'Thank you for your interest in Holy Sai International School.';
      return { ...base, intent: 'admission', escalate: true, reason: 'New admissions enquiry — counsellor to reply', reply: `Thank you for contacting us! ${intro} I have shared your enquiry with our admissions team, who will reply here shortly${grade ? ` about Grade ${grade}` : ''}. You are welcome to visit the campus — just tell us a convenient day.` };
    }
    return { ...base, intent: 'human', escalate: true, reason: 'Family message — office to reply', reply: HOLD };
  }

  // ---------------------------------------------------------------------------
  // Admissions enquiry, logging and escalation
  // ---------------------------------------------------------------------------

  private async upsertLead(lead: AdmissionLead | null, msg: Inbound, d: Decision, conv: WhatsappConversation): Promise<AdmissionLead> {
    const actor = { id: null, fullName: 'WhatsApp AI' } as unknown as LeadActor;
    const info = d.lead ?? {};
    const g = (typeof info.grade === 'number' ? info.grade : gradeIn(String(info.grade ?? '')) ?? gradeIn(msg.text)) || null;
    const campuses = await this.prisma.campus.findMany({ where: { isActive: true }, select: { id: true, name: true, place: true }, orderBy: { name: 'asc' } });
    const named = info.campus ? campuses.find((c) => `${c.name} ${c.place}`.toLowerCase().includes(String(info.campus).toLowerCase())) : undefined;
    const textCampus = campuses.find((c) => msg.text.toLowerCase().includes(c.place.toLowerCase()));
    const visit = !!info.visitRequested || d.intent === 'visit';
    if (!lead) {
      const campus = named ?? textCampus ?? (campuses.length === 1 ? campuses[0] : campuses[0]);
      if (!campus) throw new Error('No campus is set up');
      const counsellors = (await this.leads.counsellors(campus.id)).filter((c) => c.hasAccount).sort((a, b) => a.openLeads - b.openLeads);
      const score = Math.min(95, 50 + (g ? 10 : 0) + (visit ? 10 : 0) + (info.curriculum ? 5 : 0));
      lead = await this.leads.createLead({
        campusId: campus.id,
        parentName: (info.parentName || msg.name || `WhatsApp +${msg.from}`).slice(0, 120),
        phone: `+${msg.from}`,
        studentName: (info.studentName || 'To be confirmed').slice(0, 120),
        grade: g ? `Grade ${g}` : 'Not specified',
        curriculum: info.curriculum ?? (/igcse/i.test(msg.text) ? 'Cambridge IGCSE' : null),
        source: 'WhatsApp',
        campaign: null,
        score,
        counsellorId: counsellors[0]?.id ?? null,
        transportRequired: !!info.transportRequired,
        notes: `First WhatsApp message: ${truncate(msg.text, 400)}`,
      }, actor);
      await this.prisma.whatsappConversation.update({ where: { id: conv.id }, data: { leadId: lead.id, campusId: lead.campusId } });
    } else {
      const data: Prisma.AdmissionLeadUpdateInput = {};
      if (info.studentName && /to be confirmed/i.test(lead.studentName)) data.studentName = info.studentName.slice(0, 120);
      if (info.parentName && /^WhatsApp \+/.test(lead.parentName)) data.parentName = info.parentName.slice(0, 120);
      if (g && (!lead.gradeLevel || lead.grade === 'Not specified')) Object.assign(data, { grade: `Grade ${g}`, gradeLevel: g });
      if (info.curriculum && !lead.curriculum) data.curriculum = info.curriculum;
      if (info.transportRequired && !lead.transportRequired) data.transportRequired = true;
      const bump = (visit ? 10 : 0) + (data.grade ? 5 : 0);
      if (bump) data.score = Math.min(95, lead.score + bump);
      if (Object.keys(data).length) lead = await this.prisma.admissionLead.update({ where: { id: lead.id }, data });
    }
    if (visit) {
      const open = await this.prisma.admissionFollowUp.findFirst({ where: { leadId: lead.id, status: 'Scheduled', notes: { startsWith: 'Visit request' } } });
      if (!open) {
        const tomorrow10 = new Date(Date.now() + 24 * 60 * 60_000);
        tomorrow10.setUTCHours(4, 30, 0, 0); // 10:00 school time
        await this.leads.scheduleFollowUp(lead, {
          type: 'Call', scheduledAt: tomorrow10, assignedTo: lead.counsellorId,
          notes: `Visit request via WhatsApp${info.visitPreference ? ` — prefers ${truncate(String(info.visitPreference), 80)}` : ''}: confirm a campus visit time`,
        }, actor).catch((e) => this.log.warn(`Visit follow-up not created: ${(e as Error).message}`));
      }
    }
    return lead;
  }

  private async log2Crm(msg: Inbound, d: Decision, sent: { ok: boolean; error?: string }, sender: Sender, lead: AdmissionLead | null, name: string) {
    const link = sender.kind === 'family' ? { guardianId: sender.guardian!.id } : lead ? { leadId: lead.id } : null;
    if (link) {
      const counterpart = sender.guardian?.fullName ?? lead?.parentName ?? name;
      await this.prisma.crmCommunication.create({
        data: { ...link, counterpart, channel: 'WhatsApp', direction: 'Inbound', subject: truncate(msg.text || `[${msg.type}]`, 120), body: msg.text || null, status: 'Received', automated: false, occurredAt: msg.timestamp },
      });
      if (d.reply) {
        await this.prisma.crmCommunication.create({
          data: {
            ...link, counterpart, channel: 'WhatsApp', direction: 'Outbound', subject: d.escalate ? `WhatsApp AI — handed over (${d.reason ?? d.intent})` : 'WhatsApp AI reply',
            body: d.reply, status: sent.ok ? 'Sent' : 'Failed', automated: true, sentByName: 'WhatsApp AI',
          },
        });
      }
    }
    if (sender.kind === 'family' && sender.guardian && msg.text) {
      // The family communication log; escalated messages join the unanswered queue.
      const inbound = await this.comms.recordInbound({
        guardianId: sender.guardian.id, studentId: sender.children.length === 1 ? sender.children[0].id : null, channel: 'WhatsApp',
        subject: truncate(msg.text, 80), body: msg.text, needsReply: d.escalate && d.intent !== 'safeguarding',
      }).catch((e) => {
        this.log.warn(`Family log not written: ${(e as Error).message}`);
        return null;
      });
      if (inbound && d.reply) {
        await this.prisma.commMessage.create({
          data: {
            guardianId: sender.guardian.id, studentId: inbound.studentId, campusId: inbound.campusId, channel: 'WhatsApp', direction: 'outbound', counterpart: sender.guardian.fullName,
            subject: 'WhatsApp AI reply', body: d.reply, status: sent.ok ? 'Sent' : 'Failed', deliveryError: sent.ok ? null : sent.error?.slice(0, 300) ?? null,
            sentByName: 'WhatsApp AI', replyToId: inbound.id, entityType: 'whatsapp_conversation',
          },
        }).catch(() => undefined);
      }
    }
  }

  private async escalate(conv: WhatsappConversation, d: Decision, msg: Inbound, sender: Sender, lead: AdmissionLead | null, name: string) {
    await this.prisma.whatsappConversation.update({ where: { id: conv.id }, data: { status: 'escalated', escalatedAt: new Date(), escalationReason: d.reason ?? d.intent } });
    const campusId = lead?.campusId ?? sender.campusId;
    const who = sender.kind === 'family' ? `${name} (parent of ${sender.children.map((c) => c.firstName).join(', ')})` : `${name}${lead ? ` · enquiry ${lead.code}` : ''}`;
    const route = sender.kind === 'family' ? '/parent-communication' : lead ? `/leads?lead=${lead.code}` : '/enquiries';
    const body = `“${truncate(msg.text, 240)}” — WhatsApp +${msg.from}`;
    if (d.intent === 'safeguarding') {
      const dsl = await this.people.usersWithPermission('students.sensitive', campusId);
      await this.people.notify(dsl, { category: 'Critical', topic: 'safety', module: 'safety', icon: 'shield', campusId, title: `Possible safeguarding concern on WhatsApp from ${who}`, body, route, deliver: true });
      await this.people.tasks(dsl, { title: `Safeguarding: contact ${name} today (WhatsApp)`, module: 'safety', priority: 'High', status: 'Pending', route, entityType: 'whatsapp_conversation', entityId: conv.id, dueOn: new Date() });
    } else {
      let owners: string[] = [];
      if (lead?.counsellorId && sender.kind === 'prospect') {
        const u = (await this.people.usersOfEmployees([lead.counsellorId])).get(lead.counsellorId);
        if (u) owners = [u];
      }
      if (!owners.length) owners = await this.people.frontOffice(campusId);
      await this.people.tasks(owners, {
        title: `${d.intent === 'complaint' ? 'Complaint' : 'Reply'} on WhatsApp: ${name}${d.reason ? ` — ${truncate(d.reason, 60)}` : ''}`,
        module: sender.kind === 'family' ? 'parents' : 'admissions', priority: d.intent === 'complaint' ? 'High' : 'Medium', status: 'Pending', route,
        entityType: 'whatsapp_conversation', entityId: conv.id, dueOn: new Date(),
      });
      await this.people.notify(owners, {
        category: d.intent === 'complaint' ? 'Critical' : 'Attention', topic: 'system', module: sender.kind === 'family' ? 'parents' : 'admissions', icon: 'message', campusId,
        title: `WhatsApp ${d.intent === 'complaint' ? 'complaint' : 'message'} needs a person: ${name}`, body, route,
      });
    }
    await this.audit.record({
      userName: 'WhatsApp AI', action: 'create', module: 'whatsapp', entityType: 'whatsapp_conversation', entityId: conv.id, campusId, sensitive: d.intent === 'safeguarding',
      description: `WhatsApp conversation with ${sender.kind === 'family' ? 'a family' : 'a prospective parent'} handed to staff: ${d.reason ?? d.intent}`,
    });
  }
}
