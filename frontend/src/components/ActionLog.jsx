import { useEffect, useRef } from 'react';

const LEVEL_CLASS = {
  anomaly:  'log-msg-anomaly',
  recover:  'log-msg-recover',
  healed:   'log-msg-healed',
  chaos:    'log-msg-chaos',
  info:     'log-msg-info',
};

export default function ActionLog({ entries }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <div className="section-title">Action Log</div>
      <div className="action-log-wrap">
        {entries.map((e, i) => (
          <div className="log-entry" key={i}>
            <span className="log-time">{e.time}</span>
            <span className={LEVEL_CLASS[e.level] || 'log-msg-info'}>{e.msg}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
