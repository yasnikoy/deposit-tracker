import { isTranslationKey, t, type TranslationParams } from "@/i18n";

/** Renders a validation or action message that is a translation key. */
export function FieldMessage({ message, params }: { message?: string; params?: TranslationParams }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-destructive text-xs">
      {isTranslationKey(message) ? t(message, params) : t("errors.validation")}
    </p>
  );
}
