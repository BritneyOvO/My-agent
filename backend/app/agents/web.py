from app.agents.base import result

class WebAgent:
    name = "web"

    def run(self, context: dict):
        return result(
            summary="WebAgent processed the request within z3gh0ne safety boundaries.",
            observations=[{"agent": self.name, "context_keys": sorted(context.keys())}],
            recommended_actions=[]
        )
