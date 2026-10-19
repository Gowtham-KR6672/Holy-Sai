import { fmt } from '@/lib/format';
import type { ReportColumn, ReportPreview, ReportSummaryTile } from './types';

/** Groups shown in catalogue order; anything unexpected is appended after these. */
export const GROUP_ORDER = ['Students', 'Academics', 'Operations', 'Management', 'System'];

export const GROUP_ICON: Record<string, string> = {
  Students: 'users',
  Academics: 'clipboard',
  Operations: 'building',
  Management: 'trending',
  System: 'shieldCheck',
};

export const orderGroups = (groups: string[]) =>
  [...new Set(groups)].sort((a, b) => {
    const ai = GROUP_ORDER.indexOf(a);
    const bi = GROUP_ORDER.indexOf(b);
    return (ai === -1 ? GROUP_ORDER.length : ai) - (bi === -1 ? GROUP_ORDER.length : bi) || a.localeCompare(b);
  });

/** Money columns are labelled "… (INR)" by the report definitions. */
const isMoney = (label: string) => /\(INR\)/i.test(label);

/** Formats one table cell, right-aligning and localising anything numeric. */
export function cellText(value: unknown, column: ReportColumn, numeric: string[]) {
  if (value === null || value === undefined || value === '') return null;
  if (!numeric.includes(column.key)) return String(value);
  return isMoney(column.label) ? fmt.money(value as number) : fmt.n(value as number);
}

/** A summary aggregate rendered for a KPI tile. */
export function tileValue(tile: ReportSummaryTile) {
  if (tile.unit === 'INR') return fmt.money(tile.value, { compact: true });
  if (tile.unit === '%') return fmt.pct(tile.value, 1);
  return fmt.n(tile.value);
}

/** Bar rows for the preview chart, with values pre-formatted for the tooltip. */
export function chartRows(preview: ReportPreview) {
  const chart = preview.chart;
  if (!chart) return [];
  const money = /\(INR\)|amount|gross|net|outstanding|collected|billed/i.test(chart.label);
  return chart.rows.map((r) => ({
    label: r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label,
    value: r.value,
    display: money ? fmt.money(r.value, { compact: true }) : fmt.n(r.value),
  }));
}
