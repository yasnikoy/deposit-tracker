"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { holdBlAction } from "../actions";

/** Beklemeye al: a reason from the list, an optional review date and note. */
export function HoldDialog({
  blId,
  reasons,
  today,
  onCancel,
  onDone,
}: {
  blId: number;
  reasons: { id: number; name: string }[];
  today: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [reasonId, setReasonId] = useState<number | null>(null);
  const [until, setUntil] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (reasonId === null) return setError(t("holds.errors.reason"));
    setBusy(true);
    const result = await holdBlAction({ blId, reasonId, until: until || null, note });
    setBusy(false);
    if (!result.ok) return setError(t(result.error, result.params));
    toast.success(t("holds.saved"));
    onDone();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("holds.title")}</DialogTitle>
            <DialogDescription>{t("holds.hint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="hold-reason">{t("holds.reason")}</Label>
            <select
              id="hold-reason"
              className="border-input bg-background h-9 rounded-md border px-2"
              value={reasonId ?? ""}
              onChange={(e) => setReasonId(e.target.value ? Number(e.target.value) : null)}
              autoFocus
            >
              <option value="">{t("holds.reasonPick")}</option>
              {reasons.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="hold-until">
              {t("holds.until")} <span className="text-muted-foreground font-normal">{t("holds.untilHint")}</span>
            </Label>
            <Input id="hold-until" type="date" min={today} value={until} onChange={(e) => setUntil(e.target.value)} className="w-44" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="hold-note">
              {t("holds.note")} <span className="text-muted-foreground font-normal">{t("common.optional")}</span>
            </Label>
            <textarea
              id="hold-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="border-input bg-background rounded-md border px-2 py-1 text-sm"
            />
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {t("holds.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
