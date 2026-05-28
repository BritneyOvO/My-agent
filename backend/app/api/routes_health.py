from fastapi import APIRouter
from app.core.config import MODEL, LLM_MODE

router = APIRouter()


@router.get("/health")
def health():
    return {
        "ok": True,
        "name": "z3gh0ne",
        "version": "0.2.0",
        "model": MODEL,
        "llm_mode": LLM_MODE,
        "hub_role": "coordination_policy_audit_handoff",
        "primary_developer_agent": "external local Claude Code agent",
        "claude_api_configured": False,
    }
