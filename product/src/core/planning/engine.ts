import { randomUUID } from "node:crypto";

export const nodeStatuses = ["pending", "running", "success", "failed", "pivoted", "blocked", "waiting_approval"] as const;
export const nodeTypes = ["goal", "strategy", "tactic", "action", "observation", "hypothesis", "pivot"] as const;

export type NodeStatus = (typeof nodeStatuses)[number];
export type NodeType = (typeof nodeTypes)[number];

export type PlanNode = {
  id: string;
  type: NodeType;
  status: NodeStatus;
  description: string;
  agent?: string;
  tool?: string;
  tool_args: Record<string, unknown>;
  parent_id?: string;
  children: string[];
  evidence_ids: string[];
  pivot_reason?: string;
  requires_approval: boolean;
  created_at: string;
  completed_at?: string;
};

export type StrategyInput = {
  type?: NodeType;
  description?: string;
  agent?: string;
  tool?: string;
  tool_args?: Record<string, unknown>;
  requires_approval?: boolean;
  reason?: string;
};

export class AttackTree {
  readonly id = randomUUID();
  readonly nodes = new Map<string, PlanNode>();
  readonly created_at = new Date().toISOString();
  readonly goal: string;
  readonly mode: string;
  readonly target?: string;
  root_id?: string;

  constructor(
    goal: string,
    mode = "ctf_challenge",
    target?: string
  ) {
    this.goal = goal;
    this.mode = mode;
    this.target = target;
  }

  addNode(node: PlanNode) {
    this.nodes.set(node.id, node);
    if (node.parent_id && this.nodes.has(node.parent_id)) {
      this.nodes.get(node.parent_id)?.children.push(node.id);
    }
    this.root_id ??= node.id;
    return node;
  }

  getNextActions() {
    return [...this.nodes.values()].filter((node) => {
      if (node.status !== "pending") {
        return false;
      }
      if (!node.parent_id) {
        return true;
      }
      return this.nodes.get(node.parent_id)?.status === "success";
    });
  }

  getFailedPaths() {
    return [...this.nodes.values()].filter((node) => node.status === "failed");
  }

  markComplete(nodeId: string, success: boolean, pivotReason = "") {
    const node = this.nodes.get(nodeId);
    if (!node) {
      return;
    }
    node.status = success ? "success" : "failed";
    node.completed_at = new Date().toISOString();
    if (!success && pivotReason) {
      node.pivot_reason = pivotReason;
    }
  }

  toJSON() {
    return {
      id: this.id,
      goal: this.goal,
      mode: this.mode,
      target: this.target,
      root_id: this.root_id,
      nodes: Object.fromEntries(this.nodes.entries()),
      created_at: this.created_at
    };
  }
}

export class PlanningEngine {
  createPlan(goal: string, mode: string, target?: string) {
    const tree = new AttackTree(goal, mode, target);
    tree.addNode(createPlanNode({
      type: "goal",
      description: goal,
      agent: "master"
    }));
    return tree;
  }

  expandNode(tree: AttackTree, nodeId: string, strategies: StrategyInput[]) {
    return strategies.map((strategy) => tree.addNode(createPlanNode({
      type: strategy.type ?? "action",
      description: strategy.description ?? "",
      agent: strategy.agent,
      tool: strategy.tool,
      tool_args: strategy.tool_args ?? {},
      parent_id: nodeId,
      requires_approval: strategy.requires_approval ?? false
    })));
  }

  pivot(tree: AttackTree, failedNodeId: string, newStrategy: StrategyInput) {
    const failed = tree.nodes.get(failedNodeId);
    if (!failed) {
      return undefined;
    }
    return tree.addNode(createPlanNode({
      type: "pivot",
      description: `Pivot from: ${failed.description}`,
      agent: newStrategy.agent,
      tool: newStrategy.tool,
      tool_args: newStrategy.tool_args ?? {},
      parent_id: failed.parent_id,
      pivot_reason: newStrategy.reason ?? "previous approach failed"
    }));
  }
}

export function createPlanNode(input: Partial<PlanNode> & Pick<PlanNode, "type" | "description">): PlanNode {
  return {
    id: input.id ?? randomUUID(),
    type: input.type,
    status: input.status ?? "pending",
    description: input.description,
    agent: input.agent,
    tool: input.tool,
    tool_args: input.tool_args ?? {},
    parent_id: input.parent_id,
    children: input.children ?? [],
    evidence_ids: input.evidence_ids ?? [],
    pivot_reason: input.pivot_reason,
    requires_approval: input.requires_approval ?? false,
    created_at: input.created_at ?? new Date().toISOString(),
    completed_at: input.completed_at
  };
}
