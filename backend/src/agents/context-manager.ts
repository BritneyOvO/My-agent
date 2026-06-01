import {
  modelContextPolicy,
  runAiCompletion,
  type AiToolLoopState,
  type StoredAiApiConfig
} from "../lib/ai-config.js";

type StepLike = {
  step: number;
  ts: string;
  thought: string;
  tool_calls: Array<{
    tool: string;
    target: string | null;
    artifact_path?: string;
    args: string[];
    result: Record<string, unknown>;
  }>;
  analysis: string;
  flags: string[];
};

const keepRecentSteps = Math.max(2, Number.parseInt(process.env.Z3GH0NE_CONTEXT_KEEP_RECENT_STEPS ?? "5", 10));
const maxCompactFailures = Math.max(1, Number.parseInt(process.env.Z3GH0NE_CONTEXT_COMPACT_MAX_FAILURES ?? "3", 10));

function nowIso() {
  return new Date().toISOString();
}

function estimateTokens(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil((text?.length ?? 0) / 4);
}

function textOf(value: unknown, max = 1200) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}\n...<truncated>` : text;
}

function activeMessagesForEstimate(config: StoredAiApiConfig, state: AiToolLoopState) {
  if (state.api_mode === "chat" || config.provider === "deepseek") return state.chatMessages;
  if (state.api_mode === "anthropic" || config.provider === "anthropic") return state.anthropicMessages;
  return state.responsesInput;
}

function estimateStateTokens(config: StoredAiApiConfig, state: AiToolLoopState) {
  return estimateTokens({
    system: state.system,
    messages: activeMessagesForEstimate(config, state)
  });
}

function summarizeStep(step: StepLike) {
  const toolText = step.tool_calls.length
    ? step.tool_calls.map((call) => {
      const output = call.result.error ?? call.result.output ?? "";
      return [
        `${call.tool}(${call.target ?? call.artifact_path ?? call.args.join(" ")})`,
        `exit=${String(call.result.exit_code ?? call.result.error_code ?? "done")}`,
        textOf(output, 1000)
      ].join(" ");
    }).join("\n")
    : "无";
  return [
    `Step ${step.step} ${step.ts}`,
    `AI/思路: ${textOf(step.thought, 1400)}`,
    `工具结果:\n${toolText}`,
    step.analysis ? `分析: ${textOf(step.analysis, 800)}` : "",
    step.flags.length ? `疑似 Flag: ${step.flags.join(", ")}` : ""
  ].filter(Boolean).join("\n");
}

function compactPrompt(input: {
  taskPrompt: string;
  previousSummaries: string[];
  stepsToSummarize: StepLike[];
}) {
  return [
    "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
    "",
    "你的任务是压缩 CTF Agent 已执行的旧上下文，生成后续继续解题所需的详细摘要。",
    "必须保留：用户原始目标、附件/路径、已执行工具、关键输出、错误、已排除路线、疑似 flag、下一步应继续的位置。",
    "不要泛泛总结；不要编造没有出现过的结论。",
    "",
    "输出格式：",
    "<summary>",
    "1. 原始任务与目标",
    "2. 已确认事实与关键文件/路径",
    "3. 已执行步骤与工具输出要点",
    "4. 错误、失败路径与避免重复事项",
    "5. 疑似 flag / 关键证据",
    "6. 后续继续执行建议",
    "</summary>",
    "",
    "## 原始任务",
    input.taskPrompt,
    "",
    input.previousSummaries.length ? `## 之前已有压缩摘要\n${input.previousSummaries.join("\n\n---\n\n")}` : "",
    "",
    "## 本次需要压缩的旧步骤",
    input.stepsToSummarize.map(summarizeStep).join("\n\n---\n\n")
  ].filter(Boolean).join("\n");
}

function formatCompactSummary(summary: string) {
  return summary
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
    .replace(/<\/?summary>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function continuationPrompt(input: {
  taskPrompt: string;
  summaries: string[];
  recentSteps: StepLike[];
}) {
  return [
    input.taskPrompt,
    "",
    "## 压缩上下文摘要",
    "这次会话上下文已压缩。以下摘要覆盖更早的 Agent 步骤，请直接基于摘要和最近完整步骤继续，不要从零开始。",
    input.summaries.join("\n\n---\n\n"),
    "",
    "## 最近完整步骤（保持原始细节）",
    input.recentSteps.length ? input.recentSteps.map(summarizeStep).join("\n\n---\n\n") : "无",
    "",
    "继续执行要求：",
    "- 继续推进当前 CTF 任务，不要询问用户是否继续。",
    "- 不要重复已失败且没有新信息的工具调用。",
    "- 需要工具就直接调用 run_tool；已经能给出最终答案就输出最终答案。"
  ].join("\n");
}

function resetState(state: AiToolLoopState, prompt: string) {
  state.prompt = prompt;
  state.responsesInput = [{ role: "user", content: prompt }];
  state.anthropicMessages = [{ role: "user", content: prompt }];
  state.chatMessages = [{ role: "user", content: prompt }];
}

export function isContextLengthAiError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return /context_length|prompt.?too.?long|maximum context|context window|input tokens|too many tokens|request too large|413/i.test(text);
}

export async function maybeCompactAiContext(input: {
  config: StoredAiApiConfig;
  state: AiToolLoopState;
  taskPrompt: string;
  steps: StepLike[];
  force?: boolean;
}) {
  if (process.env.Z3GH0NE_DISABLE_CONTEXT_COMPACT === "1") {
    return { compacted: false, reason: "disabled" };
  }

  const policy = modelContextPolicy(input.config);
  const currentTokens = estimateStateTokens(input.config, input.state);
  const compaction = input.state.compaction ?? { failures: 0, summaries: [], events: [] };
  input.state.compaction = compaction;

  if (compaction.failures >= maxCompactFailures) {
    return { compacted: false, reason: "circuit_breaker", currentTokens, policy };
  }
  if (!input.force && currentTokens < policy.autoCompactThresholdTokens) {
    return { compacted: false, reason: "below_threshold", currentTokens, policy };
  }

  const compactableSteps = input.steps.filter((step) => (
    compaction.lastCompactedStep === undefined || step.step > compaction.lastCompactedStep
  ));
  const compactUntil = Math.max(0, compactableSteps.length - keepRecentSteps);
  const stepsToSummarize = compactableSteps.slice(0, compactUntil);
  const recentSteps = input.steps.slice(-keepRecentSteps);
  if (!stepsToSummarize.length) {
    return { compacted: false, reason: "not_enough_steps", currentTokens, policy };
  }

  try {
    const completion = await runAiCompletion(
      input.config,
      compactPrompt({
        taskPrompt: input.taskPrompt,
        previousSummaries: compaction.summaries,
        stepsToSummarize
      }),
      "你是上下文压缩器。只能输出纯文本摘要，禁止调用任何工具。",
      Math.min(12_000, policy.reservedOutputTokens),
      { disableTools: true }
    );
    const summary = formatCompactSummary(completion.text);
    compaction.summaries = [...compaction.summaries, summary].slice(-4);
    compaction.failures = 0;
    const lastCompactedStep = stepsToSummarize.at(-1)?.step;
    if (lastCompactedStep !== undefined) compaction.lastCompactedStep = lastCompactedStep;

    const nextPrompt = continuationPrompt({
      taskPrompt: input.taskPrompt,
      summaries: compaction.summaries,
      recentSteps
    });
    resetState(input.state, nextPrompt);

    const event = {
      ts: nowIso(),
      model: input.config.model,
      provider: input.config.provider,
      trigger: input.force ? "reactive" : "auto",
      pre_tokens_estimate: currentTokens,
      post_tokens_estimate: estimateStateTokens(input.config, input.state),
      window_tokens: policy.windowTokens,
      threshold_tokens: policy.autoCompactThresholdTokens,
      summarized_steps: stepsToSummarize.length,
      kept_steps: recentSteps.length,
      summary_tokens_estimate: estimateTokens(summary),
      usage: completion.usage
    };
    compaction.events.push(event);
    return { compacted: true, event, currentTokens, policy };
  } catch (error) {
    compaction.failures += 1;
    return {
      compacted: false,
      reason: "compact_failed",
      error: error instanceof Error ? error.message : String(error),
      currentTokens,
      policy
    };
  }
}
