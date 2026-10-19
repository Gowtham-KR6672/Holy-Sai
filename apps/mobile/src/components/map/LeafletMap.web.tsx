import { createElement, useMemo } from 'react';
import { View } from 'react-native';
import { colors, radius } from '@/theme/theme';
import { leafletHtml, type MapData } from './leafletHtml';
import { useTiles } from './useTiles';

/** Web build (smoke tests only): the same Leaflet page in an iframe. */
export function LeafletMap({ data, height = 260 }: { data: MapData; height?: number }) {
  const tiles = useTiles();
  const html = useMemo(() => leafletHtml(data, tiles.url, tiles.attribution), [data, tiles.url, tiles.attribution]);
  return (
    <View style={{ height, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.bgSunken }}>
      {createElement('iframe', { srcDoc: html, style: { border: 0, width: '100%', height: '100%' }, title: 'map' })}
    </View>
  );
}
