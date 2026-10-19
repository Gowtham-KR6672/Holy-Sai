/**
 * Report Centre API shapes (GET /reports/catalog, GET /reports/:key/preview).
 * Reconstructed from how the Report Centre and Report viewer pages read them.
 */

/** Filters a report reads: an "as at" date, or a from–to range. */
export type ReportFilter = 'date' | 'range';

export interface ReportCatalogItem {
  key: string;
  /** Students | Academics | Operations | Management | System */
  group: string;
  title: string;
  description: string;
  /** The signed-in role may run it. */
  available: boolean;
  /** Any one of these permissions makes it available… */
  requires: string[];
  /** …together with all of these. */
  alsoRequires: string[];
  /** Platform report (System group), returned to Super Admin only. */
  restricted: boolean;
  filters: ReportFilter[];
}

export interface ReportColumn {
  key: string;
  /** Money columns are labelled "… (INR)". */
  label: string;
}

export interface ReportSummaryTile {
  label: string;
  value: number;
  unit?: 'INR' | '%' | null;
  tone?: 'amber' | 'teal' | 'critical' | 'info' | 'violet';
}

export interface ReportChart {
  label: string;
  rows: { label: string; value: number }[];
}

/** One report row; `__row` is its position in the full report. */
export type ReportRow = Record<string, unknown> & { __row: number };

export interface ReportPreview {
  key: string;
  group: string;
  title: string;
  description: string;
  generatedAt: string;
  columns: ReportColumn[];
  /** Keys of the numeric columns (right-aligned; money when the label says INR). */
  numeric: string[];
  /** The requested page of rows, after search and sort. */
  rows: ReportRow[];
  /** Rows matching the search. */
  matchedRows: number;
  /** Rows in the report. */
  totalRows: number;
  /** More than 20,000 rows: the figures cover everything, the table is cut. */
  truncated: boolean;
  summary: ReportSummaryTile[];
  chart: ReportChart | null;
  filters: ReportFilter[];
}
