export default function VoteBuffer({ votes, confidence, service }) {
  // votes is an array of 1/0 values, max window size = 5
  const windowSize = 5;
  const slots = Array.from({ length: windowSize }, (_, i) => votes[i] ?? null);
  const anomCount = votes.filter(v => v === 1).length;

  return (
    <div className="card">
      <div className="card-label">Vote Buffer {service ? `· ${service}` : ''}</div>
      <div className="vote-slots">
        {slots.map((v, i) => (
          <div
            key={i}
            className={`vote-slot ${v === 1 ? 'vote-slot-anomaly' : 'vote-slot-normal'}`}
          >
            {v === 1 ? '!' : v === 0 ? '–' : '·'}
          </div>
        ))}
        <span className="vote-count-label">
          {anomCount} anomalous
        </span>
      </div>
      <div className="card-label" style={{ marginBottom: 0 }}>Confidence</div>
      <div className="conf-bar-wrap">
        <div className="conf-bar-labels">
          <span>0%</span>
          <span style={{ color: 'var(--blue)' }}>{confidence.toFixed(0)}%</span>
          <span>100%</span>
        </div>
        <div className="conf-bar-track">
          <div
            className="conf-bar-fill"
            style={{ width: `${Math.min(confidence, 100)}%` }}
          />
        </div>
        <div className="conf-threshold-marker">threshold: 80%</div>
      </div>
    </div>
  );
}
