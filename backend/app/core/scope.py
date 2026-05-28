from pathlib import Path
import ipaddress, yaml
from urllib.parse import urlparse
from app.core.config import CONFIG_DIR

class ScopeValidator:
    def __init__(self):
        self.scope = yaml.safe_load((Path(CONFIG_DIR) / "allowed-scopes.yaml").read_text())

    def normalize_host(self, target: str) -> str:
        parsed = urlparse(target)
        return parsed.hostname if parsed.hostname else target.split('/')[0].split(':')[0]

    def allowed(self, target: str, mode: str):
        host = self.normalize_host(target)
        if not host:
            return {"allowed": False, "reason": "empty target"}
        for entry in self.scope.get("allowed_targets", []):
            if entry.get("mode") not in (mode, "any"):
                continue
            typ, value = entry.get("type"), entry.get("value")
            if typ == "host" and host == value:
                return {"allowed": True, "reason": "host matched scope"}
            if typ == "cidr":
                try:
                    if ipaddress.ip_address(host) in ipaddress.ip_network(value, strict=False):
                        return {"allowed": True, "reason": "cidr matched scope"}
                except ValueError:
                    pass
        return {"allowed": False, "reason": f"target {host} is outside allowed scope"}
