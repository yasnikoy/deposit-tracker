"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { appendBlDescriptionAction } from "./actions";

/** Adds one line to the description of the selected B/Ls, after listing them (rule 11). */
export function BulkDescriptionDialog({ bls, onClose, onDone }: { bls: { id: number; blNo: string }[]; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const result = await appendBlDescriptionAction({ blIds: bls.map((b) => b.id), text });
    setBusy(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));
    toast.success(t("description.bulkSaved", { count: result.data }));
    onDone();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("description.bulkTitle")}</DialogTitle>
          <DialogDescription>{t("description.bulkConfirm", { count: bls.length })}</DialogDescription>
        </DialogHeader>
        <ul className="max-h-32 overflow-auto font-mono text-xs">
          {bls.map((b) => (
            <li key={b.id}>{b.blNo}</li>
          ))}
        </ul>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bulk-description">{t("description.bulkText")}</Label>
          <textarea
            id="bulk-description"
            rows={3}
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="border-input bg-background rounded-md border px-2 py-1.5 text-sm"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={busy || text.trim() === ""}>
            {t("description.bulk")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
