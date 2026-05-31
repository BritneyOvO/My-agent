import path from "node:path";
import { env } from "./env.js";
import { HttpError } from "./http.js";

const taskIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function tasksDir() {
  return path.resolve(env.dataDir, "tasks");
}

export function validateTaskId(taskId: string) {
  if (!taskIdPattern.test(taskId)) {
    throw new HttpError(400, "taskId must be a UUID");
  }
  return taskId;
}

export function taskFilePath(taskId: string) {
  const safeTaskId = validateTaskId(taskId);
  const baseDir = tasksDir();
  const filePath = path.resolve(baseDir, `${safeTaskId}.json`);

  if (!filePath.startsWith(`${baseDir}${path.sep}`)) {
    throw new HttpError(400, "task path escapes tasks directory");
  }

  return filePath;
}
