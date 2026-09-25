import { z } from 'zod';

export const ModeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  teams: z.number().int().min(1),
  playersPerTeam: z.number().int().min(1),
  timeLimitSeconds: z.number().int().positive(),
  scoreLimit: z.number().int().positive(),
});

export type Mode = z.infer<typeof ModeSchema>;
