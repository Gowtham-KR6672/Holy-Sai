import { memo } from 'react';
import { SvgXml } from 'react-native-svg';
import { ICONS, type IconName } from '@holysai/shared';
import { colors } from '@/theme/theme';

export function isIconName(name: string | null | undefined): name is IconName {
  return !!name && Object.prototype.hasOwnProperty.call(ICONS, name);
}

/**
 * Renders an icon from the shared 24px stroke set (the original build's icons).
 * `name` may come from the API (e.g. a notification's icon); unknown names fall back to `fallback`.
 */
export const Icon = memo(function Icon({
  name, size = 20, color = colors.text, strokeWidth = 2, fallback = 'info',
}: { name: string; size?: number; color?: string; strokeWidth?: number; fallback?: IconName }) {
  const key: IconName = isIconName(name) ? name : fallback;
  const xml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>`;
  return <SvgXml xml={xml} width={size} height={size} />;
});
