"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/i18n";

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Affected records, listed so the user sees exactly what the action touches. */
  items?: string[];
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<void> | void;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  items,
  confirmLabel,
  destructive,
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {items && items.length > 0 && (
          <ul className="bg-muted max-h-60 overflow-auto rounded-md px-4 py-2 text-sm">
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={confirm} disabled={busy} autoFocus>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
