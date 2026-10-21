import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, login as apiLogin, logout as apiLogout, onSessionEnded, refreshSession } from '@/api/client';
import type { SessionUser } from '@/api/types';
import { syncPushToken } from '@/lib/push';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'unreachable';

interface AuthState {
  user: SessionUser | null;
  status: AuthStatus;
  /** Why the last restore failed when status is 'unreachable'. */
  restoreError: string | null;
  signIn: (identifier: string, password: string) => Promise<SessionUser>;
  signOut: () => Promise<void>;
  /** Retries restoring the saved session (after a network failure on launch). */
  retryRestore: () => Promise<void>;
  /** Forgets the saved session locally (used from the "server unreachable" screen). */
  forget: () => Promise<void>;
  refreshUser: () => Promise<void>;
  /** True when the user holds the permission (or any of them, when given a list). */
  can: (perm?: string | string[] | null) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [restoreError, setRestoreError] = useState<string | null>(null);

  /** Session restore on launch: exchange the stored refresh token, then load /auth/me. */
  const restore = useCallback(async () => {
    setStatus('loading');
    setRestoreError(null);
    const outcome = await refreshSession();
    if (outcome.kind === 'signed-out') {
      setUser(null);
      setStatus('anonymous');
      return;
    }
    if (outcome.kind === 'unreachable') {
      setRestoreError(outcome.error.message);
      setStatus('unreachable');
      return;
    }
    try {
      const me = await api.get<SessionUser>('/auth/me');
      setUser(me);
      setStatus('authenticated');
    } catch (err) {
      if (outcome.user) {
        setUser(outcome.user);
        setStatus('authenticated');
      } else if (err instanceof ApiError && err.isNetwork) {
        setRestoreError(err.message);
        setStatus('unreachable');
      } else {
        setStatus('anonymous');
      }
    }
  }, []);

  useEffect(() => {
    void restore();
    onSessionEnded((reason) => {
      setUser(null);
      setStatus('anonymous');
      qc.clear();
      if (reason) Alert.alert('We School', reason);
    });
    return () => onSessionEnded(null);
  }, [restore, qc]);

  const signIn = useCallback(async (identifier: string, password: string) => {
    const u = await apiLogin(identifier, password);
    qc.clear();
    let me = u;
    try {
      me = await api.get<SessionUser>('/auth/me');
    } catch {
      /* the login payload already carries the session user */
    }
    setUser(me);
    setStatus('authenticated');
    return me;
  }, [qc]);

  const signOut = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setStatus('anonymous');
    qc.clear();
  }, [qc]);

  const forget = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setStatus('anonymous');
  }, []);

  const refreshUser = useCallback(async () => {
    const me = await api.get<SessionUser>('/auth/me');
    setUser(me);
  }, []);

  // Register this device for push notifications once per signed-in user.
  const userId = user?.id;
  useEffect(() => {
    if (status === 'authenticated' && userId) void syncPushToken();
  }, [status, userId]);

  const perms = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const can = useCallback((perm?: string | string[] | null) => {
    if (!perm) return true;
    if (Array.isArray(perm)) return perm.length === 0 || perm.some((p) => perms.has(p));
    return perms.has(perm);
  }, [perms]);

  const value = useMemo<AuthState>(() => ({
    user, status, restoreError, signIn, signOut, retryRestore: restore, forget, refreshUser, can,
  }), [user, status, restoreError, signIn, signOut, restore, forget, refreshUser, can]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}

let lastUser: SessionUser | null = null;

/**
 * The signed-in user (only call inside the signed-in part of the app). While signing out, screens that
 * are still unmounting keep seeing the last user instead of crashing.
 */
export function useUser(): SessionUser {
  const { user } = useAuth();
  if (user) lastUser = user;
  if (!lastUser) throw new Error('No signed-in user');
  return lastUser;
}
