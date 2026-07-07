// Excel/CSV parsing via SheetJS, plus column-type detection and peptide building.
// Replaces the pandas-based loading + column heuristics in main.py.

import * as XLSX from 'xlsx';
import { Peptide } from '../model/peptides';

export type Row = Record<string, unknown>;

export interface Workbook {
  sheetNames: string[];
  read(sheetName: string): { columns: string[]; rows: Row[] };
}

export async function readWorkbook(file: File): Promise<Workbook> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  return {
    sheetNames: wb.SheetNames,
    read(sheetName: string) {
      const ws = wb.Sheets[sheetName] ?? wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Row>(ws, { defval: null });
      const columns = rows.length ? Object.keys(rows[0]) : headerRow(ws);
      return { columns, rows };
    },
  };
}

function headerRow(ws: XLSX.WorkSheet): string[] {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
  return (aoa[0] as unknown[] | undefined)?.map((c) => String(c)) ?? [];
}

function toNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Columns whose every non-empty value is numeric. */
export function numericColumns(columns: string[], rows: Row[]): string[] {
  return columns.filter((col) =>
    rows.every((r) => r[col] == null || r[col] === '' || toNumber(r[col]) != null),
  );
}

/** Numeric columns whose values are all integers (candidate start/end columns). */
export function integerColumns(columns: string[], rows: Row[]): string[] {
  return numericColumns(columns, rows).filter((col) =>
    rows.some((r) => toNumber(r[col]) != null) &&
    rows.every((r) => {
      const n = toNumber(r[col]);
      return n == null || Number.isInteger(n);
    }),
  );
}

/** Text-like columns (candidate peptide-sequence columns). */
export function textColumns(columns: string[], rows: Row[]): string[] {
  return columns.filter((col) =>
    rows.some((r) => typeof r[col] === 'string' && (r[col] as string).trim() !== ''),
  );
}

const START_KEYWORDS = ['start', 'begin', 'first', 'from', 'initial', 'beginning'];
const END_KEYWORDS = ['end', 'finish', 'last', 'to', 'final', 'stop', 'ending'];

export interface ColumnGuess {
  start?: string;
  end?: string;
  intensity: string[];
  peptideSeq?: string;
}

/** Heuristic column detection, mirroring the keyword logic in main.py:1457-1476 & 1592-1624. */
export function guessColumns(columns: string[], rows: Row[]): ColumnGuess {
  const ints = integerColumns(columns, rows);
  const nums = numericColumns(columns, rows);

  const start =
    ints.find((c) => START_KEYWORDS.some((k) => c.toLowerCase().includes(k))) ??
    columns.find((c) => START_KEYWORDS.some((k) => c.toLowerCase().includes(k)) && ints.includes(c));
  const end =
    ints.find((c) => END_KEYWORDS.some((k) => c.toLowerCase().includes(k))) ??
    columns.find((c) => END_KEYWORDS.some((k) => c.toLowerCase().includes(k)) && ints.includes(c));

  const intensity = nums.filter(
    (c) => c.toLowerCase().includes('area') || c.toLowerCase().includes('intensity'),
  );

  const peptideSeq = textColumns(columns, rows).find((c) =>
    ['peptide', 'sequence'].includes(c.toLowerCase()),
  );

  return { start, end, intensity, peptideSeq };
}

/** Build the peptide list from rows + chosen columns (mirrors main.py:2277-2292). */
export function buildPeptides(
  rows: Row[],
  startCol: string,
  endCol: string,
  intensityCols: string[],
  peptideSeqCol?: string,
): Peptide[] {
  const peptides: Peptide[] = [];
  for (const r of rows) {
    const start = toNumber(r[startCol]);
    const end = toNumber(r[endCol]);
    if (start == null || end == null) continue;
    const intensity: Record<string, number> = {};
    for (const col of intensityCols) intensity[col] = toNumber(r[col]) ?? 0;
    const seq =
      peptideSeqCol && typeof r[peptideSeqCol] === 'string'
        ? (r[peptideSeqCol] as string)
        : undefined;
    peptides.push({ start: Math.trunc(start), end: Math.trunc(end), intensity, seq });
  }
  return peptides;
}

/** Read a sequence value from the first non-empty cell of a column. */
export function sequenceFromColumn(rows: Row[], col: string): string {
  for (const r of rows) {
    const v = r[col];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}
