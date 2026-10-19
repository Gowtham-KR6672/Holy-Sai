import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, onSessionExpired, refreshAccessToken, setAccessToken } from '@/api/client';
import type { Permission, SessionUser } from '@/api/types';

interface AuthState {
  user: SessionUser | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  login: (identifier: string, password: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  /** True when the user holds the permission (or any of them, when given a list). */
  can: (perm?: Permission | Permission[] | null) => boolean;
  refreshUser: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const qc = useQueryClient();

  const loadMe = useCallback(async () => {
    const me = await api.get<SessionUser>('/auth/me');
    setUser(me);
    setStatus('authenticated');
    return me;
  }, []);

  // Restore the session from the httpOnly refresh cookie on first load.
  useEffect(() => {
    let alive = true;
    (async () => {
      const session = await refreshAccessToken();
      if (!alive) return;
      if (session) {
        try {
          await loadMe();
          return;
        } catch {
          /* fall through to anonymous */
        }
      }
      setStatus('anonymous');
    })();
    onSessionExpired(() => {
      setAccessToken(null);
      setUser(null);
      setStatus('anonymous');
      qc.clear();
    });
    return () => {
      alive = false;
    };
  }, [loadMe, qc]);

  const login = useCallback(async (identifier: string, password: string) => {
    const r = await api.post<{ accessToken: string }>('/auth/login', { identifier, password, clientType: 'web' });
    setAccessToken(r.data.accessToken);
    qc.clear();
    return loadMe();
  }, [loadMe, qc]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setAccessToken(null);
      setUser(null);
      setStatus('anonymous');
      qc.clear();
    }
  }, [qc]);

  const perms = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const can = useCallback((perm?: Permission | Permission[] | null) => {
    if (!perm) return true;
    if (Array.isArray(perm)) return perm.length === 0 || perm.some((p) => perms.has(p));
    return perms.has(perm);
  }, [perms]);

  const value = useMemo<AuthState>(() => ({
    user, status, login, logout, can,
    refreshUser: async () => { await loadMe(); },
  }), [user, status, login, logout, can, loadMe]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
