"use client";

import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { toastWithUndo } from "@/components/undo-toast";
import { parseContainerList } from "@/domain/containers";
import { t } from "@/i18n";
import { updateBlAction } from "../actions";
import { containerWarnings } from "../bl-warnings";

/** The B/L's containers, the only place they are entered; changed in place like the customer (audited, undoable). */
export function ContainersField({ blId, containers, editable }: { blId: number; containers: string[]; editable: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(containers.join(", "));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const result = await updateBlAction({ id: blId, containers: parseContainerList(text) });
    setBusy(false);
    if (!result.ok) {
      const field = result.fieldErrors ? Object.values(result.fieldErrors)[0] : undefined;
      return void toast.error(t(field ?? result.error, result.params));
    }
    toastWithUndo(t("bls.updated"), result.data, () => router.refresh());
    setEditing(false);
    router.refresh();
  };

  if (!editing) {
    return (
      <span className="flex items-center gap-2">
        <span className="font-mono text-xs">{containers.length ? containers.join(", ") : <span className="text-muted-foreground font-sans text-sm">{t("bls.noContainers")}</span>}</span>
        {editable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5"
            aria-label={t("bls.containersEdit")}
            title={t("bls.containersEdit")}
            onClick={() => {
              setText(containers.join(", "));
              setEditing(true);
            }}
          >
            <Pencil className="size-3.5" />
          </Button>
        )}
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1.5">
      <textarea
        aria-label={t("bls.containers")}
        rows={2}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="border-input bg-background rounded-md border px-2 py-1 font-mono text-xs uppercase"
        autoFocus
      />
      <span className="text-muted-foreground text-xs">{t("bls.containersHint")}</span>
      {containerWarnings(text).map((warning) => (
        <span key={warning} className="text-xs text-amber-700 dark:text-amber-400">
          {warning}
        </span>
      ))}
      <span className="flex gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={save}>
          {t("common.save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
          {t("common.cancel")}
        </Button>
      </span>
    </span>
  );
}
