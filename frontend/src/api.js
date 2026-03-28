const BASE = '/api';

export async function getHealth() {
  const r = await fetch(`${BASE}/health`);
  return r.json();
}

export async function startWarmup() {
  const r = await fetch(`${BASE}/warmup/start`, { method: 'POST' });
  return r.json();
}

export async function getWarmupStatus() {
  const r = await fetch(`${BASE}/warmup/status`);
  return r.json();
}

export async function runDetect() {
  const r = await fetch(`${BASE}/detect/run`, { method: 'POST' });
  return r.json();
}

export async function recoverService(serviceName) {
  const r = await fetch(`${BASE}/recover?service_name=${serviceName}`, { method: 'POST' });
  return r.json();
}

export async function getIncidents() {
  const r = await fetch(`${BASE}/incidents`);
  return r.json();
}

export async function getLatestIncident() {
  const r = await fetch(`${BASE}/latest`);
  return r.json();
}

export async function injectChaos(service, scenario) {
  const r = await fetch(`${BASE}/chaos/inject?service=${service}&scenario=${scenario}`, { method: 'POST' });
  if (!r.ok) {
    const err = await r.json();
    throw new Error(err.detail || 'Chaos injection failed');
  }
  return r.json();
}

export async function cleanupChaos() {
  const r = await fetch(`${BASE}/chaos/cleanup`, { method: 'POST' });
  return r.json();
}
