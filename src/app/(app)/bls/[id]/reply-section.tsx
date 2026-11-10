"use client";

import { ArrowDownLeft, ArrowUpRight, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState, type FormEvent } from "react";
import { FileDrop, uploadErrorText } from "@/components/file-drop";
import { toastWithUndo } from "@/components/undo-toast";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { formatBusinessDate, formatTimestamp } from "@/lib/format";
import type { ReplyTypeCode } from "@/domain/replies";
import type { BlDetail } from "@/server/bl-overview";
import { recordReplyWithoutEmailAction } from "../actions";
import { EmailDialog } from "./email-dialog";
import { prepareResendAction, recordOutsideRequestAction, type ResendDraft } from "../../requests/actions";
import { ResendDialog } from "../../requests/email-preview-dialog";

export type ReplyTypeOption = { id: number; name: string; code: ReplyTypeCode | null };

/**
 * The B/L's emails (our requests and the ones archived from Outlook) and its recorded replies,
 * with the ways to add them by hand: a reply, a request made outside the app, an archived email.
 */
export function ReplySection({
  blId,
  detail,
  replyTypes,
  today,
  canView,
  canRecord,
  canRecordRequest,
  canArchive,
  canResend,
}: {
  blId: number;
  detail: Pick<BlDetail, "emails" | "replies">;
  replyTypes: ReplyTypeOption[];
  today: string;
  canView: boolean;
  canRecord: boolean;
  canRecordRequest: boolean;
  canArchive: boolean;
  canResend: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"record" | "request" | null>(null);
  // An email opened in place, so the user stays on the B/L.
  const [openEmail, setOpenEmail] = useState<number | null>(null);
  const closeEmail = useCallback(() => setOpenEmail(null), []);
  const [resend, setResend] = useState<ResendDraft | null>(null);
  const startResend = async (emailId: number) => {
    const result = await prepareResendAction({ emailId });
    if (!result.ok) return void toast.error(t(result.error, result.params));
    setResend(result.data);
  };
  const done = () => {
    setDialog(null);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      {(canRecord || canRecordRequest) && (
        <div className="flex flex-wrap gap-2">
          {canRecord && (
            <Button id="record-reply" size="sm" variant="outline" onClick={() => setDialog("record")}>
              {t("blReplies.record")}
            </Button>
          )}
          {canRecordRequest && (
            <Button size="sm" variant="outline" onClick={() => setDialog("request")}>
              {t("blReplies.recordRequest")}
            </Button>
          )}
        </div>
      )}

      <div>
        <h3 className="text-muted-foreground mb-1 text-xs font-medium uppercase">{t("blReplies.emails")}</h3>
        {canArchive && (
          <div className="mb-2 flex flex-col gap-1">
            <FileDrop
              kind="EMAIL"
              blId={blId}
              multiple
              compact
              accept=".eml,.msg"
              label={t("archive.drop")}
              onUploaded={(results) => {
                const auditIds = results.flatMap((r) => (r.response.ok ? (r.response.auditIds ?? []) : []));
                for (const r of results) if (!r.response.ok) toast.error(`${r.file.name}: ${uploadErrorText(r.response)}`);
                if (auditIds.length > 0) toastWithUndo(t("archive.saved"), auditIds, () => router.refresh());
                router.refresh();
              }}
            />
            <span className="text-muted-foreground text-xs">{t("archive.hint")}</span>
          </div>
        )}
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
                  {email.resendOfEmailId !== null && <Badge variant="secondary">{t("blReplies.resent")}</Badge>}
                  {email.sendStatus === "QUEUED" && <Badge variant="secondary">{t("reports.email.statuses.QUEUED")}</Badge>}
                  {email.sendStatus === "FAILED" && <Badge variant="destructive">{t("reports.email.statuses.FAILED")}</Badge>}
                  {email.dryRun && <Badge variant="secondary">{t("timeline.notes.dryRun")}</Badge>}
                  {canResend && email.direction === "OUT" && email.sendStatus === "SENT" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-6 px-1.5"
                      aria-label={`${t("requests.resend")} – ${email.subject}`}
                      title={t("requests.resend")}
                      onClick={() => startResend(email.id)}
                    >
                      <Send className="size-3.5" />
                    </Button>
                  )}
                </span>
                <span className="text-muted-foreground ml-6 text-xs">
                  {formatTimestamp(email.at)} · {email.from}
                  {email.rawDocumentId !== null && (
                    <>
                      {" · "}
                      <a href={`/api/files/${email.rawDocumentId}`} className="underline">
                        {t("archive.openInOutlook")}
                      </a>
                    </>
                  )}
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
      {dialog === "request" && <RecordRequestDialog blId={blId} today={today} onCancel={() => setDialog(null)} onDone={done} />}
      {resend && (
        <ResendDialog
          draft={resend}
          onDone={() => {
            setResend(null);
            router.refresh();
          }}
        />
      )}
      {openEmail !== null && (
        <EmailDialog emailId={openEmail} onClose={closeEmail} />
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

/** A refund request made outside the app (by phone, another mailbox); it counts like a sent one. */
function RecordRequestDialog({ blId, today, onCancel, onDone }: { blId: number; today: string; onCancel: () => void; onDone: () => void }) {
  const [requestedOn, setRequestedOn] = useState(today);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const result = await recordOutsideRequestAction({ blId, requestedOn, note });
    setBusy(false);
    if (!result.ok) return setError(t(result.error, result.params));
    toast.success(t("blReplies.requestRecorded"));
    onDone();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("blReplies.recordRequest")}</DialogTitle>
            <DialogDescription>{t("blReplies.recordRequestHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="request-date">{t("blReplies.requestDate")}</Label>
            <Input id="request-date" type="date" value={requestedOn} max={today} onChange={(event) => setRequestedOn(event.target.value)} className="w-44" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="request-note">
              {t("blReplies.note")} <span className="text-muted-foreground font-normal">{t("common.optional")}</span>
            </Label>
            <textarea
              id="request-note"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t("blReplies.requestNotePlaceholder")}
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
              {t("blReplies.saveRequest")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
