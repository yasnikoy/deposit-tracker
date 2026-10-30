"use client";

import { toast } from "sonner";
import { undoAction } from "@/app/(app)/undo-actions";
import { t } from "@/i18n";

/** How long the toast's undo button stays; the B/L timeline offers undo for the rest of the window. */
const UNDO_TOAST_MS = 10_000;

/** A success message with a "Geri al" button that undoes the action's audit rows (rule 17). */
export function toastWithUndo(message: string, auditIds: number[], onUndone: () => void) {
  if (auditIds.length === 0) return void toast.success(message);
  toast.success(message, {
    duration: UNDO_TOAST_MS,
    action: {
      label: t("undo.action"),
      onClick: async () => {
        const result = await undoAction({ auditIds });
        if (!result.ok) return void toast.error(t(result.error, result.params));
        toast.success(t("undo.done"));
        onUndone();
      },
    },
  });
}
