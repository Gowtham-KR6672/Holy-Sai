import { useCallback, useMemo } from 'react';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useUser } from '@/auth/AuthContext';
import { colors } from '@/theme/theme';
import { WEB_URL } from './config';
import { canUseFeature, featureForWebPath, queryParam, studentIdFromWebPath, tabsFor, type FeatureKey } from './features';

/** Opens a feature: switches to its tab when the role has one, otherwise pushes it on the stack. */
export function useNav() {
  const router = useRouter();
  const user = useUser();
  const tabs = useMemo(() => tabsFor(user), [user]);

  const open = useCallback((key: FeatureKey, params?: Record<string, string>) => {
    const qs = params && Object.keys(params).length
      ? `?${Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
      : '';
    if (tabs.some((t) => t.key === key)) router.navigate(`/${key}${qs}`);
    else router.push(`/view/${key}${qs}`);
  }, [router, tabs]);

  const openWeb = useCallback((path: string) => {
    void WebBrowser.openBrowserAsync(`${WEB_URL}${path.startsWith('/') ? path : `/${path}`}`, {
      toolbarColor: colors.brand, controlsColor: colors.brand, showTitle: true,
    });
  }, []);

  /** Opens a web route from a notification or task natively when possible, otherwise in the web portal. */
  const openRoute = useCallback((route: string | null | undefined) => {
    if (!route) return;
    const sid = studentIdFromWebPath(route);
    if (sid && canUseFeature(user, 'students')) {
      router.push(`/student/${encodeURIComponent(sid)}`);
      return;
    }
    const key = featureForWebPath(route);
    if (key && canUseFeature(user, key)) {
      const section = queryParam(route, 'section');
      open(key, section ? { section } : undefined);
      return;
    }
    openWeb(route);
  }, [open, openWeb, router, user]);

  return { open, openWeb, openRoute, tabs, router };
}
