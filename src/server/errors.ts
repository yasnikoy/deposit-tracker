import type { TranslationKey, TranslationParams } from "@/i18n";

/** A rule violation the user can act on; `messageKey` is shown via t(). */
export class DomainError extends Error {
  constructor(
    public readonly messageKey: TranslationKey,
    public readonly params?: TranslationParams,
  ) {
    super(messageKey);
    this.name = "DomainError";
  }
}

export class ForbiddenError extends DomainError {
  constructor() {
    super("errors.forbidden");
    this.name = "ForbiddenError";
  }
}

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: TranslationKey;
      params?: TranslationParams;
      fieldErrors?: Record<string, TranslationKey>;
    };
