"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { updateBlDescriptionAction } from "./actions";

/**
 * The B/L description ("Açıklama"): one free text, saved as a whole. The text the user started
 * from goes along, so a change someone else saved meanwhile is not overwritten silently.
 */
export function DescriptionEditor({ blId, description, editable, id = "bl-description" }: { blId: number; description: string | null; editable: boolean; id?: string }) {
  const router = useRouter();
  const [text, setText] = useState(description ?? "");
  // The saved text this edit started from; follows the server after a refresh.
  const [base, setBase] = useState(description);
  const [busy, setBusy] = useState(false);
  // After a refused save, the next server text becomes the base while the user's text stays.
  const [rebase, setRebase] = useState(false);
  // An untouched editor follows the server. Unsaved typing keeps its old base, so saving it
  // over a newer text is refused (and then, after the refresh, allowed on purpose).
  if (base !== description && (rebase || text === (base ?? ""))) {
    if (rebase) setRebase(false);
    else setText(description ?? "");
    setBase(description);
  }
  const dirty = text.trim() !== (base ?? "").trim();

  if (!editable) {
    return description ? <p className="text-sm whitespace-pre-wrap">{description}</p> : <p className="text-muted-foreground text-sm">{t("description.empty")}</p>;
  }

  const save = async () => {
    setBusy(true);
    const result = await updateBlDescriptionAction({ blId, description: text, previous: base });
    setBusy(false);
    if (!result.ok) {
      toast.error(t(result.error, result.params));
      if (result.error === "description.errors.changed") {
        // Keep the user's text; once the current text arrives, the next save replaces it.
        setRebase(true);
        router.refresh();
      }
      return;
    }
    toast.success(t("description.saved"));
    setBase(text.trim() || null);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-2">
      <textarea
        id={id}
        aria-label={t("description.label")}
        rows={Math.min(12, Math.max(3, text.split("\n").length + 1))}
        value={text}
        placeholder={t("description.placeholder")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && dirty) {
            event.preventDefault();
            void save();
          }
        }}
        className="border-input bg-background rounded-md border px-2 py-1.5 text-sm"
      />
      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={!dirty || busy}>
          {t("description.save")}
        </Button>
      </div>
    </div>
  );
}
