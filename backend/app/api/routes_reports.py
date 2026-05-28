from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Response
from app.core.auth import require_token
from app.core.config import DATA_DIR
router = APIRouter()

@router.get("/reports/{task_id}")
def report(task_id: str, user=Depends(require_token)):
    p = Path(DATA_DIR) / "tasks" / f"{task_id}.json"
    if not p.exists():
        raise HTTPException(status_code=404, detail="task not found")
    return Response(p.read_text(encoding="utf-8"), media_type="application/json")
