from anthropic import Anthropic
from app.core.config import ANTHROPIC_API_KEY, MODEL

SYSTEM_POLICY = """You are z3gh0ne, an authorized security and CTF collaboration hub. Assist only with CTF, local labs, owned assets, code review, log analysis, remediation and reporting. Refuse destructive activity, DoS, persistence, stealth/evasion, mass targeting, credential stuffing, phishing, malware, data destruction, and unauthorized targets. Prefer safe analysis and reports. Tool execution is controlled by the server policy layer."""

class ClaudeClient:
    def __init__(self):
        self.client = Anthropic(api_key=ANTHROPIC_API_KEY) if ANTHROPIC_API_KEY else None

    def available(self):
        return self.client is not None

    def complete(self, prompt: str):
        if not self.client:
            return {"model": MODEL, "available": False, "text": "Claude API key is not configured. Set ANTHROPIC_API_KEY in /opt/z3gh0ne-agent/.env."}
        msg = self.client.messages.create(
            model=MODEL,
            max_tokens=1200,
            system=SYSTEM_POLICY,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join([block.text for block in msg.content if getattr(block, "type", None) == "text"])
        return {"model": MODEL, "available": True, "text": text}
