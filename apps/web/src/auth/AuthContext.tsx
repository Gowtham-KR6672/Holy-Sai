import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, onSessionExpired, refreshAccessToken, setAccessToken, setSessionKind, type SessionKind } from '@/api/client';
import type { Permission, PlatformMe, RoleKey, SessionUser } from '@/api/types';

interface AuthState {
  /** The signed-in school user (also set in a support session; null for We School admins in the console). */
  user: SessionUser | null;
  /** The signed-in We School platform admin (console at /platform). */
  admin: PlatformMe | null;
  /** school · platform · support (a We School admin inside a school), or null when signed out. */
  mode: SessionKind | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  login: (identifier: string, password: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  /** Opens a support session from the single-use code the console created. */
  startSupport: (code: string) => Promise<SessionUser>;
  /** True when the user holds the permission (or any of them, when given a list). */
  can: (perm?: Permission | Permission[] | null) => boolean;
  refreshUser: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

/** A support session lives in this tab only (reloads keep it; closing the tab ends it). */
const SUPPORT_KEY = 'we.support';

/** What the sign-in page needs to greet a platform admin and send them to the console. */
function asConsoleUser(me: PlatformMe): SessionUser {
  return {
    id: me.id, fullName: me.fullName, email: me.email, phone: me.phone, title: 'We School',
    role: { key: 'super_admin' as RoleKey, name: 'We School admin', scope: 'school', homeRoute: '/platform' },
    permissions: [], campusId: null, campus_name: null, parentId: null, studentId: null, employeeId: null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [admin, setAdmin] = useState<PlatformMe | null>(null);
  const [mode, setModeState] = useState<SessionKind | null>(null);
  const modeRef = useRef<SessionKind | null>(null);
  const setMode = useCallback((m: SessionKind | null) => {
    modeRef.current = m;
    setModeState(m);
  }, []);
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const qc = useQueryClient();

  const loadMe = useCallback(async () => {
    const me = await api.get<SessionUser>('/auth/me');
    setUser(me);
    setStatus('authenticated');
    return me;
  }, []);

  const enter = useCallback((kind: SessionKind) => {
    setSessionKind(kind);
    setMode(kind);
  }, [setMode]);

  // Restore the session on first load: a support session in this tab, else a school cookie, else a console cookie.
  useEffect(() => {
    let alive = true;
    (async () => {
      let support: string | null = null;
      try {
        support = sessionStorage.getItem(SUPPORT_KEY);
      } catch {
        /* storage unavailable */
      }
      if (support) {
        setAccessToken(support);
        enter('support');
        try {
          await loadMe();
          return;
        } catch {
          try {
            sessionStorage.removeItem(SUPPORT_KEY);
          } catch {
            /* ignore */
          }
          setAccessToken(null);
        }
      }
      // The support tab signs in from its code; do not restore another session there.
      if (window.location.pathname === '/support') {
        if (alive) setStatus('anonymous');
        return;
      }
      const school = await refreshAccessToken('school');
      if (!alive) return;
      if (school) {
        enter('school');
        try {
          await loadMe();
          return;
        } catch {
          /* fall through */
        }
      }
      const platform = await refreshAccessToken('platform');
      if (!alive) return;
      if (platform) {
        enter('platform');
        setAdmin(platform.user as unknown as PlatformMe);
        setStatus('authenticated');
        return;
      }
      setStatus('anonymous');
    })();
    onSessionExpired(() => {
      setAccessToken(null);
      setUser(null);
      setAdmin(null);
      // A support session ends after an hour: back to the console (its own sign-in is still there).
      if (modeRef.current === 'support') {
        try {
          sessionStorage.removeItem(SUPPORT_KEY);
        } catch {
          /* ignore */
        }
        window.location.assign('/platform');
      }
      setMode(null);
      setStatus('anonymous');
      qc.clear();
    });
    return () => {
      alive = false;
    };
  }, [loadMe, qc, enter, setMode]);

  const login = useCallback(async (identifier: string, password: string) => {
    const r = await api.post<{ kind?: 'school' | 'platform'; accessToken: string; user: unknown }>('/auth/login', { identifier, password, clientType: 'web' });
    setAccessToken(r.data.accessToken);
    qc.clear();
    if (r.data.kind === 'platform') {
      const me = r.data.user as PlatformMe;
      enter('platform');
      setUser(null);
      setAdmin(me);
      setStatus('authenticated');
      return asConsoleUser(me);
    }
    enter('school');
    setAdmin(null);
    return loadMe();
  }, [loadMe, qc, enter]);

  const startSupport = useCallback(async (code: string) => {
    const r = await api.post<{ accessToken: string }>('/platform/support/exchange', { code });
    setAccessToken(r.data.accessToken);
    try {
      sessionStorage.setItem(SUPPORT_KEY, r.data.accessToken);
    } catch {
      /* the session still works until a reload */
    }
    qc.clear();
    enter('support');
    setAdmin(null);
    return loadMe();
  }, [loadMe, qc, enter]);

  const logout = useCallback(async () => {
    try {
      if (mode === 'platform') await api.post('/platform/auth/logout');
      else if (mode === 'school') await api.post('/auth/logout');
    } finally {
      if (mode === 'support') {
        try {
          sessionStorage.removeItem(SUPPORT_KEY);
        } catch {
          /* ignore */
        }
      }
      setAccessToken(null);
      setUser(null);
      setAdmin(null);
      setMode(null);
      setStatus('anonymous');
      qc.clear();
    }
  }, [qc, mode, setMode]);

  const perms = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const can = useCallback((perm?: Permission | Permission[] | null) => {
    if (!perm) return true;
    if (Array.isArray(perm)) return perm.length === 0 || perm.some((p) => perms.has(p));
    return perms.has(perm);
  }, [perms]);

  const value = useMemo<AuthState>(() => ({
    user, admin, mode, status, login, logout, startSupport, can,
    refreshUser: async () => {
      if (mode === 'platform') setAdmin(await api.get<PlatformMe>('/platform/auth/me'));
      else await loadMe();
    },
  }), [user, admin, mode, status, login, logout, startSupport, can, loadMe]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
