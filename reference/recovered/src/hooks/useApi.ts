import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api, type Envelope, type Paged } from '@/api/client';
import { useToast } from '@/components/ui/overlay';
import { errorMessage } from '@/components/ui/states';

type Params = Record<string, string | number | boolean | null | undefined>;

/** GET an endpoint. The query key is the path plus params, so identical calls share cache. */
export function useApiQuery<T>(path: string | null, params?: Params, opts: { enabled?: boolean; refetchInterval?: number; staleTime?: number } = {}) {
  return useQuery<T>({
    queryKey: [path, params ?? {}],
    queryFn: ({ signal }) => api.get<T>(path!, params, signal),
    enabled: !!path && opts.enabled !== false,
    refetchInterval: opts.refetchInterval,
    staleTime: opts.staleTime,
  });
}

/** GET a paginated list endpoint; keeps the previous page on screen while the next loads. */
export function usePagedQuery<T>(path: string | null, params?: Params, opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  return useQuery<Paged<T>>({
    queryKey: [path, params ?? {}],
    queryFn: ({ signal }) => api.getPaged<T>(path!, params, signal),
    enabled: !!path && opts.enabled !== false,
    placeholderData: keepPreviousData,
    refetchInterval: opts.refetchInterval,
  });
}

type Method = 'post' | 'put' | 'patch' | 'delete';

/**
 * A write call with success/error toasts and cache invalidation.
 *   const save = useApiMutation('post', '/students', { invalidate: ['/students'], success: 'Student created' });
 *   save.mutate(body)
 * `path` may be a function of the variables for routes with ids.
 */
export function useApiMutation<TBody = unknown, TResult = unknown>(
  method: Method,
  path: string | ((vars: TBody) => string),
  opts: {
    invalidate?: (string | QueryKey)[];
    success?: string | ((r: Envelope<TResult>, vars: TBody) => string) | false;
    error?: string | false;
    onSuccess?: (r: Envelope<TResult>, vars: TBody) => void;
    body?: (vars: TBody) => unknown;
  } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
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
        if (msg) toast(msg, 'success');
      }
      opts.onSuccess?.(r, vars);
    },
    onError: (err) => {
      if (opts.error !== false) toast(opts.error ?? errorMessage(err), 'critical');
    },
  });
}

/** Invalidates every cached query whose path starts with one of the prefixes. */
export function useInvalidate() {
  const qc = useQueryClient();
  return (...prefixes: string[]) =>
    qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && prefixes.some((p) => (q.queryKey[0] as string).startsWith(p)) });
}
