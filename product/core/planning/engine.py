"""
z3gh0ne Planning Engine

The core differentiator: security-domain planning with attack trees,
adaptive strategy, and evidence-driven pivots.

Unlike Claude Code/Codex which do linear step-by-step execution,
this engine builds a tree of possible approaches, executes them
adaptively, and pivots when one path fails.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
from uuid import uuid4
from datetime import datetime, timezone


class NodeStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    PIVOTED = "pivoted"
    BLOCKED = "blocked"
    WAITING_APPROVAL = "waiting_approval"


class NodeType(str, Enum):
    GOAL = "goal"
    STRATEGY = "strategy"
    TACTIC = "tactic"
    ACTION = "action"
    OBSERVATION = "observation"
    HYPOTHESIS = "hypothesis"
    PIVOT = "pivot"


@dataclass
class PlanNode:
    id: str = field(default_factory=lambda: str(uuid4()))
    type: NodeType = NodeType.ACTION
    status: NodeStatus = NodeStatus.PENDING
    description: str = ""
    agent: Optional[str] = None
    tool: Optional[str] = None
    tool_args: dict = field(default_factory=dict)
    parent_id: Optional[str] = None
    children: list[str] = field(default_factory=list)
    evidence_ids: list[str] = field(default_factory=list)
    pivot_reason: Optional[str] = None
    requires_approval: bool = False
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    completed_at: Optional[str] = None

    def to_dict(self) -> dict:
        return {k: v.value if isinstance(v, Enum) else v for k, v in self.__dict__.items()}


@dataclass
class AttackTree:
    """
    An attack tree represents the full space of approaches to a goal.
    Unlike a flat task list, it allows:
    - Multiple strategies for the same goal
    - Fallback paths when one approach fails
    - Evidence-driven pruning and expansion
    - Approval gates at high-risk nodes
    """
    id: str = field(default_factory=lambda: str(uuid4()))
    goal: str = ""
    mode: str = "ctf_challenge"
    target: Optional[str] = None
    nodes: dict[str, PlanNode] = field(default_factory=dict)
    root_id: Optional[str] = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def add_node(self, node: PlanNode) -> PlanNode:
        self.nodes[node.id] = node
        if node.parent_id and node.parent_id in self.nodes:
            self.nodes[node.parent_id].children.append(node.id)
        if not self.root_id:
            self.root_id = node.id
        return node

    def get_next_actions(self) -> list[PlanNode]:
        """Get all actionable nodes whose parents are complete."""
        ready = []
        for node in self.nodes.values():
            if node.status != NodeStatus.PENDING:
                continue
            if node.parent_id is None:
                ready.append(node)
            elif self.nodes.get(node.parent_id, PlanNode()).status == NodeStatus.SUCCESS:
                ready.append(node)
        return ready

    def get_failed_paths(self) -> list[PlanNode]:
        """Find failed nodes that might benefit from a pivot."""
        return [n for n in self.nodes.values() if n.status == NodeStatus.FAILED]

    def mark_complete(self, node_id: str, success: bool, pivot_reason: str = ""):
        if node_id not in self.nodes:
            return
        node = self.nodes[node_id]
        node.status = NodeStatus.SUCCESS if success else NodeStatus.FAILED
        node.completed_at = datetime.now(timezone.utc).isoformat()
        if not success and pivot_reason:
            node.pivot_reason = pivot_reason

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "goal": self.goal,
            "mode": self.mode,
            "target": self.target,
            "root_id": self.root_id,
            "nodes": {k: v.to_dict() for k, v in self.nodes.items()},
            "created_at": self.created_at,
        }


class PlanningEngine:
    """
    Generates and manages attack trees for security tasks.
    
    Key behaviors that beat Claude Code/Codex:
    1. Generates MULTIPLE strategies, not just one linear plan
    2. Executes in parallel where safe
    3. Pivots on failure instead of giving up
    4. Tracks evidence for every decision
    5. Triggers approval for high-risk actions
    """

    def create_plan(self, goal: str, mode: str, target: str = None, context: dict = None) -> AttackTree:
        tree = AttackTree(goal=goal, mode=mode, target=target)
        root = PlanNode(
            type=NodeType.GOAL,
            description=goal,
            agent="master",
        )
        tree.add_node(root)
        return tree

    def expand_node(self, tree: AttackTree, node_id: str, strategies: list[dict]) -> list[PlanNode]:
        """Expand a node with multiple child strategies/actions."""
        new_nodes = []
        for s in strategies:
            child = PlanNode(
                type=NodeType(s.get("type", "action")),
                description=s.get("description", ""),
                agent=s.get("agent"),
                tool=s.get("tool"),
                tool_args=s.get("tool_args", {}),
                parent_id=node_id,
                requires_approval=s.get("requires_approval", False),
            )
            tree.add_node(child)
            new_nodes.append(child)
        return new_nodes

    def pivot(self, tree: AttackTree, failed_node_id: str, new_strategy: dict) -> PlanNode:
        """When a path fails, create a pivot node with alternative approach."""
        failed = tree.nodes.get(failed_node_id)
        if not failed:
            return None
        pivot_node = PlanNode(
            type=NodeType.PIVOT,
            description=f"Pivot from: {failed.description}",
            agent=new_strategy.get("agent"),
            tool=new_strategy.get("tool"),
            tool_args=new_strategy.get("tool_args", {}),
            parent_id=failed.parent_id,
            pivot_reason=new_strategy.get("reason", "previous approach failed"),
        )
        tree.add_node(pivot_node)
        return pivot_node
