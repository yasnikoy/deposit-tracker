"use client";

import { ArrowDownLeft, ArrowUpRight, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { FileDrop, uploadErrorText } from "@/components/file-drop";
import { toastWithUndo } from "@/components/undo-toast";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { formatBusinessDate, formatTimestamp } from "@/lib/format";
import type { ReplyTypeCode } from "@/domain/replies";
import type { BlDetail } from "@/server/bl-overview";
import { RecordReplyDialog, RecordRequestDialog } from "../bl-work-dialogs";
import { EmailDialog } from "./email-dialog";
import { prepareResendAction, type ResendDraft } from "../../requests/actions";
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
              blIds={[blId]}
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

      {dialog === "record" && <RecordReplyDialog bls={[{ id: blId }]} replyTypes={replyTypes} today={today} onCancel={() => setDialog(null)} onDone={done} />}
      {dialog === "request" && <RecordRequestDialog bls={[{ id: blId }]} today={today} onCancel={() => setDialog(null)} onDone={done} />}
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
