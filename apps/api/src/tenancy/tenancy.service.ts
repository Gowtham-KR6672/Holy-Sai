import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { campusPinExtension } from './campus-pin.extension';
import { currentStore, currentWorkspace, runInWorkspace, type TenancyStore, type WorkspaceRef } from './context';
import { PlatformDb } from './platform-db.service';

interface LiveClient {
  client: PrismaClient;
  lastUsed: number;
  /** Last use by a user request (background jobs do not count): jobs only close clients no request is using. */
  lastRequestUse: number;
}

/** Idle clients are closed after this long; the next call for that school opens a new one. */
const IDLE_MS = 3 * 60_000;
/** Open school databases kept at once (MAX_LIVE_WORKSPACES); the least recently used idle one is closed first. */
const MAX_LIVE = Math.max(2, Number(process.env.MAX_LIVE_WORKSPACES ?? 15) || 15);
/** Pooled connections per school (WORKSPACE_DB_CONNECTION_LIMIT). */
const CONNECTION_LIMIT = Math.max(1, Number(process.env.WORKSPACE_DB_CONNECTION_LIMIT ?? 2) || 2);
const SCHEMA_NAME = /^ws_[a-z0-9_]{2,40}$/;
/** The list of schools is re-read at most this often (new and suspended schools show up within it). */
const LIST_TTL_MS = 15_000;

let instance: TenancyService | null = null;

/** The tenancy service, for decorators and helpers that run outside dependency injection. */
export function tenancy(): TenancyService {
  if (!instance) throw new Error('TenancyService is not ready');
  return instance;
}

/**
 * Keeps one Prisma client per school workspace and runs code inside a workspace. Requests get their workspace
 * from TenancyMiddleware; scheduled jobs use forEachWorkspace(); queued work stores the workspace and re-enters
 * with run().
 *
 * Connections stay bounded: each school's pool is small (WORKSPACE_DB_CONNECTION_LIMIT), at most MAX_LIVE_WORKSPACES
 * schools stay open, and background jobs close a school's client again when no user request is using it.
 * PostgreSQL needs max_connections ≥ API instances × MAX_LIVE_WORKSPACES × WORKSPACE_DB_CONNECTION_LIMIT + 20.
 */
@Injectable()
export class TenancyService implements OnModuleDestroy {
  private readonly log = new Logger('Tenancy');
  private readonly clients = new Map<string, LiveClient>();
  private readonly sweeper: NodeJS.Timeout;
  private list: { at: number; rows: WorkspaceRef[] } | null = null;

  constructor(private readonly platform: PlatformDb) {
    instance = this;
    this.sweeper = setInterval(() => void this.closeIdle(), 30_000);
    this.sweeper.unref?.();
  }

  /** Every school on the platform (cached for a few seconds). */
  async workspaces(): Promise<WorkspaceRef[]> {
    if (this.list && Date.now() - this.list.at < LIST_TTL_MS) return this.list.rows;
    const rows = await this.platform.workspace.findMany({
      where: { status: { in: ['active', 'suspended'] } },
      select: { id: true, code: true, name: true, schemaName: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
    const list = rows.map((r) => ({ id: r.id, code: r.code, name: r.name, schema: r.schemaName, status: r.status }));
    this.list = { at: Date.now(), rows: list };
    return list;
  }

  /** Forget the cached list (after a school is created, renamed or suspended). */
  refreshList() {
    this.list = null;
  }

  async byCode(code: string): Promise<WorkspaceRef | null> {
    const hit = (await this.workspaces()).find((w) => w.code === code);
    if (hit) return hit;
    // Created moments ago on another instance: look once more without the cache.
    this.list = null;
    return (await this.workspaces()).find((w) => w.code === code) ?? null;
  }

  async byId(id: string): Promise<WorkspaceRef | null> {
    const hit = (await this.workspaces()).find((w) => w.id === id);
    if (hit) return hit;
    this.list = null;
    return (await this.workspaces()).find((w) => w.id === id) ?? null;
  }

  /** Runs fn inside a workspace (null: outside any school, e.g. platform pages and sign-in). */
  run<T>(workspace: WorkspaceRef | null, fn: () => T, extra: Partial<TenancyStore> = {}): T {
    return runInWorkspace(workspace, fn, extra);
  }

  /**
   * Runs a job once for every school (two at a time); one school's failure does not stop the others. A school whose
   * database was not open before the job is closed again afterwards, unless a user request used it meanwhile.
   */
  async forEachWorkspace(job: string, fn: () => Promise<unknown> | unknown, concurrency = 2, only?: WorkspaceRef[]): Promise<void> {
    let queue: WorkspaceRef[];
    try {
      queue = [...(only ?? (await this.workspaces()))];
    } catch (err) {
      this.log.error(`${job}: could not list schools — ${(err as Error)?.message ?? err}`);
      return;
    }
    const worker = async () => {
      for (let ws = queue.shift(); ws; ws = queue.shift()) {
        const target = ws;
        try {
          await this.withSchool(target, () => fn());
        } catch (err) {
          this.log.error(`${job} failed for school ${target.code}: ${(err as Error)?.message ?? err}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  }

  /** Runs background work inside one school, closing its database again afterwards if nothing else is using it. */
  async withSchool<T>(ws: WorkspaceRef, fn: () => Promise<T> | T): Promise<T> {
    const wasOpen = this.clients.has(ws.schema);
    const started = Date.now();
    try {
      return await this.run(ws, async () => fn(), { job: true });
    } finally {
      const live = this.clients.get(ws.schema);
      if (!wasOpen && live && live.lastRequestUse < started) {
        this.clients.delete(ws.schema);
        await live.client.$disconnect().catch(() => undefined);
      }
    }
  }

  /** The database client of the current workspace. */
  current(): PrismaClient {
    return this.client(currentWorkspace(), !currentStore()?.job);
  }

  /** The database client of a workspace (opened on first use). */
  client(ws: WorkspaceRef, byRequest = false): PrismaClient {
    const now = Date.now();
    const live = this.clients.get(ws.schema);
    if (live) {
      live.lastUsed = now;
      if (byRequest) live.lastRequestUse = now;
      return live.client;
    }
    // Campus admins are limited to their campus at the database layer (see campus-pin.extension.ts).
    const client = new PrismaClient({ datasources: { db: { url: this.urlFor(ws.schema) } } }).$extends(campusPinExtension) as unknown as PrismaClient;
    this.clients.set(ws.schema, { client, lastUsed: now, lastRequestUse: byRequest ? now : 0 });
    if (this.clients.size > MAX_LIVE) void this.closeIdle(true);
    return client;
  }

  /** DATABASE_URL pointed at a school schema, with a small pool per school. */
  private urlFor(schema: string): string {
    if (!SCHEMA_NAME.test(schema)) throw new Error(`Invalid school schema name "${schema}"`);
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is not set');
    const url = new URL(base);
    url.searchParams.set('schema', schema);
    if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', String(CONNECTION_LIMIT));
    return url.toString();
  }

  /** Closes a school's database client now (before its schema is dropped). */
  async forget(schema: string) {
    const live = this.clients.get(schema);
    this.clients.delete(schema);
    this.list = null;
    await live?.client.$disconnect().catch(() => undefined);
  }

  /** Closes clients nobody used for a while (or the least recently used ones when over the limit). */
  private async closeIdle(overLimit = false) {
    const now = Date.now();
    const byAge = [...this.clients.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let excess = overLimit ? this.clients.size - MAX_LIVE : 0;
    for (const [schema, live] of byAge) {
      const idle = now - live.lastUsed;
      // Over the limit, close the oldest that has been quiet for a few seconds; otherwise only long-idle ones.
      if (idle >= IDLE_MS || (excess > 0 && idle >= 5_000)) {
        this.clients.delete(schema);
        excess--;
        await live.client.$disconnect().catch(() => undefined);
      }
    }
  }

  async onModuleDestroy() {
    clearInterval(this.sweeper);
    await Promise.all([...this.clients.values()].map((l) => l.client.$disconnect().catch(() => undefined)));
    this.clients.clear();
  }
}
