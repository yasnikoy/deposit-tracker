"use client";

import { useState } from "react";
import { toastWithUndo } from "@/components/undo-toast";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseContainerList } from "@/domain/containers";
import type { BlStatus } from "@/domain/records";
import { t } from "@/i18n";
import { updateBlAction, voidBlAction } from "./actions";

export type EditableBl = { id: number; blNo: string; containers: string[]; status: BlStatus };

/** B/L number (until the first request) and containers; every change goes through updateBlAction. */
export function EditBlDialog({ bl, onCancel, onSaved }: { bl: EditableBl; onCancel: () => void; onSaved: () => void }) {
  const [blNo, setBlNo] = useState(bl.blNo);
  const [containers, setContainers] = useState(bl.containers.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const result = await updateBlAction({ id: bl.id, blNo, containers: parseContainerList(containers) });
    setBusy(false);
    if (!result.ok) {
      const field = result.fieldErrors ? Object.values(result.fieldErrors)[0] : undefined;
      return setError(t(field ?? result.error, result.params));
    }
    toastWithUndo(t("bls.updated"), result.data, onSaved);
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("bls.edit")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-bl-no">{t("bls.blNo")}</Label>
            <Input
              id="edit-bl-no"
              className="font-mono uppercase"
              value={blNo}
              onChange={(event) => setBlNo(event.target.value)}
              disabled={bl.status !== "PAID" && bl.status !== "DUE"}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-containers">{t("bls.containers")}</Label>
            <textarea
              id="edit-containers"
              rows={3}
              value={containers}
              onChange={(event) => setContainers(event.target.value)}
              className="border-input bg-background rounded-md border px-2 py-1 font-mono text-xs uppercase"
            />
            <p className="text-muted-foreground text-xs">{t("bls.containersHint")}</p>
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={busy}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function VoidBlDialog({ bl, onCancel, onVoided }: { bl: { id: number; blNo: string }; onCancel: () => void; onVoided: () => void }) {
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onCancel()}
      title={t("bls.void")}
      description={t("bls.voidText", { bl: bl.blNo })}
      confirmLabel={t("bls.void")}
      destructive
      requireReason
      onConfirm={async (reason) => {
        const result = await voidBlAction({ id: bl.id, reason });
        if (!result.ok) return void toast.error(t(result.error, result.params));
        toast.success(t("bls.voided"));
        onVoided();
      }}
    />
  );
}
