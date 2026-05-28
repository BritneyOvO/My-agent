from pathlib import Path
from uuid import uuid4
from datetime import datetime, timezone
import json
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from typing import Optional
from app.core.auth import require_token
from app.core.audit import audit
from app.core.config import DATA_DIR, MODEL, LLM_MODE

router = APIRouter()

CHANNELS = ("default", "ctf", "pentest", "handoff", "dev", "audit")


class HubMessage(BaseModel):
    channel: str = Field(default="default", max_length=80)
    message: str = Field(min_length=1, max_length=12000)
    metadata: dict = {}


@router.get("/hub/info")
def hub_info(user=Depends(require_token)):
    return {
        "name": "z3gh0ne",
        "model": MODEL,
        "llm_mode": LLM_MODE,
        "user": user,
        "channels": list(CHANNELS),
        "hub_role": "coordination_policy_audit_handoff",
        "primary_developer_agent": "external local Claude Code agent",
    }


@router.get("/hub/channels")
def list_channels(user=Depends(require_token)):
    hub_dir = Path(DATA_DIR) / "hub"
    result = []
    for ch in CHANNELS:
        p = hub_dir / ch / "messages.jsonl"
        count = 0
        last_ts = None
        if p.exists():
            lines = p.read_text(encoding="utf-8").splitlines()
            count = len(lines)
            if lines:
                try:
                    last_ts = json.loads(lines[-1]).get("ts")
                except (json.JSONDecodeError, IndexError):
                    pass
        result.append({"channel": ch, "message_count": count, "last_message_ts": last_ts})
    return {"channels": result}


@router.post("/hub/messages")
def post_message(req: HubMessage, user=Depends(require_token)):
    if req.channel not in CHANNELS:
        raise HTTPException(status_code=400, detail=f"invalid channel, must be one of: {', '.join(CHANNELS)}")
    msg = {
        "id": str(uuid4()),
        "ts": datetime.now(timezone.utc).isoformat(),
        "from": user,
        "channel": req.channel,
        "message": req.message,
        "metadata": req.metadata,
    }
    path = Path(DATA_DIR) / "hub" / req.channel
    path.mkdir(parents=True, exist_ok=True)
    with (path / "messages.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(msg, ensure_ascii=False) + "\n")
    audit("hub_message", {"user": user, "channel": req.channel, "message_id": msg["id"]})
    return msg


@router.get("/hub/messages/{channel}")
def list_messages(
    channel: str,
    limit: int = Query(default=50, ge=1, le=200),
    sender: Optional[str] = None,
    msg_type: Optional[str] = None,
    since: Optional[str] = None,
    user=Depends(require_token),
):
    if channel not in CHANNELS:
        raise HTTPException(status_code=400, detail=f"invalid channel")
    p = Path(DATA_DIR) / "hub" / channel / "messages.jsonl"
    if not p.exists():
        return {"channel": channel, "messages": [], "total": 0}

    lines = p.read_text(encoding="utf-8").splitlines()
    messages = []
    for line in reversed(lines):
        if not line.strip():
            continue
        try:
            m = json.loads(line)
        except json.JSONDecodeError:
            continue
        if sender and m.get("from") != sender:
            continue
        if msg_type and m.get("metadata", {}).get("type") != msg_type:
            continue
        if since and m.get("ts", "") < since:
            break
        messages.append(m)
        if len(messages) >= limit:
            break

    messages.reverse()
    return {"channel": channel, "messages": messages, "total": len(messages)}
