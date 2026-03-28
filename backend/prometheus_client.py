import math
import os
from datetime import datetime, timezone

import requests

PROMETHEUS_URL = os.environ.get(
    "PROMETHEUS_URL",
    "https://beulah-unadaptive-bumptiously.ngrok-free.dev",
)
HEADERS = {"ngrok-skip-browser-warning": "true"}
TIMEOUT = 5
NAMESPACE = "default"
SERVICES = [
    "cartservice",
    "recommendationservice",
    "adservice",
    "productcatalogservice",
    "checkoutservice",
]


def _query(promql: str) -> float | None:
    try:
        response = requests.get(
            f"{PROMETHEUS_URL}/api/v1/query",
            params={"query": promql},
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
        results = data["data"]["result"]
        if not results:
            return None
        val = float(results[0]["value"][1])
        if math.isnan(val) or math.isinf(val):
            return None
        return val
    except Exception as e:
        print(f"[PROM WARN] query failed: {promql[:60]} — {e}")
        return None


def _get_latency(service: str) -> float | None:
    """
    Try Istio request duration first (requires Istio sidecar injection).
    Falls back to liveness-probe duration as a rough proxy.
    Both return p95 in milliseconds.
    """
    queries = [
        # Istio-native latency — works after: kubectl label namespace default istio-injection=enabled
        (
            f'histogram_quantile(0.95, sum(rate('
            f'istio_request_duration_milliseconds_bucket'
            f'{{reporter="destination", destination_service_namespace="{NAMESPACE}", '
            f'destination_app=~".*{service}.*"}}[1m])) by (le))'
        ),
        # Kubernetes liveness-probe duration (always present, coarser signal)
        (
            f'histogram_quantile(0.95, sum(rate('
            f'prober_probe_duration_seconds_bucket'
            f'{{namespace="{NAMESPACE}", pod=~".*{service}.*", probe_type="Liveness"}}[1m])) by (le))'
            f' * 1000'
        ),
    ]
    for query in queries:
        value = _query(query)
        if value is not None:
            return value
    print(f"[PROM WARN] latency not found for {service} — enable Istio sidecar injection")
    return None


def _get_error_rate(service: str) -> tuple[float | None, bool]:
    """
    Returns (error_rate_pct, was_found).
    Tries Istio error rate first, then liveness-probe failure rate.
    Returns (None, False) if no query succeeds — never masks failures as 0.0.
    """
    queries = [
        # Istio — non-5xx/429 success rate inverted to error %
        (
            f'(1 - sum(rate(istio_requests_total'
            f'{{reporter="destination", destination_service_namespace="{NAMESPACE}", '
            f'destination_app=~".*{service}.*", response_code!~"5..|429"}}[1m]))'
            f' / sum(rate(istio_requests_total'
            f'{{reporter="destination", destination_service_namespace="{NAMESPACE}", '
            f'destination_app=~".*{service}.*"}}[1m]))) * 100'
        ),
        # Liveness-probe failure rate
        (
            f'(1 - (sum(rate(prober_probe_total'
            f'{{namespace="{NAMESPACE}", pod=~".*{service}.*", '
            f'probe_type="Liveness", result="successful"}}[1m]))'
            f' / sum(rate(prober_probe_total'
            f'{{namespace="{NAMESPACE}", pod=~".*{service}.*", '
            f'probe_type="Liveness"}}[1m])))) * 100'
        ),
    ]
    for query in queries:
        value = _query(query)
        if value is not None:
            return value, True
    return None, False


def _get_cpu(service: str) -> float | None:
    """
    Returns CPU usage in cores (summed across all containers of the pod).
    NOTE: Do NOT filter by cpu="total" — that label does not exist in
    container_cpu_usage_seconds_total; it causes zero results.
    """
    query = (
        f'sum(rate(container_cpu_usage_seconds_total'
        f'{{namespace="{NAMESPACE}", pod=~".*{service}.*", container!=""}}[1m]))'
    )
    value = _query(query)
    if value is None:
        print(f"[PROM WARN] cpu not found for {service}")
    return value


def _get_memory(service: str) -> float | None:
    """Returns RSS memory in MiB."""
    query = (
        f'sum(container_memory_working_set_bytes'
        f'{{namespace="{NAMESPACE}", pod=~".*{service}.*", container!=""}}) / 1048576'
    )
    value = _query(query)
    if value is None:
        print(f"[PROM WARN] memory not found for {service}")
    return value


def fetch_metrics(service: str) -> dict:
    try:
        lat = _get_latency(service)
        err, err_found = _get_error_rate(service)
        cpu = _get_cpu(service)
        mem = _get_memory(service)

        # Only treat error_rate as 0.0 when Prometheus explicitly returned 0.0.
        # If no query succeeded (err_found=False), keep it None so callers know
        # the metric is unavailable — not that the service is healthy.
        error_rate_final = err if err_found else None

        all_available = all(v is not None for v in [lat, error_rate_final, cpu, mem])
        missing = [
            key
            for key, value in {
                "p95_latency_ms": lat,
                "error_rate_pct": error_rate_final,
                "cpu_cores": cpu,
                "memory_mb": mem,
            }.items()
            if value is None
        ]

        return {
            "service": service,
            "p95_latency_ms": lat,
            "error_rate_pct": error_rate_final,
            "cpu_cores": cpu,
            "memory_mb": mem,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "all_available": all_available,
            "missing_fields": missing,
        }
    except Exception as e:
        print(f"[PROM ERROR] fetch_metrics({service}) crashed: {e}")
        return {
            "service": service,
            "p95_latency_ms": None,
            "error_rate_pct": None,
            "cpu_cores": None,
            "memory_mb": None,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "all_available": False,
            "missing_fields": [
                "p95_latency_ms",
                "error_rate_pct",
                "cpu_cores",
                "memory_mb",
            ],
        }


def validate_connection() -> bool:
    try:
        response = requests.get(
            f"{PROMETHEUS_URL}/api/v1/query",
            params={"query": "up"},
            headers=HEADERS,
            timeout=TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
        if data.get("status") == "success":
            print(f"Prometheus reachable at {PROMETHEUS_URL}")
            return True
        error = data.get("error", "unknown response")
        print(f" Prometheus unreachable: {error}")
        return False
    except Exception as e:
        print(f"Prometheus unreachable: {e}")
        return False