from pathlib import Path
import re, yaml
from app.core.config import CONFIG_DIR

class PolicyGate:
    def __init__(self):
        self.policy = yaml.safe_load((Path(CONFIG_DIR) / "agent-policy.yaml").read_text())
        self.blocked_keywords = [x.lower() for x in self.policy.get("blocked_keywords", [])]

    def check_text(self, text: str):
        lowered = text.lower()
        for keyword in self.blocked_keywords:
            if keyword in lowered:
                return {"allowed": False, "reason": f"blocked by safety policy: {keyword}"}
        return {"allowed": True, "reason": "allowed"}

    def check_mode(self, mode: str):
        allowed = set(self.policy.get("allowed_categories", []))
        if mode not in allowed:
            return {"allowed": False, "reason": f"mode {mode} is not allowed"}
        return {"allowed": True, "reason": "allowed"}
