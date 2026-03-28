import { useState, useEffect, useRef, useCallback } from 'react';
import './index.css';

import Header from './components/Header';
import StatCard from './components/StatCard';
import VoteBuffer from './components/VoteBuffer';
import ServiceStatus from './components/ServiceStatus';
import LatencyChart from './components/LatencyChart';
import ActionLog from './components/ActionLog';
import IncidentTimeline from './components/IncidentTimeline';
import ChaosControls from './components/ChaosControls';

import {
  getHealth, startWarmup, getWarmupStatus, runDetect,
  recoverService, getIncidents,
} from './api';

const POLL_MS = 2000;
const MAX_HISTORY = 10;
const SERVICES = ['cartservice', 'paymentservice', 'recommendationservice', 'shippingservice', 'productcatalogservice'];

function ts() {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const makeInitialServices = () => Object.fromEntries(
  SERVICES.map(s => [s, { votes: [], confidence: 0, is_anomaly: false, features: { p95_latency: 0 }, _status: 'HEALTHY' }])
);

export default function App() {
  const [connected,  setConnected]  = useState(false);
  const [warmupDone, setWarmupDone] = useState(false);
  const [services,   setServices]   = useState(makeInitialServices());
  const [incidents,  setIncidents]  = useState([]);
  const [logs,       setLogs]       = useState([{ time: ts(), level: 'info', msg: 'Dashboard initialised. Connecting to backend…' }]);
  const [selected,   setSelected]   = useState(SERVICES[0]);

  // Per-service rolling latency history
  const [historyMap, setHistoryMap] = useState(() =>
    Object.fromEntries(SERVICES.map(s => [s, []]))
  );

  // Derived aggregate stats from focused service
  const focusedSvc = services[selected] || {};
  const anomalyVotes   = (focusedSvc.votes || []).filter(v => v === 1).length;
  const totalVotes     = (focusedSvc.votes || []).length;
  const confidence     = focusedSvc.confidence || 0;
  const incidentCount  = incidents.length;

  // Global status from the latest incident
  const latestIncident = incidents[0] || null;
  const globalStatus   = latestIncident?.status || 'HEALTHY';

  const warmupPollRef = useRef(null);
  const detectPollRef = useRef(null);
  const pendingRecover = useRef(new Set());

  const addLog = useCallback((entry) => {
    setLogs(prev => [...prev.slice(-199), { time: ts(), ...entry }]);
  }, []);

  // ── Boot: health check + warmup ──────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        await getHealth();
        setConnected(true);
        addLog({ level: 'info', msg: 'Backend connected ✓' });
      } catch {
        setConnected(false);
        addLog({ level: 'anomaly', msg: 'Backend unreachable! Start uvicorn on port 8000.' });
        return;
      }

      try {
        await startWarmup();
        addLog({ level: 'info', msg: 'Warm-up started — baseline collection in progress…' });
      } catch {
        addLog({ level: 'info', msg: 'Warm-up already completed or skipped.' });
      }

      // Poll warmup status
      warmupPollRef.current = setInterval(async () => {
        try {
          const { done } = await getWarmupStatus();
          if (done) {
            clearInterval(warmupPollRef.current);
            setWarmupDone(true);
            addLog({ level: 'recover', msg: 'Warm-up complete. Baseline fitted.' });
          }
        } catch { /* ignore */ }
      }, 1500);
    })();

    return () => {
      clearInterval(warmupPollRef.current);
      clearInterval(detectPollRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Main detect loop (starts after warmup) ───────────────────────
  useEffect(() => {
    if (!warmupDone) return;

    detectPollRef.current = setInterval(async () => {
      try {
        const data = await runDetect();
        if (data.error) { addLog({ level: 'info', msg: data.error }); return; }

        setServices(prev => {
          const next = { ...prev };
          Object.entries(data).forEach(([svc, svcState]) => {
            const prevStatus = prev[svc]?._status || 'HEALTHY';
            next[svc] = { ...svcState, _status: prevStatus };
          });
          return next;
        });

        // Update latency history for each service
        setHistoryMap(prev => {
          const next = { ...prev };
          Object.entries(data).forEach(([svc, svcState]) => {
            const lat  = svcState.features?.p95_latency ?? 0;
            const anom = svcState.is_anomaly;
            const status = anom ? 'anomaly' : 'normal';
            const entry = { latency: lat, status };
            next[svc] = [...(prev[svc] || []).slice(-(MAX_HISTORY - 1)), entry];
          });
          return next;
        });

        // Auto-recover any anomalous services
        for (const [svc, svcState] of Object.entries(data)) {
          if (svcState.is_anomaly && svcState.confidence >= 80 && !pendingRecover.current.has(svc)) {
            pendingRecover.current.add(svc);
            addLog({ level: 'anomaly', msg: `Anomaly detected — ${svc} (${svcState.confidence.toFixed(0)}%)` });
            addLog({ level: 'info',    msg: `Votes ${svcState.votes.filter(v=>v===1).length}/${svcState.votes.length}. Confidence ${svcState.confidence.toFixed(0)}%. Acting.` });

            (async () => {
              try {
                const res = await recoverService(svc);
                if (res.status === 'skipped') {
                  addLog({ level: 'info', msg: `Recovery skipped for ${svc}: ${res.reason}` });
                  pendingRecover.current.delete(svc);
                  return;
                }
                addLog({ level: 'recover', msg: `Restarted pod: ${res.pod_name || 'unknown'}` });

                if (res.status === 'HEALED') {
                  addLog({ level: 'healed', msg: `HEALED — ${svc}` });
                  setServices(prev => ({
                    ...prev,
                    [svc]: { ...prev[svc], _status: 'HEALED', is_anomaly: false },
                  }));
                  setHistoryMap(prev => ({
                    ...prev,
                    [svc]: [...(prev[svc] || []).slice(-1).map(e => ({ ...e, status: 'recovered' })), ...(prev[svc] || []).slice(0, -1)],
                  }));
                } else if (res.status === 'FAILED') {
                  addLog({ level: 'anomaly', msg: `Recovery FAILED for ${svc}. Manual mode engaged.` });
                }

                // Refresh incidents list
                const inc = await getIncidents();
                setIncidents(inc);
              } catch (e) {
                addLog({ level: 'anomaly', msg: `Recovery error for ${svc}: ${e.message}` });
              } finally {
                pendingRecover.current.delete(svc);
              }
            })();
          }
        }
      } catch {
        setConnected(false);
      }
    }, POLL_MS);

    return () => clearInterval(detectPollRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warmupDone]);

  // ── Fetch incidents on mount ─────────────────────────────────────
  useEffect(() => {
    getIncidents().then(setIncidents).catch(() => {});
  }, []);

  // ── Status badge value / colour ──────────────────────────────────
  const statusColors = {
    HEALED:   'var(--purple)',
    HEALTHY:  'var(--green)',
    WATCHING: 'var(--yellow)',
    ANOMALY:  'var(--red)',
    FAILED:   'var(--red)',
  };

  return (
    <div className="dashboard">
      <Header connected={connected} warmupDone={warmupDone} />

      <div className="main-grid">

        {/* ── Row 1: stat cards ── */}
        <div className="stat-row">
          <StatCard
            label="Confidence"
            value={`${confidence.toFixed(0)}%`}
            sub={`threshold: 80%`}
            valueStyle={{ color: confidence >= 80 ? 'var(--red)' : 'var(--blue)', fontSize: '2.4rem' }}
          />
          <StatCard
            label="Anomaly Votes"
            value={`${anomalyVotes} / ${totalVotes || 5}`}
            sub={`window: 5`}
          />
          <StatCard
            label="Status"
            value={globalStatus}
            sub={latestIncident?.service || selected}
            valueStyle={{ color: statusColors[globalStatus] || 'var(--text)', fontSize: '1.8rem', paddingTop: 6 }}
          />
          <StatCard
            label="Incidents"
            value={incidentCount}
            sub="this session"
          />
        </div>

        {/* ── Row 2 left: vote buffer ── */}
        <VoteBuffer
          votes={focusedSvc.votes || []}
          confidence={confidence}
          service={selected}
        />

        {/* ── Row 2 right: service status ── */}
        <ServiceStatus
          services={services}
          onSelectService={setSelected}
          selectedService={selected}
        />

        {/* ── Row 3 left: latency chart ── */}
        <LatencyChart
          history={historyMap[selected] || []}
          service={selected}
        />

        {/* ── Row 3 right: action log ── */}
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="section-title">Action Log</div>
          <div className="action-log-wrap" style={{ maxHeight: 230 }}>
            {logs.map((e, i) => (
              <div className="log-entry" key={i}>
                <span className="log-time">{e.time}</span>
                <span className={`log-msg-${e.level || 'info'}`}>{e.msg}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Row 4: Chaos Controls ── */}
        <ChaosControls onLog={addLog} />

        {/* ── Row 5: Incident Timeline ── */}
        <IncidentTimeline incidents={incidents} />

      </div>
    </div>
  );
}
