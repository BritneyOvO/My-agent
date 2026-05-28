"""
z3gh0ne Evidence Graph

Every finding traces back through: tool_output → observation → hypothesis → test → finding.
This is what makes z3gh0ne forensically rigorous — no "trust me bro" conclusions.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
from uuid import uuid4
from datetime import datetime, timezone


class EvidenceType(str, Enum):
    TOOL_OUTPUT = "tool_output"
    OBSERVATION = "observation"
    HYPOTHESIS = "hypothesis"
    TEST_RESULT = "test_result"
    FINDING = "finding"
    ARTIFACT = "artifact"


class Confidence(str, Enum):
    CONFIRMED = "confirmed"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    SPECULATIVE = "speculative"


@dataclass
class Evidence:
    id: str = field(default_factory=lambda: str(uuid4()))
    type: EvidenceType = EvidenceType.OBSERVATION
    content: str = ""
    confidence: Confidence = Confidence.MEDIUM
    source_tool: Optional[str] = None
    source_agent: Optional[str] = None
    parent_ids: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    raw_output: Optional[str] = None
    truncated: bool = False
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    task_id: Optional[str] = None
    plan_node_id: Optional[str] = None

    def to_dict(self) -> dict:
        return {k: v.value if isinstance(v, Enum) else v for k, v in self.__dict__.items()}


class EvidenceGraph:
    """
    A directed graph of evidence items.
    
    Enables:
    - Tracing any finding back to raw tool output
    - Showing the reasoning chain for reports
    - Identifying weak links (low confidence) in the chain
    - Supporting or contradicting hypotheses with new evidence
    """

    def __init__(self):
        self._items: dict[str, Evidence] = {}

    def add(self, evidence: Evidence) -> Evidence:
        self._items[evidence.id] = evidence
        return evidence

    def record_tool_output(self, tool: str, output: str, agent: str = None,
                           task_id: str = None, node_id: str = None) -> Evidence:
        truncated = len(output) > 20000
        e = Evidence(
            type=EvidenceType.TOOL_OUTPUT,
            content=output[:500],
            confidence=Confidence.CONFIRMED,
            source_tool=tool,
            source_agent=agent,
            raw_output=output[:20000],
            truncated=truncated,
            task_id=task_id,
            plan_node_id=node_id,
        )
        return self.add(e)

    def observe(self, observation: str, based_on: list[str], agent: str = None,
                confidence: Confidence = Confidence.MEDIUM) -> Evidence:
        e = Evidence(
            type=EvidenceType.OBSERVATION,
            content=observation,
            confidence=confidence,
            source_agent=agent,
            parent_ids=based_on,
        )
        return self.add(e)

    def hypothesize(self, hypothesis: str, based_on: list[str], agent: str = None) -> Evidence:
        e = Evidence(
            type=EvidenceType.HYPOTHESIS,
            content=hypothesis,
            confidence=Confidence.SPECULATIVE,
            source_agent=agent,
            parent_ids=based_on,
        )
        return self.add(e)

    def record_test(self, result: str, hypothesis_id: str, confirms: bool,
                    tool: str = None, agent: str = None) -> Evidence:
        e = Evidence(
            type=EvidenceType.TEST_RESULT,
            content=result,
            confidence=Confidence.CONFIRMED if confirms else Confidence.LOW,
            source_tool=tool,
            source_agent=agent,
            parent_ids=[hypothesis_id],
        )
        self.add(e)
        if hypothesis_id in self._items:
            h = self._items[hypothesis_id]
            if confirms:
                h.confidence = Confidence.HIGH
            else:
                h.confidence = Confidence.LOW
        return e

    def conclude(self, finding: str, based_on: list[str], confidence: Confidence = Confidence.HIGH,
                 tags: list[str] = None) -> Evidence:
        e = Evidence(
            type=EvidenceType.FINDING,
            content=finding,
            confidence=confidence,
            parent_ids=based_on,
            tags=tags or [],
        )
        return self.add(e)

    def get_chain(self, evidence_id: str) -> list[Evidence]:
        """Walk back through parent_ids to get full provenance chain."""
        chain = []
        visited = set()
        queue = [evidence_id]
        while queue:
            eid = queue.pop(0)
            if eid in visited or eid not in self._items:
                continue
            visited.add(eid)
            item = self._items[eid]
            chain.append(item)
            queue.extend(item.parent_ids)
        return chain

    def get_findings(self) -> list[Evidence]:
        return [e for e in self._items.values() if e.type == EvidenceType.FINDING]

    def get_by_task(self, task_id: str) -> list[Evidence]:
        return [e for e in self._items.values() if e.task_id == task_id]

    def to_dict(self) -> dict:
        return {"items": {k: v.to_dict() for k, v in self._items.items()}}
