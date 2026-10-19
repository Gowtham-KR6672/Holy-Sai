import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewHandle } from '../webview';
import { WEB_URL } from '@/lib/config';
import { colors, radius } from '@/theme/theme';
import { leafletHtml, scriptJson, type MapData } from './leafletHtml';
import { useTiles } from './useTiles';

/**
 * Live map: Leaflet + OpenStreetMap tiles in a WebView (works in Expo Go, no map API key needed).
 * The page is created once; later data updates are pushed in without reloading the tiles.
 */
export function LeafletMap({ data, height = 260 }: { data: MapData; height?: number }) {
  const ref = useRef<WebViewHandle>(null);
  const tiles = useTiles();
  // Built once per tile server; the first data set is baked in, later ones are injected.
  const initial = useRef(data);
  const html = useMemo(() => leafletHtml(initial.current, tiles.url, tiles.attribution), [tiles.url, tiles.attribution]);
  const json = scriptJson(data);
  const lastSent = useRef(json);

  useEffect(() => {
    if (json === lastSent.current) return;
    lastSent.current = json;
    ref.current?.injectJavaScript(`window.__setData && window.__setData(${json}); true;`);
  }, [json]);

  return (
    <View style={[styles.wrap, { height }]}>
      <WebView
        ref={ref}
        originWhitelist={['*']}
        // A real origin so the tile server receives a Referer, as OpenStreetMap's tile policy requires.
        source={{ html, baseUrl: `${WEB_URL}/` }}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        nestedScrollEnabled
        setSupportMultipleWindows={false}
        style={{ backgroundColor: colors.bgSunken }}
        onLoadEnd={() => {
          lastSent.current = json;
          ref.current?.injectJavaScript(`window.__setData && window.__setData(${json}); true;`);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.bgSunken, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
});
