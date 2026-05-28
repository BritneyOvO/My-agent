from uuid import uuid4
from fastapi import FastAPI, Request, Response
from app.api.routes_health import router as health_router
from app.api.routes_tasks import router as tasks_router
from app.api.routes_reports import router as reports_router
from app.api.routes_tools import router as tools_router
from app.api.routes_hub import router as hub_router

app = FastAPI(title="z3gh0ne Hub", version="0.2.0")


@app.middleware("http")
async def add_request_id(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID") or str(uuid4())
    request.state.request_id = request_id
    response: Response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response


app.include_router(health_router)
app.include_router(tasks_router)
app.include_router(reports_router)
app.include_router(tools_router)
app.include_router(hub_router)
