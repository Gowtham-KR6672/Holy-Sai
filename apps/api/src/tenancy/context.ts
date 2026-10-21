import { AsyncLocalStorage } from 'node:async_hooks';
import type { SubscriptionStatus } from './subscription-status.service';

/** A school workspace as the runtime needs it. Its tables live in the PostgreSQL schema `schema` (ws_<code>). */
export interface WorkspaceRef {
  id: string;
  code: string;
  name: string;
  schema: string;
  /** active | suspended */
  status: string;
}

/** What every request or background job knows about the school it works for (null = no school, e.g. platform pages). */
export interface TenancyStore {
  workspace: WorkspaceRef | null;
  /** Set for campus admins once signed in: every query is limited to this campus. */
  pinnedCampusId?: string | null;
  /** The school's subscription status for this request (set by TenancyMiddleware). */
  subscription?: SubscriptionStatus | null;
  /** Background work (scheduled jobs, queues): does not keep a school's database open. */
  job?: boolean;
}

const storage = new AsyncLocalStorage<TenancyStore>();

/** Runs fn with the given workspace as the current one (requests, jobs, queued work); null runs it outside any school. */
export function runInWorkspace<T>(workspace: WorkspaceRef | null, fn: () => T, extra: Partial<TenancyStore> = {}): T {
  return storage.run({ ...extra, workspace }, fn);
}

/** The subscription status of the current request's school (null outside a request or school). */
export function currentSubscription(): SubscriptionStatus | null {
  return storage.getStore()?.subscription ?? null;
}

/** Limits the rest of this request to one campus (campus admins; set by the auth guard). */
export function pinCampus(campusId: string | null) {
  const store = storage.getStore();
  if (store) store.pinnedCampusId = campusId;
}

/** The campus this request is limited to, or null. */
export function pinnedCampusOrNull(): string | null {
  return storage.getStore()?.pinnedCampusId ?? null;
}

/** The whole context of the current request or job. */
export function currentStore(): TenancyStore | undefined {
  return storage.getStore();
}

/** The workspace of the current request or job, or null outside one. */
export function currentWorkspaceOrNull(): WorkspaceRef | null {
  return storage.getStore()?.workspace ?? null;
}

/** School data was needed but the request has no school (e.g. a webhook called without /api/w/<code>/). */
export class NoWorkspaceError extends Error {
  constructor() {
    super('No workspace selected — run this code inside a school request or tenancy.run()');
  }
}

/** The workspace of the current request or job; throws outside one, so a missed path fails loudly. */
export function currentWorkspace(): WorkspaceRef {
  const ws = currentWorkspaceOrNull();
  if (!ws) throw new NoWorkspaceError();
  return ws;
}

/** A cache or lock key that cannot collide with another workspace's. */
export function workspaceKey(key: string): string {
  return `${currentWorkspace().code}:${key}`;
}

/** One value per workspace, created on first use (in-memory caches, flags, indexes). */
export class PerWorkspace<T> {
  private readonly values = new Map<string, T>();

  constructor(private readonly create: () => T) {}

  /** The value for the current workspace. */
  get(): T {
    const code = currentWorkspace().code;
    let v = this.values.get(code);
    if (v === undefined) {
      v = this.create();
      this.values.set(code, v);
    }
    return v;
  }

  /** Replaces the value for the current workspace. */
  set(value: T) {
    this.values.set(currentWorkspace().code, value);
  }

  /** Drops the value of one workspace (or all). */
  reset(code?: string) {
    if (code) this.values.delete(code);
    else this.values.clear();
  }
}

/** School refresh tokens carry their school: "<code>.<secret>", so refresh and sign-out find the right schema. */
export function splitRefreshToken(token: string | null | undefined): { code: string; secret: string } | null {
  const m = /^([a-z0-9_]{2,40})\.([A-Za-z0-9_-]{20,})$/.exec(token?.trim() ?? '');
  return m ? { code: m[1], secret: m[2] } : null;
}
