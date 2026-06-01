import { EventEmitter } from "node:events";

export type TaskEvent = {
  id: string;
  task_id: string;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
};

const bus = new EventEmitter();
let sequence = 0;

export function compactTaskForEvent(task: unknown) {
  if (!task || typeof task !== "object" || Array.isArray(task)) return task;
  const record = task as Record<string, unknown>;
  const result = record.result && typeof record.result === "object" && !Array.isArray(record.result)
    ? record.result as Record<string, unknown>
    : null;
  if (!result) return record;
  const {
    raw_response: _rawResponse,
    raw_responses: _rawResponses,
    raw_tool_request_response: _rawToolRequestResponse,
    native_tool_loop: _nativeToolLoop,
    ...compactResult
  } = result;
  return { ...record, result: compactResult };
}

function nextEventId(taskId: string) {
  sequence += 1;
  return `${Date.now()}-${sequence}-${taskId}`;
}

export function publishTaskEvent(taskId: string, type: string, payload: Record<string, unknown> = {}) {
  const compactPayload = "task" in payload ? { ...payload, task: compactTaskForEvent(payload.task) } : payload;
  const event: TaskEvent = {
    id: nextEventId(taskId),
    task_id: taskId,
    type,
    ts: new Date().toISOString(),
    payload: compactPayload
  };
  bus.emit(taskId, event);
  bus.emit("*", event);
  return event;
}

export function subscribeTaskEvents(taskId: string, listener: (event: TaskEvent) => void) {
  bus.on(taskId, listener);
  return () => {
    bus.off(taskId, listener);
  };
}
