// UniProt search. Ports search_uniprot (main.py:171-186) and result field extraction
// (main.py:1272-1310). UniProt's REST API supports CORS, so this runs client-side.
// If CORS is ever blocked, swap BASE_URL for a small proxy — this is the only place to change.

const BASE_URL = 'https://rest.uniprot.org/uniprotkb/search';

export interface UniProtHit {
  id: string; // uniProtkbId
  accession: string;
  proteinName: string;
  gene: string;
  organism: string;
  length: number;
  sequence: string;
}

interface RawResult {
  uniProtkbId?: string;
  primaryAccession?: string;
  proteinDescription?: { recommendedName?: { fullName?: { value?: string } } };
  genes?: Array<{ geneName?: { value?: string } }>;
  organism?: { scientificName?: string };
  sequence?: { value?: string; length?: number };
}

export async function searchUniProt(query: string, size = 25): Promise<UniProtHit[]> {
  const url = `${BASE_URL}?query=${encodeURIComponent(query)}&format=json&size=${size}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`UniProt search failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { results?: RawResult[] };
  return (data.results ?? []).map(extractHit);
}

function extractHit(r: RawResult): UniProtHit {
  return {
    id: r.uniProtkbId ?? 'Unknown',
    accession: r.primaryAccession ?? 'N/A',
    proteinName: r.proteinDescription?.recommendedName?.fullName?.value ?? 'N/A',
    gene: r.genes?.[0]?.geneName?.value ?? 'N/A',
    organism: r.organism?.scientificName ?? 'N/A',
    length: r.sequence?.length ?? 0,
    sequence: r.sequence?.value ?? '',
  };
}
