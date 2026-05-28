from pathlib import Path
from uuid import uuid4
from datetime import datetime, timezone
import json
from fastapi import APIRouter, Depends, HTTPException, Query
from app.core.auth import require_token
from app.core.audit import audit
from app.core.policy import PolicyGate
from app.core.config import DATA_DIR
from app.tools.schemas import TaskRequest, TaskStatusUpdate, TaskComment

router = APIRouter()
TASKS_DIR = Path(DATA_DIR) / "tasks"


def _tasks_dir():
    TASKS_DIR.mkdir(parents=True, exist_ok=True)
    return TASKS_DIR


def _load_task(task_id: str) -> dict:
    p = _tasks_dir() / f"{task_id}.json"
    if not p.exists():
        raise HTTPException(status_code=404, detail="task not found")
    return json.loads(p.read_text(encoding="utf-8"))


def _save_task(task: dict):
    p = _tasks_dir() / f"{task['task_id']}.json"
    p.write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")


@router.post("/tasks")
def create_task(req: TaskRequest, user=Depends(require_token)):
    policy = PolicyGate()
    for decision in (policy.check_mode(req.mode), policy.check_text(req.prompt)):
        if not decision["allowed"]:
            audit("task_refused", {"user": user, "mode": req.mode, "reason": decision["reason"]})
            raise HTTPException(status_code=403, detail=decision["reason"])

    now = datetime.now(timezone.utc).isoformat()
    task_id = str(uuid4())
    task = {
        "task_id": task_id,
        "status": "pending",
        "mode": req.mode,
        "prompt": req.prompt,
        "target": req.target,
        "owner": req.owner or user,
        "priority": req.priority,
        "tags": req.tags,
        "created_at": now,
        "updated_at": now,
        "created_by": user,
        "history": [{"ts": now, "action": "created", "by": user}],
        "comments": [],
        "artifacts": [],
        "result": None,
    }
    _save_task(task)
    audit("task_created", {"user": user, "task_id": task_id, "mode": req.mode, "target": req.target})
    return task


@router.get("/tasks")
def list_tasks(
    status: str | None = None,
    mode: str | None = None,
    owner: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    user=Depends(require_token),
):
    tasks_path = _tasks_dir()
    results = []
    for f in sorted(tasks_path.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        if len(results) >= limit:
            break
        try:
            t = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if status and t.get("status") != status:
            continue
        if mode and t.get("mode") != mode:
            continue
        if owner and t.get("owner") != owner:
            continue
        results.append({
            "task_id": t["task_id"],
            "status": t.get("status", "unknown"),
            "mode": t.get("mode"),
            "owner": t.get("owner"),
            "priority": t.get("priority", "medium"),
            "prompt": t.get("prompt", "")[:120],
            "created_at": t.get("created_at"),
            "updated_at": t.get("updated_at"),
        })
    return {"tasks": results, "total": len(results)}


@router.get("/tasks/{task_id}")
def get_task(task_id: str, user=Depends(require_token)):
    return _load_task(task_id)


@router.patch("/tasks/{task_id}/status")
def update_task_status(task_id: str, req: TaskStatusUpdate, user=Depends(require_token)):
    task = _load_task(task_id)
    now = datetime.now(timezone.utc).isoformat()
    old_status = task.get("status")
    task["status"] = req.status
    task["updated_at"] = now
    entry = {"ts": now, "action": "status_change", "by": user, "from": old_status, "to": req.status}
    if req.comment:
        entry["comment"] = req.comment
    task["history"].append(entry)
    _save_task(task)
    audit("task_status_changed", {"user": user, "task_id": task_id, "from": old_status, "to": req.status})
    return task


@router.post("/tasks/{task_id}/comments")
def add_comment(task_id: str, req: TaskComment, user=Depends(require_token)):
    task = _load_task(task_id)
    now = datetime.now(timezone.utc).isoformat()
    comment = {"id": str(uuid4()), "ts": now, "by": user, "text": req.text}
    task["comments"].append(comment)
    task["updated_at"] = now
    task["history"].append({"ts": now, "action": "comment_added", "by": user})
    _save_task(task)
    audit("task_comment", {"user": user, "task_id": task_id, "comment_id": comment["id"]})
    return comment


@router.post("/tasks/{task_id}/artifacts")
def add_artifact(task_id: str, path: str, label: str = "", user=Depends(require_token)):
    task = _load_task(task_id)
    now = datetime.now(timezone.utc).isoformat()
    safe_path = Path(path).name
    artifact = {"id": str(uuid4()), "ts": now, "by": user, "path": safe_path, "label": label}
    task["artifacts"].append(artifact)
    task["updated_at"] = now
    task["history"].append({"ts": now, "action": "artifact_added", "by": user, "path": safe_path})
    _save_task(task)
    return artifact


@router.post("/tasks/{task_id}/cancel")
def cancel_task(task_id: str, user=Depends(require_token)):
    task = _load_task(task_id)
    if task.get("status") in ("completed", "failed"):
        raise HTTPException(status_code=409, detail="cannot cancel a finished task")
    now = datetime.now(timezone.utc).isoformat()
    task["status"] = "failed"
    task["updated_at"] = now
    task["history"].append({"ts": now, "action": "cancelled", "by": user})
    _save_task(task)
    audit("task_cancelled", {"user": user, "task_id": task_id})
    return {"task_id": task_id, "status": "failed"}
