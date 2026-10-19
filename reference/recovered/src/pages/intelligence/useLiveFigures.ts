import { useMemo } from 'react';
import { useApiQuery } from '@/hooks/useApi';
import { useSchool } from '@/layouts/SchoolContext';
import type { LiveFigures } from './prototypeData';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Live numbers for the prototype screens, taken from the Command Center API. */
export function useLiveFigures() {
  const { campusParam, scope } = useSchool();
  const q = useApiQuery<any>('/dashboard/command-center', { ...campusParam, scope }, { staleTime: 60_000 });
  const live = useMemo<LiveFigures | null>(() => {
    const d = q.data;
    if (!d) return null;
    const t = d.attendance?.today ?? {};
    const bus = (d.attention ?? []).find((a: any) => a.icon === 'bus');
    return {
      present: (t.present ?? 0) + (t.late ?? 0),
      marked: t.marked ?? 0,
      students: t.total ?? d.students?.total ?? 0,
      staffPresent: d.staff?.present ?? 0,
      staffTotal: d.staff?.total ?? 0,
      followUps: d.admissions?.overdueFollowUps ?? 0,
      openSignals: d.earlyWarning?.open ?? 0,
      awaitingReview: d.earlyWarning?.awaitingReview ?? 0,
      collectedToday: d.finance ? Number(d.finance.collectedToday) : null,
      approvals: d.approvals?.total ?? 0,
      delayedRoutes: bus ? String(bus.meta) : null,
      enquiriesThisMonth: d.admissions?.thisMonth ?? null,
      whatsappEnquiries: d.admissions ? (d.admissions.sources ?? []).find((s: any) => s.label === 'WhatsApp')?.value ?? 0 : null,
    };
  }, [q.data]);
  return { live, query: q };
}
