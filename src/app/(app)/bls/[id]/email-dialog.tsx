"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DetailDialog } from "@/components/detail-dialog";
import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";
import { formatTimestamp } from "@/lib/format";
import type { EmailDetail } from "@/server/replies";
import { emailDetailAction } from "../actions";

/**
 * One email of a B/L opened in place: as sent, or as archived from Outlook. *Outlook'ta aç*
 * downloads the original file; opened in Outlook, a reply continues the same conversation.
 */
export function EmailDialog({ emailId, onClose }: { emailId: number; onClose: () => void }) {
  const [detail, setDetail] = useState<EmailDetail | null>(null);

  useEffect(() => {
    let live = true;
    emailDetailAction({ emailId }).then((result) => {
      if (!live) return;
      if (!result.ok) {
        toast.error(t(result.error, result.params));
        return onClose();
      }
      setDetail(result.data);
    });
    return () => {
      live = false;
    };
  }, [emailId, onClose]);

  if (!detail) {
    return (
      <DetailDialog title={t("common.loading")} navigation={null} onClose={onClose}>
        <p className="text-muted-foreground">{t("common.loading")}</p>
      </DetailDialog>
    );
  }
  const { email, attachments, blNos } = detail;
  const at = email.direction === "OUT" ? email.sentAt : email.receivedAt;
  return (
    <DetailDialog title={email.subject || t("replies.noSubject")} navigation={null} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
          <dt className="text-muted-foreground">{t("replies.from")}</dt>
          <dd className="break-all">{email.fromAddress}</dd>
          <dt className="text-muted-foreground">{t("replies.to")}</dt>
          <dd className="break-all">{email.to.join("; ")}</dd>
          {email.cc.length > 0 && (
            <>
              <dt className="text-muted-foreground">{t("replies.cc")}</dt>
              <dd className="break-all">{email.cc.join("; ")}</dd>
            </>
          )}
          <dt className="text-muted-foreground">{t(email.direction === "OUT" ? "replies.sentAt" : "replies.date")}</dt>
          <dd>
            {at ? formatTimestamp(at) : ""}
            {email.dryRun && (
              <Badge variant="secondary" className="ml-2">
                {t("timeline.notes.dryRun")}
              </Badge>
            )}
          </dd>
          {email.agencyName && (
            <>
              <dt className="text-muted-foreground">{t("replies.agency")}</dt>
              <dd>{email.agencyName}</dd>
            </>
          )}
          {blNos.length > 0 && (
            <>
              <dt className="text-muted-foreground">{t("replies.bls")}</dt>
              <dd className="font-mono">{blNos.join(", ")}</dd>
            </>
          )}
        </dl>

        {(attachments.length > 0 || email.rawDocumentId) && (
          <section className="flex flex-col gap-1">
            <h3 className="font-medium">{t("replies.attachments")}</h3>
            <ul className="flex flex-col gap-1 text-sm">
              {attachments.map((a) => (
                <li key={a.documentId}>
                  <a href={`/api/files/${a.documentId}`} target="_blank" rel="noreferrer" className="underline">
                    {a.originalName}
                  </a>
                </li>
              ))}
              {email.rawDocumentId && (
                <li>
                  <a href={`/api/files/${email.rawDocumentId}`} className="underline">
                    {t("archive.openInOutlook")}
                  </a>
                </li>
              )}
            </ul>
          </section>
        )}

        <section className="flex flex-col gap-1">
          <h3 className="font-medium">{t("replies.message")}</h3>
          <pre className="bg-muted max-h-[32rem] overflow-auto rounded-md p-3 font-sans text-sm whitespace-pre-wrap">{email.bodyText || t("replies.noText")}</pre>
        </section>
      </div>
    </DetailDialog>
  );
}
