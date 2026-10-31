"use client";

import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";

export type MentionableUser = { username: string; displayName: string };

/** A note textarea; clicking a user inserts their @username. */
export function NoteEditor({ id, value, onChange, users }: { id: string; value: string; onChange: (value: string) => void; users: MentionableUser[] }) {
  const mention = (username: string) => onChange(`${value}${value === "" || /\s$/.test(value) ? "" : " "}@${username} `);
  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        id={id}
        rows={3}
        className="border-input bg-background rounded-md border px-2 py-1 text-sm"
        placeholder={t("notes.placeholder")}
        aria-label={t("notes.add")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {users.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground text-xs">{t("notes.mentionHint")}</span>
          {users.map((user) => (
            <button key={user.username} type="button" onClick={() => mention(user.username)}>
              <Badge variant="outline" className="cursor-pointer" title={user.displayName}>
                @{user.username}
              </Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A note body with its @mentions emphasised. */
export function NoteBody({ body }: { body: string }) {
  const parts = body.split(/((?<![\p{L}\p{N}._-])@[A-Za-z0-9._-]{2,64})/u);
  return (
    <p className="text-sm whitespace-pre-wrap">
      {parts.map((part, i) => (i % 2 === 1 ? <span key={i} className="text-primary font-medium">{part}</span> : part))}
    </p>
  );
}
