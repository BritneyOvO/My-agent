from fastapi import Header, HTTPException, status
from app.core.config import ADMIN_TOKEN, ADMIN_USER, LOCAL_AGENT_TOKEN, LOCAL_AGENT_USER

async def require_token(authorization: str | None = Header(default=None)) -> str:
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=503, detail="admin token is not configured")
    if authorization == f"Bearer {ADMIN_TOKEN}":
        return ADMIN_USER
    if LOCAL_AGENT_TOKEN and authorization == f"Bearer {LOCAL_AGENT_TOKEN}":
        return LOCAL_AGENT_USER
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token")
