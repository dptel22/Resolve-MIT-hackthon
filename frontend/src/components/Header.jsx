import { useEffect, useState } from 'react';

export default function Header({ connected, warmupDone }) {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <header className="header">
      <span className="header-logo">⚡ KubeResilience</span>
      <div className="header-spacer" />
      {!warmupDone && (
        <span className="badge badge-warming" style={{ fontSize: 11 }}>⏳ Warming up…</span>
      )}
      <div className="connection-pill">
        <span className={`dot ${connected ? 'dot-green' : 'dot-red'}`} />
        <span style={{ color: connected ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
          {connected ? 'Backend connected' : 'Backend offline'}
        </span>
      </div>
      <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>Polling every 2s</span>
      <span className="header-clock">{time}</span>
    </header>
  );
}
