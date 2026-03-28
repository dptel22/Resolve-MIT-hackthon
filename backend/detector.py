from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

try:
    import joblib

    HAS_JOBLIB = True
except ImportError:
    joblib = None
    HAS_JOBLIB = False

from service_catalog import (
    BASELINE_STATS_PATH,
    MODEL_CONFIG,
    SUPPORTED_SERVICES,
    get_supported_services,
)
from zscore_detector import ZScoreDetector

logger = logging.getLogger(__name__)

_MODELS_DIR = Path(__file__).resolve().parent / "models"
_DEFAULT_CONFIG: dict[str, Any] = {
    "features": ["p95_latency_ms", "error_rate_pct", "cpu_cores", "memory_mb"],
    "window_size": 5,
    "anomaly_threshold_votes": 4,
    "zscore_threshold": 3.0,
}


def _load_baselines() -> dict[str, dict[str, Any]]:
    if not BASELINE_STATS_PATH.exists():
        raise FileNotFoundError(
            f"Missing baseline stats at '{BASELINE_STATS_PATH}'. Run training first."
        )

    with BASELINE_STATS_PATH.open("r", encoding="utf-8") as fh:
        raw = json.load(fh)

    if not isinstance(raw, dict):
        raise ValueError("baseline_stats.json must be a JSON object keyed by service.")

    return {str(service): dict(stats) for service, stats in raw.items()}


def _build_zscore_detector(
    baselines: dict[str, dict[str, Any]], z_threshold: float
) -> ZScoreDetector:
    zscore = ZScoreDetector(z_threshold=z_threshold)
    for service, stats in baselines.items():
        zscore.b[service] = {
            "mean": {
                "p95_latency_ms": float(stats["p95_latency_ms_mean"]),
                "error_rate_pct": float(stats["error_rate_pct_mean"]),
            },
            "std": {
                "p95_latency_ms": max(float(stats["p95_latency_ms_std"]), 1e-6),
                "error_rate_pct": max(float(stats["error_rate_pct_std"]), 1e-6),
            },
        }
    return zscore


def _coerce_metric(value: Any) -> float | None:
    try:
        metric = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(metric) or math.isinf(metric):
        return None
    return metric


def _missing_feature_fields(
    metrics_dict: dict[str, Any], features: list[str]
) -> list[str]:
    return [feature for feature in features if _coerce_metric(metrics_dict.get(feature)) is None]


def _build_result(
    service: str,
    vote: int,
    detector: str,
    vote_buffer: list[int],
    *,
    missing_fields: list[str] | None = None,
    supported_service: bool = True,
    force_idle: bool = False,
) -> dict[str, Any]:
    if force_idle:
        vote_buffer.clear()
        votes = 0
        confidence = 0.0
        triggered = False
    else:
        vote_buffer.append(vote)
        if len(vote_buffer) > _cfg["window_size"]:
            vote_buffer.pop(0)

        votes = sum(vote_buffer)
        confidence = round((votes / _cfg["window_size"]) * 100, 1)
        triggered = (
            len(vote_buffer) == _cfg["window_size"]
            and votes >= _cfg["anomaly_threshold_votes"]
        )

    return {
        "service": service,
        "vote": vote,
        "window_votes": votes,
        "window_size": _cfg["window_size"],
        "confidence": confidence,
        "triggered": triggered,
        "detector_used": detector,
        "supported_service": supported_service,
        "missing_fields": missing_fields or [],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _load() -> tuple[
    Any,
    Any,
    ZScoreDetector,
    dict[str, Any],
    dict[str, dict[str, Any]],
    frozenset[str],
]:
    config = {**_DEFAULT_CONFIG, **MODEL_CONFIG}
    baselines = _load_baselines()
    supported_services = frozenset(SUPPORTED_SERVICES or tuple(baselines.keys()))
    zscore = _build_zscore_detector(
        baselines,
        z_threshold=float(config.get("zscore_threshold", 3.0)),
    )

    model = None
    scaler = None
    if HAS_JOBLIB:
        try:
            model = joblib.load(_MODELS_DIR / "isolation_forest.pkl")
            scaler = joblib.load(_MODELS_DIR / "scaler.pkl")
        except Exception as exc:
            logger.warning(
                "Could not load Isolation Forest artifacts; using z-score fallback only: %s",
                exc,
            )
    else:
        logger.warning(
            "joblib not installed. Machine-learning detector disabled; using z-score fallback."
        )

    return model, scaler, zscore, config, baselines, supported_services


_model, _scaler, _z, _cfg, _baselines, _supported_services = _load()


def run_detection(
    metrics_dict: dict[str, Any],
    vote_buffer: list[int],
    use_fallback: bool = False,
) -> dict[str, Any]:
    service = str(metrics_dict["service"])
    features: list[str] = list(_cfg["features"])
    missing_fields = _missing_feature_fields(metrics_dict, features)
    latency = _coerce_metric(metrics_dict.get("p95_latency_ms"))
    error_rate = _coerce_metric(metrics_dict.get("error_rate_pct"))

    if service not in _supported_services:
        logger.warning("Skipping unsupported service '%s' in detector.", service)
        return _build_result(
            service,
            vote=0,
            detector="unsupported_service",
            vote_buffer=vote_buffer,
            missing_fields=missing_fields,
            supported_service=False,
            force_idle=True,
        )

    if use_fallback or _model is None or _scaler is None or missing_fields:
        if latency is None or error_rate is None:
            return _build_result(
                service,
                vote=0,
                detector="skipped_missing_data",
                vote_buffer=vote_buffer,
                missing_fields=missing_fields,
                force_idle=True,
            )

        is_anomalous, _, _ = _z.predict_single(service, latency, error_rate)
        return _build_result(
            service,
            vote=1 if is_anomalous else 0,
            detector="zscore",
            vote_buffer=vote_buffer,
            missing_fields=missing_fields,
        )

    try:
        feature_vector = np.array(
            [[float(metrics_dict[feature]) for feature in features]],
            dtype=float,
        )
        scaled = _scaler.transform(feature_vector)
        prediction = _model.predict(scaled)[0]
        return _build_result(
            service,
            vote=1 if prediction == -1 else 0,
            detector="isolation_forest",
            vote_buffer=vote_buffer,
            missing_fields=missing_fields,
        )
    except Exception as exc:
        if latency is None or error_rate is None:
            return _build_result(
                service,
                vote=0,
                detector="skipped_missing_data",
                vote_buffer=vote_buffer,
                missing_fields=missing_fields,
                force_idle=True,
            )

        logger.warning(
            "Isolation Forest failed for %s; using z-score fallback: %s",
            service,
            exc,
        )
        is_anomalous, _, _ = _z.predict_single(service, latency, error_rate)
        return _build_result(
            service,
            vote=1 if is_anomalous else 0,
            detector="zscore_autofallback",
            vote_buffer=vote_buffer,
            missing_fields=missing_fields,
        )


def get_baseline(service: str) -> dict[str, Any]:
    if service not in _baselines:
        raise KeyError(f'No baseline for "{service}". Known: {list(_baselines.keys())}')
    return _baselines[service]


def get_supported_detector_services() -> list[str]:
    return get_supported_services()