import type { Request, Response } from "express";
import type { z } from "zod";

/**
 * Checks req.body against a Zod schema. Returns the parsed body, or answers
 * 400 and returns null: with `message` when given, else with the message of
 * the first problem found (each schema writes its own, see routes/).
 */
export function parseBody<T extends z.ZodType>(schema: T, req: Request, res: Response, message?: string): z.infer<T> | null {
  const result = schema.safeParse(req.body ?? {});
  if (result.success) return result.data;
  res.status(400).json({ error: message ?? result.error.issues[0].message });
  return null;
}
