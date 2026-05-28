from pathlib import Path
import subprocess
import re
from app.core.config import DATA_DIR
from app.core.scope import ScopeValidator
from app.core.policy import PolicyGate
from app.tools.registry import ToolRegistry

DANGEROUS_ARG_PATTERNS = re.compile(r"[;&|`$]|\.\./|/etc/|/proc/|/sys/")
MAX_OUTPUT = 20000


class ToolDispatcher:
    def __init__(self):
        self.registry = ToolRegistry()
        self.scope = ScopeValidator()
        self.policy = PolicyGate()

    def _error(self, code: str, message: str):
        return {"allowed": False, "error_code": code, "error": message}

    def _validate_args(self, args: list[str], tool_name: str) -> str | None:
        for arg in args:
            if DANGEROUS_ARG_PATTERNS.search(arg):
                return f"argument contains forbidden characters: {arg[:30]}"
            if len(arg) > 500:
                return "argument too long"
        return None

    def run(self, request):
        meta = self.registry.get(request.tool)
        if not meta:
            return self._error("unknown_tool", f"tool '{request.tool}' not found in registry")

        policy_check = self.policy.check_mode(request.mode)
        if not policy_check["allowed"]:
            return self._error("policy_denied", policy_check["reason"])

        if request.target:
            target_policy = self.policy.check_text(request.target)
            if not target_policy["allowed"]:
                return self._error("policy_denied", target_policy["reason"])

        if meta.get("requires_scope"):
            if not request.target:
                return self._error("scope_missing", "this tool requires a target within allowed scope")
            decision = self.scope.allowed(request.target, request.mode)
            if not decision["allowed"]:
                return self._error("scope_denied", decision["reason"])

        arg_err = self._validate_args(request.args, request.tool)
        if arg_err:
            return self._error("invalid_args", arg_err)

        cmd = list(meta["command"])

        if request.artifact_path:
            safe_name = Path(request.artifact_path).name
            if not safe_name or safe_name.startswith("."):
                return self._error("invalid_artifact", "artifact path is invalid")
            artifact_full = Path("/data/uploads") / safe_name
            if not str(artifact_full).startswith("/data/uploads/"):
                return self._error("invalid_artifact", "artifact path escapes sandbox")
            cmd.append(str(artifact_full))

        if request.target:
            cmd.append(request.target)

        cmd.extend(request.args[:8])

        timeout = int(meta.get("timeout", 30))
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd="/data/workspaces",
            )
            output = (proc.stdout + proc.stderr)[:MAX_OUTPUT]
            truncated = len(proc.stdout + proc.stderr) > MAX_OUTPUT
            return {
                "allowed": True,
                "tool": request.tool,
                "exit_code": proc.returncode,
                "output": output,
                "truncated": truncated,
                "timeout_used": timeout,
            }
        except subprocess.TimeoutExpired:
            return self._error("timeout", f"tool exceeded {timeout}s timeout")
        except FileNotFoundError:
            return self._error("tool_not_found", f"binary not available in container")
        except OSError as e:
            return self._error("exec_error", str(e)[:200])
