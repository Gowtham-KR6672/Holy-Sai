import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { useApiQuery } from '@/api/hooks';
import type { StudentRow } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { prefs } from '@/lib/storage';

/** A child as returned by GET /parents/me (the web Parent 360's ChildRow). */
export type ChildRow = StudentRow & {
  relationship: string;
  isPrimary: boolean;
  canViewTracking: boolean;
  locationStatus: string | null;
  locationRecordedAt: string | null;
  trackingStatus?: 'active' | 'paused' | 'offline' | 'disabled' | null;
  campusName?: string;
};

export interface ParentMe {
  id: string;
  parentCode: string;
  fullName: string;
  phone: string;
  email: string | null;
  children: ChildRow[];
}

/** GET /parents/:pid/children/:cid/overview — the child's day (gate, bus, homework, fees, updates, pickup). */
export interface ChildOverview {
  child: StudentRow;
  gateToday: { gate: string; direction: 'in' | 'out'; method: string; occurredAt: string }[];
  bus: {
    routeName: string; runStatus: string; delayMinutes: number; eta: string | null; busNo: string | null; registrationNo: string | null;
    driver: string | null; attendant: string | null; stopName: string | null; pickupTime: string | null; dropTime: string | null;
    boardingToday: { type: 'boarded' | 'deboarded'; at: string }[] | null;
  } | null;
  homework: { id: string; subject: string; title: string; dueOn: string; status: string; submitted: boolean }[];
  fees: { billed: number; paid: number; outstanding: number; nextDue: string | null };
  notifications: { id: string; category: string; tone: string; icon: string; title: string; body: string | null; route: string | null; createdAt: string }[];
  events: { id: string; title: string; startsOn: string; endsOn: string | null; venue: string | null; audience: string }[];
  pickup: { id: string; personName: string; relation: string; method: string; status: string; lastPickupAt: string | null }[];
}

interface ParentState {
  enabled: boolean;
  query: UseQueryResult<ParentMe>;
  me: ParentMe | undefined;
  kids: ChildRow[];
  child: ChildRow | undefined;
  setChild: (id: string) => void;
}

const Ctx = createContext<ParentState | null>(null);
const KEY = 'hs.child';

export const overviewPath = (pid: string, cid: string) => `/parents/${pid}/children/${cid}/overview`;

/** Loads the signed-in parent's children once and remembers which child is selected. */
export function ParentProvider({ children }: { children: ReactNode }) {
  const { can } = useAuth();
  const enabled = can('parent_portal.use');
  const query = useApiQuery<ParentMe>(enabled ? '/parents/me' : null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    void prefs.get(KEY).then((v) => v && setSelected((s) => s ?? v));
  }, [enabled]);

  const setChild = useCallback((id: string) => {
    setSelected(id);
    void prefs.set(KEY, id);
  }, []);

  const value = useMemo<ParentState>(() => {
    const kids = query.data?.children ?? [];
    const child = kids.find((c) => c.id === selected) ?? kids[0];
    return { enabled, query, me: query.data, kids, child, setChild };
  }, [enabled, query, selected, setChild]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useParent() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useParent must be used inside ParentProvider');
  return v;
}
