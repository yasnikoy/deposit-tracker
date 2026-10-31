"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toastWithUndo } from "@/components/undo-toast";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BlNote } from "@/server/notes";
import { addNotesAction } from "../actions";
import { NoteBody, NoteEditor, type MentionableUser } from "../note-editor";

export function NotesSection({ blId, notes, canAdd, users }: { blId: number; notes: BlNote[]; canAdd: boolean; users: MentionableUser[] }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    const result = await addNotesAction({ blIds: [blId], body });
    setBusy(false);
    if (!result.ok) {
      const field = result.fieldErrors ? Object.values(result.fieldErrors)[0] : undefined;
      return setError(t(field ?? result.error, result.params));
    }
    setBody("");
    toastWithUndo(t("notes.saved"), result.data, () => router.refresh());
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      {canAdd && (
        <div className="flex flex-col gap-2">
          <NoteEditor id="note-body" value={body} onChange={setBody} users={users} />
          {error && <p className="text-destructive text-sm">{error}</p>}
          <Button size="sm" className="self-start" onClick={add} disabled={busy || body.trim() === ""}>
            {t("notes.add")}
          </Button>
        </div>
      )}
      {notes.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("notes.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="bl-notes">
          {notes.map((note) => (
            <li key={note.id} className={cn("border-l-2 pl-3", note.undone && "text-muted-foreground line-through")}>
              <div className="text-muted-foreground text-xs">
                {note.authorName} · {formatTimestamp(note.createdAt)}
                {note.undone && <span className="ml-1 no-underline">({t("notes.undone")})</span>}
              </div>
              <NoteBody body={note.body} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
