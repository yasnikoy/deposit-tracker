"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { t, type TranslationKey, type TranslationParams } from "@/i18n";

type DeleteResult = { ok: true } | { ok: false; error: TranslationKey; params?: TranslationParams };

/**
 * Deletes an agency or customer no record names (admin). The server refuses one in use and
 * says what names it; such a record is deactivated instead.
 */
export function DeleteRecord({ name, onDelete, onDeleted }: { name: string; onDelete: (reason: string) => Promise<DeleteResult>; onDeleted: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center justify-between gap-4 border-t pt-4">
      <p className="text-muted-foreground text-xs">{t("recordDelete.hint")}</p>
      <Button type="button" variant="outline" size="sm" className="text-destructive shrink-0" onClick={() => setOpen(true)}>
        <Trash2 /> {t("recordDelete.button")}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t("recordDelete.confirmTitle", { name })}
        description={t("recordDelete.confirmDescription")}
        confirmLabel={t("common.delete")}
        destructive
        requireReason
        onConfirm={async (reason) => {
          const result = await onDelete(reason);
          if (!result.ok) return void toast.error(t(result.error, result.params));
          toast.success(t("recordDelete.deleted", { name }));
          setOpen(false);
          onDeleted();
          router.refresh();
        }}
      />
    </div>
  );
}
