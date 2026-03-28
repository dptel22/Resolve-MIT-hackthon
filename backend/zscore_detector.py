class ZScoreDetector:
    def __init__(self, z_threshold: float = 3.0):
        self.z_threshold = z_threshold
        self.b: dict = {}
        self.feats = ['p95_latency_ms', 'error_rate_pct']
    def fit(self, df):
        for svc, g in df.groupby('service'):
            self.b[svc] = {
                'mean': g[self.feats].mean(),
                'std':  g[self.feats].std().clip(lower=1e-6)
            }
    def predict_single(self, service: str, latency: float, error_rate: float):
        if service not in self.b:
            raise KeyError(f'ZScoreDetector: unknown service "{service}". Known: {list(self.b.keys())}')
        b = self.b[service]
        zl = abs(latency     - b['mean']['p95_latency_ms']) / b['std']['p95_latency_ms']
        ze = abs(error_rate  - b['mean']['error_rate_pct']) / b['std']['error_rate_pct']
        return (zl > self.z_threshold or ze > self.z_threshold), round(float(zl), 2), round(float(ze), 2)