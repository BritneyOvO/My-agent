import { z } from "zod";

export const validModes = [
  "ctf_challenge",
  "local_lab",
  "owned_asset_authorized_test",
  "code_review",
  "log_analysis",
  "report_generation",
  "safe_explanation"
] as const;

export const taskStatuses = [
  "pending",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "blocked"
] as const;

export const taskRequestSchema = z.object({
  mode: z.enum(validModes).default("ctf_challenge"),
  prompt: z.string().min(1).max(8000),
  target: z.string().min(1).max(4000).optional(),
  owner: z.string().min(1).max(120).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  tags: z.array(z.string().min(1).max(80)).max(100).default([])
});

export const taskStatusUpdateSchema = z.object({
  status: z.enum(taskStatuses),
  comment: z.string().min(1).max(4000).optional()
});

export const taskCommentSchema = z.object({
  text: z.string().min(1).max(4000)
});

export type TaskRequest = z.infer<typeof taskRequestSchema>;
export type TaskStatusUpdate = z.infer<typeof taskStatusUpdateSchema>;
export type TaskComment = z.infer<typeof taskCommentSchema>;
