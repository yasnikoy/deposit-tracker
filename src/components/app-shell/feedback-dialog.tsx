"use client";

import { usePathname } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { submitFeedbackAction } from "@/app/(app)/feedback-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";

/** A bug report or feature request to the admins, with the page it was sent from. */
export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const page = usePathname();
  const [kind, setKind] = useState<"BUG" | "IDEA">("BUG");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const result = await submitFeedbackAction({ kind, body, page });
    setBusy(false);
    if (!result.ok) return setError(t(result.error, result.params));
    toast.success(t("feedback.sent"));
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={send} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("feedback.title")}</DialogTitle>
            <DialogDescription>{t("feedback.hint")}</DialogDescription>
          </DialogHeader>
          <fieldset className="flex gap-4 text-sm">
            <legend className="sr-only">{t("feedback.kind")}</legend>
            {(["BUG", "IDEA"] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="radio" name="feedback-kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
                {t(`feedback.kinds.${k}`)}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="feedback-body">{t("feedback.body")}</Label>
            <textarea
              id="feedback-body"
              rows={5}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={t(kind === "BUG" ? "feedback.bugPlaceholder" : "feedback.ideaPlaceholder")}
              className="border-input bg-background rounded-md border px-2 py-1 text-sm"
              autoFocus
            />
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || body.trim() === ""}>
              {t("feedback.send")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
