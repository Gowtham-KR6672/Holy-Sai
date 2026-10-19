/** Holy Sai brand tokens (same values as the web app's light theme). */
export const colors = {
  brand: '#990033',
  brandHover: '#B30042',
  brandStrong: '#4A0A22',
  brandTint: '#F9ECF0',
  brandTint2: '#F2D7E0',
  brandLine: '#EBCAD5',
  accent: '#FFDB6E',
  accentStrong: '#8F6400',
  accentTint: '#FFF8E6',
  bg: '#FAF8F6',
  bgSunken: '#F3F0EE',
  surface: '#FFFFFF',
  text: '#171717',
  textBody: '#2F3447',
  textMuted: '#5A6070',
  textFaint: '#7A7F8C',
  textInvert: '#FFFFFF',
  border: '#ECE7E4',
  borderStrong: '#D3C9C5',
  success: '#0F7A55',
  successTint: '#E7F6EF',
  successText: '#0D6347',
  warning: '#E07A1F',
  warningTint: '#FEF4EA',
  warningText: '#8A4A0C',
  caution: '#B98A00',
  cautionTint: '#FDF8E6',
  critical: '#D21F3A',
  criticalTint: '#FDEFF1',
  criticalText: '#A3162B',
  info: '#8F0A40',
  infoTint: '#F6E9EE',
  infoText: '#750834',
  neutralTint: '#F1EEEC',
  overlay: 'rgba(23, 23, 23, 0.45)',
} as const;

export type Tone = 'success' | 'warning' | 'critical' | 'info' | 'neutral' | 'brand' | 'caution';

export const toneColors: Record<Tone, { fg: string; bg: string; solid: string }> = {
  success: { fg: colors.successText, bg: colors.successTint, solid: colors.success },
  warning: { fg: colors.warningText, bg: colors.warningTint, solid: colors.warning },
  caution: { fg: colors.caution, bg: colors.cautionTint, solid: colors.caution },
  critical: { fg: colors.criticalText, bg: colors.criticalTint, solid: colors.critical },
  info: { fg: colors.infoText, bg: colors.infoTint, solid: colors.info },
  neutral: { fg: colors.textMuted, bg: colors.neutralTint, solid: colors.textMuted },
  brand: { fg: colors.brand, bg: colors.brandTint, solid: colors.brand },
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;

/** Maps common status words used by the API to a badge tone (mirrors the web Status component). */
export function statusTone(value: string | null | undefined): Tone {
  const v = String(value ?? '').toLowerCase();
  if (!v) return 'neutral';
  if (/(approved|paid|present|completed|complete|verified|marked|active|on track|cleared|matched|acknowledged|released|accepted|inside|on time|enrolled|collected|success|online)/.test(v)) return 'success';
  if (/(rejected|absent|overdue|critical|at risk|exception|declined|failed|revoked|offline|not marked|denied|lost)/.test(v)) return 'critical';
  if (/(pending|late|under review|submitted|delayed|developing|warning|attention|due|paused|not boarded|partial|stale)/.test(v)) return 'warning';
  if (/(leave|information|info|open|booked|in progress|scheduled|running|in transit)/.test(v)) return 'info';
  return 'neutral';
}
