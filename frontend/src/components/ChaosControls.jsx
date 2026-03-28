import { useState } from 'react';
import { injectChaos, cleanupChaos } from '../api';

const SERVICES_LIST = [
  'cartservice', 'paymentservice', 'recommendationservice',
  'shippingservice', 'productcatalogservice',
];

const SCENARIOS = [
  { value: 'cpu-stress',         label: '💻 CPU Stress' },
  { value: 'memory-pressure',    label: '🧠 Memory Pressure' },
  { value: 'network-latency',    label: '🌐 Network Latency' },
  { value: 'pod-kill',           label: '💀 Pod Kill' },
];

export default function ChaosControls({ onLog }) {
  const [service,  setService]  = useState(SERVICES_LIST[0]);
  const [scenario, setScenario] = useState(SCENARIOS[0].value);
  const [loading,  setLoading]  = useState(false);
  const [cleaning, setCleaning] = useState(false);

  const handleInject = async () => {
    setLoading(true);
    onLog({ level: 'chaos', msg: `Injecting [${scenario}] into ${service}…` });
    try {
      const res = await injectChaos(service, scenario);
      onLog({ level: 'chaos', msg: `Chaos injected → ${service} (${scenario}) — ${res.message || 'OK'}` });
    } catch (e) {
      onLog({ level: 'anomaly', msg: `Chaos inject failed: ${e.message}` });
    } finally {
      setLoading(false);
    }
  };

  const handleCleanup = async () => {
    setCleaning(true);
    onLog({ level: 'info', msg: 'Running chaos cleanup…' });
    try {
      await cleanupChaos();
      onLog({ level: 'recover', msg: 'All chaos experiments cleaned up.' });
    } catch {
      onLog({ level: 'anomaly', msg: 'Cleanup failed.' });
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <div className="section-title">Chaos Controls</div>
      <div className="chaos-controls">
        <div className="form-group">
          <label className="form-label">Service</label>
          <select value={service} onChange={e => setService(e.target.value)}>
            {SERVICES_LIST.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Scenario</label>
          <select value={scenario} onChange={e => setScenario(e.target.value)}>
            {SCENARIOS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <button className="btn btn-danger" onClick={handleInject} disabled={loading}>
          {loading ? '⚡ Injecting…' : '⚡ Inject Chaos'}
        </button>
        <button className="btn btn-outline" onClick={handleCleanup} disabled={cleaning}>
          {cleaning ? '🧹 Cleaning…' : '🧹 Cleanup All'}
        </button>
      </div>
    </div>
  );
}
