// Session (non-persisted) data state: the loaded file, sequence, and parsed rows.
// Kept separate from Config (which is persisted) because it is per-upload.

import { Row, Workbook } from '../io/parseExcel';

export type SeqSource = 'fasta' | 'sheet' | 'search' | 'manual';

export interface SessionData {
  fileName?: string;
  workbook?: Workbook;
  sheetNames: string[];
  sheetName?: string;
  columns: string[];
  rows: Row[];
  proteinSeq: string;
  seqSource: SeqSource;
  fastaSeq?: string;
}

export function emptySession(): SessionData {
  return {
    sheetNames: [],
    columns: [],
    rows: [],
    proteinSeq: '',
    seqSource: 'manual',
  };
}
