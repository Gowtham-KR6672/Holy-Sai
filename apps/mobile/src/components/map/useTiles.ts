import { useApiQuery } from '@/api/hooks';
import type { PublicConfig } from '@/api/types';
import { DEFAULT_ATTRIBUTION, DEFAULT_TILE } from './leafletHtml';

/** Tile server configured by the school (Administration › Integrations › Maps), else OpenStreetMap. */
export function useTiles() {
  const q = useApiQuery<PublicConfig>('/public/config', undefined, { staleTime: 30 * 60_000 });
  const map = q.data?.map;
  return {
    url: map?.tileUrl || DEFAULT_TILE,
    attribution: map?.attribution ? `&copy; ${map.attribution.replace(/^©\s*/, '')}` : DEFAULT_ATTRIBUTION,
  };
}
