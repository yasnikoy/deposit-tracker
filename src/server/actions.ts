import "server-only";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { isTranslationKey, type TranslationKey } from "@/i18n";
import { DomainError, type ActionResult } from "./errors";
import { logger } from "./logger";

/** Turns zod issues into per-field translation keys (first issue per field wins). */
export function fieldErrors(error: z.ZodError): Record<string, TranslationKey> {
  const result: Record<string, TranslationKey> = {};
  for (const issue of error.issues) {
    const field = issue.path.join(".") || "_";
    if (!(field in result)) result[field] = isTranslationKey(issue.message) ? issue.message : "errors.validation";
  }
  return result;
}

/**
 * Wraps a server function body: validates input with the shared zod schema and
 * maps domain errors to translated messages. Unexpected errors are logged, never leaked.
 */
export async function runAction<S extends z.ZodType, T>(
  schema: S,
  input: unknown,
  body: (data: z.infer<S>) => Promise<T> | T,
): Promise<ActionResult<T>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    // Paths and codes only: input values may contain passwords.
    logger.warn({ issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })) }, "invalid action input");
    return { ok: false, error: "errors.validation", fieldErrors: fieldErrors(parsed.error) };
  }
  try {
    return { ok: true, data: await body(parsed.data) };
  } catch (error) {
    if (error instanceof DomainError) return { ok: false, error: error.messageKey, params: error.params };
    // redirect() and notFound() work by throwing; let Next.js handle them.
    unstable_rethrow(error);
    logger.error({ err: error }, "server action failed");
    return { ok: false, error: "errors.unexpected" };
  }
}
