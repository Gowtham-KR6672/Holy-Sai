import { useMemo } from 'react';
import { useApiQuery } from './useApi';
import type { Lookups } from '@/api/types';

/** Campuses, years, classes/sections, subjects, routes and staff for forms and filters (cached 10 min). */
export function useLookups() {
  const q = useApiQuery<Lookups>('/lookups', undefined, { staleTime: 10 * 60_000 });
  const helpers = useMemo(() => {
    const d = q.data;
    const classOptions = (campusId?: string) =>
      (d?.classes ?? []).filter((c) => !campusId || c.campusId === campusId).map((c) => ({ value: c.id, label: c.name }));
    const sectionOptions = (classId?: string) =>
      (d?.classes ?? []).find((c) => c.id === classId)?.sections.map((s) => ({ value: s.id, label: s.name })) ?? [];
    const gradeNames = Array.from(new Set((d?.classes ?? []).map((c) => c.name))).sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
    return { classOptions, sectionOptions, gradeNames };
  }, [q.data]);
  return { ...q, lookups: q.data, ...helpers };
}
