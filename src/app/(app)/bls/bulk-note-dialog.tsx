"use client";

import { useState } from "react";
import { toastWithUndo } from "@/components/undo-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { addNotesAction } from "./actions";
import { NoteEditor, type MentionableUser } from "./note-editor";

/** One note on several B/Ls; the dialog lists the affected B/Ls before it is added (rule 11). */
export function BulkNoteDialog({ bls, users, onClose, onDone }: { bls: { id: number; blNo: string }[]; users: MentionableUser[]; onClose: () => void; onDone: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    const result = await addNotesAction({ blIds: bls.map((b) => b.id), body });
    setBusy(false);
    if (!result.ok) {
      const field = result.fieldErrors ? Object.values(result.fieldErrors)[0] : undefined;
      return setError(t(field ?? result.error, result.params));
    }
    toastWithUndo(t("notes.savedBulk", { count: bls.length }), result.data, onDone);
    onDone();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("notes.bulkTitle")}</DialogTitle>
          <DialogDescription>{t("notes.bulkConfirm", { count: bls.length })}</DialogDescription>
        </DialogHeader>
        <ul className="max-h-32 overflow-auto font-mono text-xs" data-testid="bulk-note-bls">
          {bls.map((b) => (
            <li key={b.id}>{b.blNo}</li>
          ))}
        </ul>
        <NoteEditor id="bulk-note-body" value={body} onChange={setBody} users={users} />
        {error && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={add} disabled={busy || body.trim() === ""}>
            {t("notes.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
