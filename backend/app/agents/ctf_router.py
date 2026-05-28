from app.agents.base import result

class CtfRouterAgent:
    name = "ctf_router"

    def run(self, context: dict):
        return result(
            summary="CtfRouterAgent processed the request within z3gh0ne safety boundaries.",
            observations=[{"agent": self.name, "context_keys": sorted(context.keys())}],
            recommended_actions=[]
        )
