import os
from pathlib import Path

BASE_DIR = Path(os.getenv("Z3GH0NE_BASE_DIR", "/srv/z3gh0ne"))
CONFIG_DIR = Path(os.getenv("Z3GH0NE_CONFIG_DIR", "/config"))
DATA_DIR = Path(os.getenv("Z3GH0NE_DATA_DIR", "/data"))
LOG_DIR = Path(os.getenv("Z3GH0NE_LOG_DIR", "/logs"))
MODEL = os.getenv("Z3GH0NE_MODEL", "claude-opus-4-6")
LLM_MODE = os.getenv("Z3GH0NE_LLM_MODE", "external_local_cc")
ADMIN_USER = os.getenv("Z3GH0NE_ADMIN_USER", "agent")
ADMIN_PASSWORD = os.getenv("Z3GH0NE_ADMIN_PASSWORD", "")
ADMIN_TOKEN = os.getenv("Z3GH0NE_ADMIN_TOKEN", "")
LOCAL_AGENT_USER = os.getenv("Z3GH0NE_LOCAL_AGENT_USER", "local-agent")
LOCAL_AGENT_TOKEN = os.getenv("Z3GH0NE_LOCAL_AGENT_TOKEN", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
