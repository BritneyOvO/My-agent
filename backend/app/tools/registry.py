from pathlib import Path
import yaml
from app.core.config import CONFIG_DIR

class ToolRegistry:
    def __init__(self):
        self.raw = yaml.safe_load((Path(CONFIG_DIR) / "tool-registry.yaml").read_text())
        self.tools = self.raw.get("tools", {})

    def list(self):
        return [{"name": name, **{k:v for k,v in meta.items() if k != "command"}} for name, meta in self.tools.items()]

    def get(self, name):
        return self.tools.get(name)
