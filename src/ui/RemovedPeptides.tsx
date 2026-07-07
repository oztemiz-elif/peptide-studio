// Removed-peptide report. Ports display_removed_peptides (main.py:376-595):
// summary metrics, per-peptide table, and a calculation-details disclosure.

import { Config } from '../state/config';
import { IntensityScale, RemovedPeptide } from '../model/filtering';

interface Props {
  removed: RemovedPeptide[];
  displayedCount: number;
  totalCount: number;
  scale: IntensityScale;
  config: Config;
}

export function RemovedPeptides({ removed, displayedCount, totalCount, scale, config }: Props) {
  if (removed.length === 0) return null;

  const tooShort = removed.filter((p) => p.summaryReasons.some((r) => r.includes('Too short'))).length;
  const tooLong = removed.filter((p) => p.summaryReasons.some((r) => r.includes('Too long'))).length;
  const belowMin = removed.filter((p) =>
    p.byTimepoint.some((t) => t.reasons.some((r) => r.includes('Below min intensity'))),
  ).length;
  const aboveMax = removed.filter((p) =>
    p.byTimepoint.some((t) => t.reasons.some((r) => r.includes('Above max intensity'))),
  ).length;

  return (
    <div className="report">
      <p className="muted">
        {displayedCount} of {totalCount} peptides displayed · {removed.length} removed at ≥1 time point
      </p>
      <div className="metrics">
        <Metric n={removed.length} l="Total removed" />
        <Metric n={tooShort} l="Too short" />
        <Metric n={tooLong} l="Too long" />
        <Metric n={belowMin} l="Below min intensity" />
        <Metric n={aboveMax} l="Above max intensity" />
      </div>

      <details>
        <summary>Removed peptides ({removed.length})</summary>
        <table>
          <thead>
            <tr>
              <th>Position</th>
              <th>Length</th>
              <th>Sequence</th>
              <th>Max intensity</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {removed.map((p, i) => {
              const maxI = Math.max(0, ...Object.values(p.intensity));
              // Index, not `${start}-${end}` — two distinct rows (e.g. the same peptide
              // identified across replicates/charge states) can share identical start/end,
              // and a duplicate key here can crash React's reconciler when this list's
              // length changes on the same render as other keyed lists (see PrimSvg.tsx).
              return (
                <tr key={i}>
                  <td>
                    {p.start}-{p.end}
                  </td>
                  <td>{p.length}</td>
                  <td>{p.sequence || 'N/A'}</td>
                  <td>{maxI > 0 ? maxI.toExponential(2) : '0'}</td>
                  <td>{p.summaryReasons.join(' | ')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>

      <details>
        <summary>Calculation details</summary>
        <p className="muted">
          Thresholds: min{' '}
          {scale.minUserSet ? scale.minRaw.toExponential(2) : 'auto'} · max{' '}
          {scale.maxUserSet ? scale.maxRaw.toExponential(2) : 'auto'} · transformation{' '}
          {config.transformation}
        </p>
        <p className="muted">
          {config.colors.length} color bins across [{scale.minT.toExponential(2)},{' '}
          {scale.maxT.toExponential(2)}]:
        </p>
        <ul className="muted">
          {scale.bins.slice(0, -1).map((edge, i) => (
            <li key={i}>
              Bin {i + 1}: {edge.toExponential(2)} → {scale.bins[i + 1].toExponential(2)}
            </li>
          ))}
        </ul>
        <p className="muted">
          Filtering is time-point specific: each column is filtered independently.
        </p>
      </details>
    </div>
  );
}

function Metric({ n, l }: { n: number; l: string }) {
  return (
    <div className="metric">
      <div className="n">{n}</div>
      <div className="l">{l}</div>
    </div>
  );
}
