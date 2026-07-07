// FASTA parsing. Mirrors the FASTA handling in main.py:1149-1174.

export function parseFasta(content: string): string {
  return content
    .trim()
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('>'))
    .map((line) => line.trim())
    .join('');
}
