from pydantic import BaseModel, Field
from typing import Literal, Optional


VALID_MODES = (
    "ctf_challenge", "local_lab", "owned_asset_authorized_test",
    "code_review", "log_analysis", "report_generation", "safe_explanation",
)

TASK_STATUSES = ("pending", "running", "waiting_approval", "completed", "failed", "blocked")


class TaskRequest(BaseModel):
    mode: Literal[
        "ctf_challenge", "local_lab", "owned_asset_authorized_test",
        "code_review", "log_analysis", "report_generation", "safe_explanation"
    ] = "ctf_challenge"
    prompt: str = Field(min_length=1, max_length=8000)
    target: Optional[str] = None
    owner: Optional[str] = None
    priority: Literal["low", "medium", "high", "critical"] = "medium"
    tags: list[str] = []


class TaskStatusUpdate(BaseModel):
    status: Literal[
        "pending", "running", "waiting_approval", "completed", "failed", "blocked"
    ]
    comment: Optional[str] = None


class TaskComment(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class ToolRunRequest(BaseModel):
    tool: str = Field(min_length=1, max_length=80)
    mode: str = "local_lab"
    target: Optional[str] = None
    artifact_path: Optional[str] = None
    args: list[str] = Field(default=[], max_length=8)
