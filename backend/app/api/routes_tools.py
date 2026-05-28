from fastapi import APIRouter, Depends
from app.core.auth import require_token
from app.core.audit import audit
from app.tools.registry import ToolRegistry
from app.tools.dispatcher import ToolDispatcher
from app.tools.schemas import ToolRunRequest
router = APIRouter()

@router.get("/tools")
def tools(user=Depends(require_token)):
    return {"tools": ToolRegistry().list()}

@router.post("/tools/run")
def run_tool(req: ToolRunRequest, user=Depends(require_token)):
    res = ToolDispatcher().run(req)
    audit("tool_run", {"user": user, "tool": req.tool, "target": req.target, "result": {k:v for k,v in res.items() if k != "output"}})
    return res
