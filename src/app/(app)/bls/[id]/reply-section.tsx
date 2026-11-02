"use client";

import { ArrowDownLeft, ArrowUpRight, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState, type FormEvent } from "react";
import { toastWithUndo } from "@/components/undo-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { formatBusinessDate, formatTimestamp } from "@/lib/format";
import type { BlDetail } from "@/server/bl-overview";
import type { MailboxSearchResult } from "@/server/replies";
import { linkMailboxMessageAction, recordReplyWithoutEmailAction, searchMailboxAction } from "../../replies/actions";
import { EmailDialog } from "../../replies/email-dialog";
import type { ReplyTypeOption } from "../../replies/replies-screen";
import type { DeductionTypeOption } from "../deduction-dialog";

/** The B/L's email thread and recorded replies, with the two ways to add one by hand. */
export function ReplySection({
  blId,
  detail,
  replyTypes,
  deductionTypes,
  today,
  canView,
  canRecord,
  canLink,
  canRecordDeduction,
}: {
  blId: number;
  detail: Pick<BlDetail, "emails" | "replies">;
  replyTypes: ReplyTypeOption[];
  deductionTypes: DeductionTypeOption[];
  today: string;
  canView: boolean;
  canRecord: boolean;
  canLink: boolean;
  canRecordDeduction: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"record" | "link" | null>(null);
  // An email opened in place, so the user stays on the B/L.
  const [openEmail, setOpenEmail] = useState<number | null>(null);
  const closeEmail = useCallback(() => setOpenEmail(null), []);
  const done = () => {
    setDialog(null);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      {(canRecord || canLink) && (
        <div className="flex flex-wrap gap-2">
          {canRecord && (
            <Button id="record-reply" size="sm" variant="outline" onClick={() => setDialog("record")}>
              {t("blReplies.record")}
            </Button>
          )}
          {canLink && (
            <Button size="sm" variant="outline" onClick={() => setDialog("link")}>
              <Search /> {t("blReplies.linkFromMailbox")}
            </Button>
          )}
        </div>
      )}

      <div>
        <h3 className="text-muted-foreground mb-1 text-xs font-medium uppercase">{t("blReplies.emails")}</h3>
        {detail.emails.length === 0 ? (
          <p className="text-muted-foreground">{t("blReplies.noEmails")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {detail.emails.map((email) => (
              <li key={email.id} className="flex flex-col">
                <span className="flex items-center gap-1.5">
                  {email.direction === "OUT" ? (
                    <ArrowUpRight className="size-4 text-sky-700" aria-label={t("blReplies.sent")} />
                  ) : (
                    <ArrowDownLeft className="size-4 text-emerald-700" aria-label={t("blReplies.received")} />
                  )}
                  {canView ? (
                    <button type="button" className="text-left underline" onClick={() => setOpenEmail(email.id)}>
                      {email.subject || t("replies.noSubject")}
                    </button>
                  ) : (
                    <span>{email.subject || t("replies.noSubject")}</span>
                  )}
                  {email.dryRun && <Badge variant="secondary">{t("timeline.notes.dryRun")}</Badge>}
                </span>
                <span className="text-muted-foreground ml-6 text-xs">
                  {formatTimestamp(email.at)} · {email.from}
                </span>
                {email.attachments.length > 0 && (
                  <span className="ml-6 flex flex-wrap gap-x-3 text-xs">
                    {email.attachments.map((a) => (
                      <a key={a.id} href={`/api/files/${a.id}`} target="_blank" rel="noreferrer" className="underline">
                        {a.originalName}
                      </a>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="text-muted-foreground mb-1 text-xs font-medium uppercase">{t("blReplies.replies")}</h3>
        {detail.replies.length === 0 ? (
          <p className="text-muted-foreground">{t("blReplies.noReplies")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {detail.replies.map((reply) => (
              <li key={reply.id} className={reply.undone ? "text-muted-foreground line-through" : undefined} title={reply.undone ? t("undo.undone") : undefined}>
                <span className="font-medium">{reply.typeName}</span> · {formatBusinessDate(reply.repliedOn)}
                <span className="text-muted-foreground text-xs">
                  {" "}
                  · {reply.byName} · {reply.emailId ? t("blReplies.byEmail") : t("blReplies.withoutEmail")}
                </span>
                {reply.note && <div className="text-xs italic">{reply.note}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {dialog === "record" && <RecordReplyDialog blId={blId} replyTypes={replyTypes} today={today} onCancel={() => setDialog(null)} onDone={done} />}
      {dialog === "link" && <MailboxLinkDialog blId={blId} onCancel={() => setDialog(null)} onDone={done} />}
      {openEmail !== null && (
        <EmailDialog
          emailId={openEmail}
          replyTypes={replyTypes}
          deductionTypes={deductionTypes}
          canRecord={canRecord}
          canLink={canLink}
          canRecordDeduction={canRecordDeduction}
          onClose={closeEmail}
        />
      )}
    </div>
  );
}

/**
 * A reply that did not come by email (e.g. read on the agency portal); it counts like one.
 * Date and note first, then one click on the reply type saves it, as on the Replies screen.
 */
function RecordReplyDialog({
  blId,
  replyTypes,
  today,
  onCancel,
  onDone,
}: {
  blId: number;
  replyTypes: ReplyTypeOption[];
  today: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [repliedOn, setRepliedOn] = useState(today);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (replyTypeId: number) => {
    setBusy(true);
    const result = await recordReplyWithoutEmailAction({ blId, replyTypeId, repliedOn, note });
    setBusy(false);
    if (!result.ok) return setError(t(result.error, result.params));
    toastWithUndo(t("blReplies.recorded"), result.data, onDone);
    onDone();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <div className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("blReplies.record")}</DialogTitle>
            <DialogDescription>{t("blReplies.recordHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reply-date">{t("blReplies.date")}</Label>
            <Input id="reply-date" type="date" value={repliedOn} max={today} onChange={(event) => setRepliedOn(event.target.value)} className="w-44" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reply-note">{t("blReplies.note")}</Label>
            <textarea
              id="reply-note"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t("blReplies.notePlaceholder")}
              className="border-input bg-background rounded-md border px-2 py-1 text-sm"
            />
          </div>
          <div role="group" aria-labelledby="reply-types" className="flex flex-col gap-1.5">
            <span id="reply-types" className="text-sm font-medium">
              {t("blReplies.type")} <span className="text-muted-foreground font-normal">{t("blReplies.typeSaves")}</span>
            </span>
            <div className="flex flex-wrap gap-2">
              {replyTypes.map((type) => (
                <Button key={type.id} type="button" variant="outline" size="sm" disabled={busy} onClick={() => save(type.id)}>
                  {type.name}
                </Button>
              ))}
            </div>
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
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Searches the shared mailbox by sender and subject and links the chosen message to the B/L. */
function MailboxLinkDialog({ blId, onCancel, onDone }: { blId: number; onCancel: () => void; onDone: () => void }) {
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("");
  const [found, setFound] = useState<{ uidValidity: string; results: MailboxSearchResult[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await searchMailboxAction({ blId, from, subject });
    setBusy(false);
    if (!result.ok) return setError(t(result.error, result.params));
    setFound(result.data);
  };

  const link = async (uid: number) => {
    if (!found) return;
    setBusy(true);
    const result = await linkMailboxMessageAction({ blId, uid, uidValidity: found.uidValidity });
    setBusy(false);
    if (!result.ok) return setError(t(result.error, result.params));
    toastWithUndo(t("replies.linked"), result.data, onDone);
    onDone();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("blReplies.linkFromMailbox")}</DialogTitle>
          <DialogDescription>{t("blReplies.linkHint")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={search} className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mailbox-from">{t("replies.from")}</Label>
            <Input id="mailbox-from" value={from} onChange={(event) => setFrom(event.target.value)} autoFocus className="w-56" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mailbox-subject">{t("replies.subject")}</Label>
            <Input id="mailbox-subject" value={subject} onChange={(event) => setSubject(event.target.value)} className="w-56" />
          </div>
          <Button type="submit" disabled={busy}>
            <Search /> {t("blReplies.search")}
          </Button>
        </form>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {found &&
          (found.results.length === 0 ? (
            <p className="text-muted-foreground">{t("blReplies.noResults")}</p>
          ) : (
            <ul className="flex max-h-80 flex-col gap-1 overflow-auto">
              {found.results.map((r) => (
                <li key={r.uid} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{r.subject || t("replies.noSubject")}</span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {formatTimestamp(r.receivedAt)} · {r.from}
                    </span>
                  </span>
                  {r.linked ? (
                    <Badge variant="secondary">{t("blReplies.alreadyLinked")}</Badge>
                  ) : (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => link(r.uid)}>
                      {t("replies.accept")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ))}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
