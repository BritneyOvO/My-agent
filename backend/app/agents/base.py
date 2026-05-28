def result(summary, observations=None, hypotheses=None, recommended_actions=None, findings=None, blocked_reason=None):
    return {
        "summary": summary,
        "observations": observations or [],
        "hypotheses": hypotheses or [],
        "recommended_actions": recommended_actions or [],
        "findings": findings or [],
        "blocked_reason": blocked_reason,
    }
