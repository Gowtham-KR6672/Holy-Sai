import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { KnowledgeSource } from '@prisma/client';
import type { AuthUser } from '../../common/auth-user';
import { PrismaService } from '../../common/prisma.service';
import { PerWorkspace } from '../../tenancy/context';
import { AiService } from '../ai/ai.service';
import { StorageService } from '../operations/storage.service';
import { extractText, readable } from './knowledge.text';
import { asDate, dayKey, schoolToday, truncate } from './intel.util';
import { ForEachWorkspace } from '../../tenancy/for-each-workspace.decorator';

/**
 * School Knowledge: the approved sources the assistants may answer from, their indexed text, and
 * keyword retrieval. Sources are
 *  - verified school documents (Operations › Documents, not student or staff files, not expired), and
 *  - released circulars (Parent communication).
 * Each source has a visibility: public (prospective parents too), families, staff, or restricted
 * (only people who can already read safeguarding/wellbeing records).
 */

export type Visibility = 'public' | 'families' | 'staff' | 'restricted';
export type Audience = { kind: 'user'; user: AuthUser; campusId?: string } | { kind: 'whatsapp'; family: boolean; campusId?: string | null };

export interface Hit {
  chunkId: string;
  sourceId: string;
  title: string;
  section: string | null;
  heading: string | null;
  text: string;
  updated: string;
  score: number;
  matched: string[];
  coverage: number;
  restricted: boolean;
}

interface IndexedChunk {
  id: string;
  sourceId: string;
  heading: string | null;
  text: string;
  tf: Map<string, number>;
  headTerms: Set<string>;
  len: number;
}

const RESTRICTED = /safeguard|child protection|pocso|posh|harass|disciplin|investigat|confidential|medical|counsel|incident|payroll|salary|appraisal|grievance|whistle/i;
const STAFF_ONLY = /\bstaff\b|employee|\bhr\b|human resource|faculty|internal|\bsop\b|finance|budget|procure|vendor|audit|compliance|minutes|appointment letter|service rules/i;
const PUBLIC = /admission|prospectus|\bfees?\b|transport|\bbus\b|curriculum|uniform|timing|calendar|holiday|faq|brochure|syllabus|facilit|about us|enrol|igcse|cambridge/i;

const STOP = new Set(
  ('a an the and or but if of to in on at by for from with about into over under is are was were be been being am do does did done have has had ' +
    'what whats which who whom whose when where why how can could should would will shall may might must i me my we our us you your it its they them their ' +
    'this that these those there here please tell show give know any some all each every more most much many get got let lets also just than then so ' +
    'school holy sai hsis international student students')
    .split(/\s+/),
);

export function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9ऀ-෿]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

/** Splits text into passages of about 900 characters, each under its nearest heading. */
export function chunkText(text: string): { heading: string | null; text: string }[] {
  const lines = text.split('\n').map((l) => l.trim());
  const out: { heading: string | null; text: string }[] = [];
  let heading: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (t.length >= 20) out.push({ heading, text: t });
    buf = [];
  };
  const isHeading = (l: string) =>
    l.startsWith('## ') ||
    (l.length <= 80 && !/[.,;:]$/.test(l) && l.split(/\s+/).length <= 10 &&
      (/^(\d+(\.\d+)*[.)]?|[A-Z][.)])\s+\S/.test(l) || /^[A-Z0-9][A-Z0-9 &/,'()-]{3,}$/.test(l) ||
        (l.split(/\s+/).length <= 8 && /^[A-Z][\w'’&-]*(\s+([A-Z][\w'’&()-]*|and|of|for|the|to|in|on|at|a|an|&|–|-))*$/.test(l))));
  for (const l of lines) {
    if (!l) {
      if (buf.join(' ').length > 600) flush();
      continue;
    }
    if (isHeading(l)) {
      flush();
      heading = l.replace(/^## /, '').slice(0, 120);
      continue;
    }
    buf.push(l);
    if (buf.join(' ').length > 900) flush();
  }
  flush();
  return out;
}

interface KnowledgeState {
  lastSync: number;
  syncing: Promise<void> | null;
  index: { chunks: IndexedChunk[]; df: Map<string, number>; avg: number; sources: Map<string, KnowledgeSource> } | null;
  roleCache: { at: number; staff: string[]; sensitive: string[] } | null;
}

@Injectable()
export class KnowledgeService implements OnModuleInit {
  private readonly log = new Logger(KnowledgeService.name);
  /** Each school has its own index, sync state and role audiences. */
  private readonly state = new PerWorkspace<KnowledgeState>(() => ({ lastSync: 0, syncing: null, index: null, roleCache: null }));

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly ai: AiService,
  ) {}

  private get st(): KnowledgeState {
    return this.state.get();
  }

  onModuleInit() {
    // Index every school in the background shortly after start-up.
    setTimeout(() => void this.hourly(), 15_000).unref?.();
  }

  @Cron('15 * * * *', { name: 'knowledge-sync' })
  @ForEachWorkspace('knowledge-sync')
  async hourly() {
    await this.sync(true);
  }

  // ---------------------------------------------------------------------------
  // Indexing
  // ---------------------------------------------------------------------------

  private async roles() {
    if (this.st.roleCache && Date.now() - this.st.roleCache.at < 10 * 60_000) return this.st.roleCache;
    const roles = await this.prisma.role.findMany({ select: { key: true, permissions: { select: { permissionKey: true } } }, orderBy: { sortOrder: 'asc' } });
    this.st.roleCache = {
      at: Date.now(),
      staff: roles.filter((r) => !['parent', 'student'].includes(r.key)).map((r) => r.key),
      sensitive: roles.filter((r) => r.permissions.some((p) => p.permissionKey === 'students.sensitive')).map((r) => r.key),
    };
    return this.st.roleCache;
  }

  private visibilityOf(text: string): Visibility {
    if (RESTRICTED.test(text)) return 'restricted';
    if (STAFF_ONLY.test(text)) return 'staff';
    if (PUBLIC.test(text)) return 'public';
    return 'families';
  }

  private async audienceOf(v: Visibility): Promise<string[]> {
    const r = await this.roles();
    return v === 'restricted' ? r.sensitive : v === 'staff' ? r.staff : [];
  }

  private keywordsOf(text: string): string[] {
    const counts = new Map<string, number>();
    for (const w of text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)) {
      if (w.length < 5 || STOP.has(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
  }

  /** Brings the index in step with the approved documents and released circulars. */
  async sync(force = false): Promise<void> {
    const st = this.st;
    if (st.syncing) return st.syncing;
    if (!force && Date.now() - st.lastSync < 2 * 60_000) return;
    st.syncing = this.runSync().catch((err) => this.log.warn(`Knowledge sources not refreshed: ${(err as Error).message}`)).finally(() => {
      st.syncing = null;
      st.lastSync = Date.now();
    });
    return st.syncing;
  }

  private async runSync() {
    const today = asDate(schoolToday());
    const [docs, circulars, existing] = await Promise.all([
      this.prisma.opsDocument.findMany({
        where: { studentId: null, employeeId: null, status: 'Verified', storageKey: { not: null }, OR: [{ expiresOn: null }, { expiresOn: { gte: today } }] },
        select: { id: true, name: true, category: true, collection: true, campusId: true, storageKey: true, mimeType: true, originalName: true, sizeBytes: true, sha256: true, verifiedAt: true, updatedAt: true },
      }),
      this.prisma.commCircular.findMany({
        where: { status: 'Released' },
        select: { id: true, reference: true, title: true, body: true, audience: true, audienceLabel: true, campusId: true, releasedAt: true, updatedAt: true },
      }),
      this.prisma.knowledgeSource.findMany({ select: { id: true, kind: true, refId: true, contentHash: true, status: true, indexedAt: true } }),
    ]);
    let changed = false;
    const live = new Set([...docs.map((d) => `document|${d.id}`), ...circulars.map((c) => `circular|${c.id}`)]);
    const gone = existing.filter((e) => !live.has(`${e.kind}|${e.refId}`)).map((e) => e.id);
    if (gone.length) {
      await this.prisma.knowledgeSource.deleteMany({ where: { id: { in: gone } } });
      changed = true;
    }
    const byRef = new Map(existing.map((e) => [`${e.kind}|${e.refId}`, e]));
    const dayAgo = Date.now() - 24 * 60 * 60_000;

    for (const c of circulars) {
      const hash = `c:${c.updatedAt.toISOString()}`;
      const prev = byRef.get(`circular|${c.id}`);
      if (prev?.contentHash === hash) continue;
      const staff = (c.audience as { kind?: string } | null)?.kind === 'staff';
      const visibility: Visibility = staff ? 'staff' : 'families';
      const text = `## ${c.title}\n${c.body}`;
      await this.save({
        kind: 'circular', refId: c.id, title: c.title, section: `Circular ${c.reference} · ${c.audienceLabel}`, campusId: c.campusId, visibility,
        audience: await this.audienceOf(visibility), contentHash: hash, sourceUpdatedAt: c.releasedAt ?? c.updatedAt, text, status: 'indexed', error: null,
      });
      changed = true;
    }

    for (const d of docs) {
      const hash = `d:${d.sha256 ?? ''}:${d.updatedAt.toISOString()}`;
      const prev = byRef.get(`document|${d.id}`);
      if (prev?.contentHash === hash && (prev.status === 'indexed' || prev.indexedAt.getTime() > dayAgo)) continue;
      const label = `${d.collection ?? ''} ${d.category} ${d.name}`;
      const visibility = this.visibilityOf(label);
      let text = '';
      let status = 'indexed';
      let error: string | null = null;
      try {
        const buf = await this.storage.read(d.storageKey!);
        text = extractText(buf, d.mimeType, d.originalName ?? d.name);
        if (!readable(text)) text = (await this.aiTranscribe(buf, d.mimeType, d.originalName ?? d.name)) ?? text;
        if (!readable(text)) {
          status = 'no_text';
          error = 'No readable text could be taken from this file. Upload a text-based PDF or Word file, or connect an AI provider that reads documents.';
        }
      } catch (err) {
        status = 'failed';
        error = (err as Error).message.slice(0, 300);
      }
      await this.save({
        kind: 'document', refId: d.id, title: d.name, section: d.collection ?? d.category, campusId: d.campusId, visibility, audience: await this.audienceOf(visibility),
        contentHash: hash, sourceUpdatedAt: d.verifiedAt ?? d.updatedAt, text: status === 'indexed' ? text : '', status, error,
      });
      changed = true;
    }
    if (changed || !this.st.index) this.st.index = null;
  }

  private async aiTranscribe(buf: Buffer, mime: string | null, name: string): Promise<string | null> {
    const isPdf = mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf');
    const isImage = !!mime && /^image\/(png|jpeg|webp)$/.test(mime);
    if ((!isPdf && !isImage) || buf.length > 10 * 1024 * 1024) return null;
    const status = await this.ai.status('knowledge');
    if (!status.available) return null;
    try {
      const r = await this.ai.complete('knowledge', {
        system: 'You transcribe school documents. Output only the document text, in reading order. Start each heading line with "## ". Do not summarise or add anything.',
        messages: [{
          role: 'user',
          content: [isPdf ? { type: 'pdf', data: buf.toString('base64') } : { type: 'image', mediaType: mime!, data: buf.toString('base64') }, { type: 'text', text: 'Transcribe the full text of this document.' }],
        }],
        maxTokens: 8000,
        temperature: 0,
      }, { vision: true });
      return r.text;
    } catch (err) {
      this.log.warn(`AI could not read ${name}: ${(err as Error).message}`);
      return null;
    }
  }

  private async save(s: {
    kind: string; refId: string; title: string; section: string | null; campusId: string | null; visibility: Visibility; audience: string[]; contentHash: string;
    sourceUpdatedAt: Date; text: string; status: string; error: string | null;
  }) {
    const chunks = s.text ? chunkText(s.text) : [];
    const data = {
      title: s.title, section: s.section, campusId: s.campusId, visibility: s.visibility, audience: s.audience, restricted: s.visibility === 'restricted',
      keywords: this.keywordsOf(s.text), status: s.status, error: s.error, contentHash: s.contentHash, sourceUpdatedAt: s.sourceUpdatedAt, indexedAt: new Date(),
    };
    await this.prisma.$transaction(async (tx) => {
      const src = await tx.knowledgeSource.upsert({ where: { kind_refId: { kind: s.kind, refId: s.refId } }, create: { kind: s.kind, refId: s.refId, ...data }, update: data });
      await tx.knowledgeChunk.deleteMany({ where: { sourceId: src.id } });
      if (chunks.length) await tx.knowledgeChunk.createMany({ data: chunks.map((c, i) => ({ sourceId: src.id, ordinal: i, heading: c.heading, text: c.text })) });
    });
  }

  private async loadIndex() {
    if (this.st.index) return this.st.index;
    let sources: KnowledgeSource[] = [];
    let chunks: { id: string; sourceId: string; heading: string | null; text: string }[] = [];
    try {
      [sources, chunks] = await Promise.all([
        this.prisma.knowledgeSource.findMany({ where: { status: 'indexed' } }),
        this.prisma.knowledgeChunk.findMany({ select: { id: true, sourceId: true, heading: true, text: true } }),
      ]);
    } catch (err) {
      this.log.warn(`Knowledge index unavailable: ${(err as Error).message}`);
      return { chunks: [], df: new Map<string, number>(), avg: 1, sources: new Map<string, KnowledgeSource>() };
    }
    const byId = new Map(sources.map((s) => [s.id, s]));
    const df = new Map<string, number>();
    const list: IndexedChunk[] = [];
    for (const c of chunks) {
      const src = byId.get(c.sourceId);
      if (!src) continue;
      const tokens = terms(`${c.text}`);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      const headTerms = new Set(terms(`${src.title} ${c.heading ?? ''}`));
      for (const t of new Set([...tf.keys(), ...headTerms])) df.set(t, (df.get(t) ?? 0) + 1);
      list.push({ id: c.id, sourceId: c.sourceId, heading: c.heading, text: c.text, tf, headTerms, len: tokens.length || 1 });
    }
    const avg = list.length ? list.reduce((n, c) => n + c.len, 0) / list.length : 1;
    this.st.index = { chunks: list, df, avg, sources: byId };
    return this.st.index;
  }

  // ---------------------------------------------------------------------------
  // Access
  // ---------------------------------------------------------------------------

  canRead(src: Pick<KnowledgeSource, 'visibility' | 'audience' | 'campusId'>, who: Audience): boolean {
    if (who.kind === 'whatsapp') {
      if (who.campusId && src.campusId && src.campusId !== who.campusId) return false;
      return src.visibility === 'public' || (who.family && src.visibility === 'families');
    }
    const u = who.user;
    if (who.campusId && src.campusId && src.campusId !== who.campusId) return false;
    if (src.visibility === 'restricted') return u.permissions.has('students.sensitive') || src.audience.includes(u.roleKey);
    if (src.visibility === 'staff') return !['parent', 'student'].includes(u.roleKey);
    return true;
  }

  /** Sources this person may read (for the "Approved sources" list). */
  async sources(who: Audience) {
    await this.sync();
    const rows = await this.prisma.knowledgeSource.findMany({ where: { status: 'indexed' }, orderBy: [{ restricted: 'asc' }, { title: 'asc' }] });
    return rows.filter((s) => this.canRead(s, who));
  }

  async counts() {
    const [indexed, total] = await Promise.all([this.prisma.knowledgeSource.count({ where: { status: 'indexed' } }), this.prisma.knowledgeSource.count()]);
    return { indexed, total };
  }

  // ---------------------------------------------------------------------------
  // Retrieval
  // ---------------------------------------------------------------------------

  /** Best passages for a question: readable ones, and whether a better match exists that this person may not read. */
  async search(question: string, who: Audience, limit = 4): Promise<{ hits: Hit[]; queryTerms: string[]; restrictedBetter: boolean; searched: number }> {
    await this.sync();
    const idx = await this.loadIndex();
    const q = [...new Set(terms(question))];
    if (!q.length || !idx.chunks.length) return { hits: [], queryTerms: q, restrictedBetter: false, searched: 0 };
    const N = idx.chunks.length;
    const k1 = 1.2;
    const b = 0.75;
    const scored: Hit[] = [];
    for (const c of idx.chunks) {
      let score = 0;
      const matched: string[] = [];
      for (const t of q) {
        const tf = c.tf.get(t) ?? 0;
        const inHead = c.headTerms.has(t);
        if (!tf && !inHead) continue;
        matched.push(t);
        const idf = Math.log(1 + (N - (idx.df.get(t) ?? 0) + 0.5) / ((idx.df.get(t) ?? 0) + 0.5));
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * c.len) / idx.avg))) + (inHead ? idf * 0.6 : 0);
      }
      if (!matched.length) continue;
      const src = idx.sources.get(c.sourceId)!;
      scored.push({
        chunkId: c.id, sourceId: c.sourceId, title: src.title, section: src.section, heading: c.heading, text: c.text, updated: dayKey(src.sourceUpdatedAt),
        score, matched, coverage: matched.length / q.length, restricted: src.restricted,
      });
    }
    scored.sort((a, b2) => b2.coverage - a.coverage || b2.score - a.score);
    const readableSources = new Set([...idx.sources.values()].filter((s) => this.canRead(s, who)).map((s) => s.id));
    const allowed = scored.filter((h) => readableSources.has(h.sourceId));
    const bestAll = scored[0];
    const bestAllowed = allowed[0];
    const restrictedBetter = !!bestAll && !readableSources.has(bestAll.sourceId) && bestAll.coverage >= 0.5 && (!bestAllowed || bestAllowed.coverage < bestAll.coverage);
    // At most two passages per source.
    const per = new Map<string, number>();
    const hits: Hit[] = [];
    for (const h of allowed) {
      if ((per.get(h.sourceId) ?? 0) >= 2) continue;
      per.set(h.sourceId, (per.get(h.sourceId) ?? 0) + 1);
      hits.push(h);
      if (hits.length >= limit) break;
    }
    return { hits, queryTerms: q, restrictedBetter, searched: readableSources.size };
  }

  /** Sentences from the passages that carry the matched words (answer without a language model). */
  extractive(hits: Hit[], queryTerms: string[]): string {
    const want = new Set(queryTerms);
    const paras: string[] = [];
    let used = 0;
    for (const h of hits.slice(0, 2)) {
      const sentences = h.text.split(/(?<=[.!?])\s+(?=[A-Z0-9(])/);
      const scored = sentences.map((s, i) => ({ s, i, n: terms(s).filter((t) => want.has(t)).length })).filter((x) => x.n > 0);
      const best = scored.sort((a, b) => b.n - a.n || a.i - b.i).slice(0, used ? 2 : 3).sort((a, b) => a.i - b.i);
      if (!best.length) continue;
      paras.push(best.map((x) => truncate(x.s.trim(), 400)).join(' '));
      used += best.length;
      if (used >= 4) break;
    }
    return paras.join('\n\n');
  }
}
