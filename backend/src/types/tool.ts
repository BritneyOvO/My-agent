import { z } from "zod";

export const toolRunRequestSchema = z.object({
  tool: z.string().min(1).max(80),
  mode: z.string().min(1).max(120).default("local_lab"),
  target: z.string().min(1).max(4000).optional(),
  artifact_path: z.string().min(1).max(260).optional(),
  args: z.array(z.string().max(500)).max(8).default([])
});

export type ToolRunRequest = z.infer<typeof toolRunRequestSchema>;
