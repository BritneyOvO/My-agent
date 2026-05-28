from app.agents.base import result

class ReconAgent:
    name = "recon"

    def run(self, context: dict):
        return result(
            summary="ReconAgent processed the request within z3gh0ne safety boundaries.",
            observations=[{"agent": self.name, "context_keys": sorted(context.keys())}],
            recommended_actions=[]
        )
