from datetime import datetime, timezone
from pathlib import Path
import json, uuid
from app.core.config import LOG_DIR

SENSITIVE = {"authorization", "token", "password", "api_key", "anthropic_api_key"}

def _redact(value):
    if isinstance(value, dict):
        return {k: ("<redacted>" if k.lower() in SENSITIVE else _redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v) for v in value]
    return value

def audit(event: str, payload: dict):
    request_id = payload.get("request_id") or str(uuid.uuid4())
    entry = {"ts": datetime.now(timezone.utc).isoformat(), "event": event, "request_id": request_id, "payload": _redact(payload)}
    path = Path(LOG_DIR) / "audit"
    path.mkdir(parents=True, exist_ok=True)
    with (path / "audit.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return request_id
