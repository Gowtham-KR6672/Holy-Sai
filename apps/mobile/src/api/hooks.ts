import { useCallback, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api, errorMessage, type Envelope } from './client';
import type { Paged } from './types';
import { useToast } from '@/components/Toast';
import { useI18n } from '@/i18n/I18nProvider';

type Params = Record<string, string | number | boolean | null | undefined>;

/** GET an endpoint. The query key is the path plus params (the same convention as the web app). */
export function useApiQuery<T>(path: string | null, params?: Params, opts: { enabled?: boolean; refetchInterval?: number; staleTime?: number } = {}) {
  return useQuery<T>({
    queryKey: [path, params ?? {}],
    queryFn: ({ signal }) => api.get<T>(path!, params, signal),
    enabled: !!path && opts.enabled !== false,
    refetchInterval: opts.refetchInterval,
    staleTime: opts.staleTime,
  });
}

/** GET a paginated list endpoint ({ data: rows, meta }). */
export function usePagedQuery<T>(path: string | null, params?: Params, opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  return useQuery<Paged<T>>({
    queryKey: [path, params ?? {}],
    queryFn: ({ signal }) => api.getPaged<T>(path!, params, signal),
    enabled: !!path && opts.enabled !== false,
    placeholderData: keepPreviousData,
    refetchInterval: opts.refetchInterval,
  });
}

/** Invalidates every cached query whose path starts with one of the prefixes. */
export function useInvalidate() {
  const qc = useQueryClient();
  return (...prefixes: string[]) =>
    qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && prefixes.some((p) => (q.queryKey[0] as string).startsWith(p)) });
}

type Method = 'post' | 'put' | 'patch' | 'delete';

/**
 * A write call with a success / error toast and cache invalidation, like the web's useApiMutation.
 * `success` is English text (translated here); by default the server's message is shown.
 */
export function useApiMutation<TBody = unknown, TResult = unknown>(
  method: Method,
  path: string | ((vars: TBody) => string),
  opts: {
    invalidate?: (string | QueryKey)[];
    success?: string | ((r: Envelope<TResult>, vars: TBody) => string) | false;
    error?: false;
    onSuccess?: (r: Envelope<TResult>, vars: TBody) => void;
    body?: (vars: TBody) => unknown;
  } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useI18n();
  return useMutation<Envelope<TResult>, Error, TBody>({
    mutationFn: (vars) => {
      const p = typeof path === 'function' ? path(vars) : path;
      const body = opts.body ? opts.body(vars) : vars;
      if (method === 'delete') return api.delete<TResult>(p);
      return api[method]<TResult>(p, body);
    },
    onSuccess: async (r, vars) => {
      await Promise.all(
        (opts.invalidate ?? []).map((k) =>
          qc.invalidateQueries({
            predicate: (q) => {
              const first = q.queryKey[0];
              if (typeof k === 'string') return typeof first === 'string' && first.startsWith(k);
              return JSON.stringify(q.queryKey.slice(0, k.length)) === JSON.stringify(k);
            },
          }),
        ),
      );
      if (opts.success !== false) {
        const msg = typeof opts.success === 'function' ? opts.success(r, vars) : opts.success ?? r.message;
        if (msg && msg !== 'OK') toast(t(msg), 'success');
      }
      opts.onSuccess?.(r, vars);
    },
    onError: (err) => {
      if (opts.error !== false) toast(t(errorMessage(err)), 'critical');
    },
  });
}

/** Pull-to-refresh for a whole screen: refetches every query currently on screen. */
export function useRefresh() {
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await qc.invalidateQueries({ type: 'active' });
    } finally {
      setRefreshing(false);
    }
  }, [qc]);
  return { refreshing, onRefresh: () => void onRefresh() };
}
