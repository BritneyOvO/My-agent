import { randomUUID } from "node:crypto";

export const evidenceTypes = ["tool_output", "observation", "hypothesis", "test_result", "finding", "artifact"] as const;
export const confidences = ["confirmed", "high", "medium", "low", "speculative"] as const;

export type EvidenceType = (typeof evidenceTypes)[number];
export type Confidence = (typeof confidences)[number];

export type Evidence = {
  id: string;
  type: EvidenceType;
  content: string;
  confidence: Confidence;
  source_tool?: string;
  source_agent?: string;
  parent_ids: string[];
  tags: string[];
  raw_output?: string;
  truncated: boolean;
  created_at: string;
  task_id?: string;
  plan_node_id?: string;
};

export class EvidenceGraph {
  private readonly items = new Map<string, Evidence>();

  add(evidence: Evidence) {
    this.items.set(evidence.id, evidence);
    return evidence;
  }

  recordToolOutput(input: { tool: string; output: string; agent?: string; taskId?: string; nodeId?: string }) {
    return this.add(createEvidence({
      type: "tool_output",
      content: input.output.slice(0, 500),
      confidence: "confirmed",
      source_tool: input.tool,
      source_agent: input.agent,
      raw_output: input.output.slice(0, 20000),
      truncated: input.output.length > 20000,
      task_id: input.taskId,
      plan_node_id: input.nodeId
    }));
  }

  observe(observation: string, basedOn: string[], agent?: string, confidence: Confidence = "medium") {
    return this.add(createEvidence({
      type: "observation",
      content: observation,
      confidence,
      source_agent: agent,
      parent_ids: basedOn
    }));
  }

  hypothesize(hypothesis: string, basedOn: string[], agent?: string) {
    return this.add(createEvidence({
      type: "hypothesis",
      content: hypothesis,
      confidence: "speculative",
      source_agent: agent,
      parent_ids: basedOn
    }));
  }

  recordTest(result: string, hypothesisId: string, confirms: boolean, tool?: string, agent?: string) {
    const evidence = this.add(createEvidence({
      type: "test_result",
      content: result,
      confidence: confirms ? "confirmed" : "low",
      source_tool: tool,
      source_agent: agent,
      parent_ids: [hypothesisId]
    }));
    const hypothesis = this.items.get(hypothesisId);
    if (hypothesis) {
      hypothesis.confidence = confirms ? "high" : "low";
    }
    return evidence;
  }

  conclude(finding: string, basedOn: string[], confidence: Confidence = "high", tags: string[] = []) {
    return this.add(createEvidence({
      type: "finding",
      content: finding,
      confidence,
      parent_ids: basedOn,
      tags
    }));
  }

  getChain(evidenceId: string) {
    const chain: Evidence[] = [];
    const visited = new Set<string>();
    const queue = [evidenceId];

    while (queue.length > 0) {
      const id = queue.shift();
      if (!id || visited.has(id)) {
        continue;
      }
      const item = this.items.get(id);
      if (!item) {
        continue;
      }
      visited.add(id);
      chain.push(item);
      queue.push(...item.parent_ids);
    }

    return chain;
  }

  getFindings() {
    return [...this.items.values()].filter((item) => item.type === "finding");
  }

  getByTask(taskId: string) {
    return [...this.items.values()].filter((item) => item.task_id === taskId);
  }

  toJSON() {
    return { items: Object.fromEntries(this.items.entries()) };
  }
}

function createEvidence(input: Partial<Evidence> & Pick<Evidence, "type" | "content" | "confidence">): Evidence {
  return {
    id: input.id ?? randomUUID(),
    type: input.type,
    content: input.content,
    confidence: input.confidence,
    source_tool: input.source_tool,
    source_agent: input.source_agent,
    parent_ids: input.parent_ids ?? [],
    tags: input.tags ?? [],
    raw_output: input.raw_output,
    truncated: input.truncated ?? false,
    created_at: input.created_at ?? new Date().toISOString(),
    task_id: input.task_id,
    plan_node_id: input.plan_node_id
  };
}
