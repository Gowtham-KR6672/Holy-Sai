/**
 * Product and school identity. "We School" is the product; the school's own name, tagline and
 * logo belong to the school and are never hard-coded: screens that print or show who the school
 * is (receipts, payslips, certificates, visitor passes…) read them from useSchoolBrand().
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export const PRODUCT_NAME = 'We School';
/** Shown until the school's name is known (or when it has not been set). */
export const FALLBACK_SCHOOL_NAME = 'Your school';
/** The We School mark, until a school uploads its own logo. */
export const DEFAULT_LOGO_URL = '/logo-mark.svg';

export interface SchoolBrand {
  schoolName: string;
  tagline: string;
  logoUrl: string;
}

/** The school's identity, from GET /public/config (school.name and school.tagline settings). */
export function useSchoolBrand(): SchoolBrand {
  const q = useQuery({
    queryKey: ['public-config'],
    queryFn: () => api.get<{ schoolName?: string; tagline?: string }>('/public/config'),
    staleTime: 5 * 60_000,
  });
  return {
    schoolName: q.data?.schoolName?.trim() || FALLBACK_SCHOOL_NAME,
    tagline: q.data?.tagline?.trim() ?? '',
    logoUrl: DEFAULT_LOGO_URL,
  };
}
