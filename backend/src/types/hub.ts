import { z } from "zod";

export const channels = ["default", "ctf", "pentest", "handoff", "dev", "audit"] as const;

export const hubMessageSchema = z.object({
  channel: z.enum(channels).default("default"),
  message: z.string().min(1).max(12000),
  metadata: z.record(z.unknown()).default({})
});

export type HubMessageInput = z.infer<typeof hubMessageSchema>;
