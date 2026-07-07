// Protein sequence validation. Ports validate_protein_sequence from protein_sequence_input.py.

const VALID_AA = new Set('ACDEFGHIKLMNPQRSTVWY'.split(''));

export interface ValidationResult {
  isValid: boolean;
  invalidPositions: number[];
  cleaned: string;
  /** Display char ("'X'", "(space)"...) -> positions where it occurred. */
  invalidChars: Record<string, number[]>;
}

function displayChar(ch: string): string {
  if (ch === ' ') return '(space)';
  if (ch === '\n') return '(newline)';
  if (ch === '\t') return '(tab)';
  return `'${ch}'`;
}

export function validateSequence(sequence: string): ValidationResult {
  const invalidPositions: number[] = [];
  const invalidChars: Record<string, number[]> = {};
  let cleaned = '';

  for (let i = 0; i < sequence.length; i++) {
    const ch = sequence[i];
    if (VALID_AA.has(ch.toUpperCase())) {
      cleaned += ch;
    } else {
      invalidPositions.push(i);
      const key = displayChar(ch);
      (invalidChars[key] ??= []).push(i);
    }
  }

  return {
    isValid: invalidPositions.length === 0,
    invalidPositions,
    cleaned,
    invalidChars,
  };
}
