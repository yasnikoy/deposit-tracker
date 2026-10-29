"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { BlStatusBadge } from "@/components/bl-status-badge";
import { OverridesEditor } from "@/components/overrides-editor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { isTranslationKey, t } from "@/i18n";
import { formatBusinessDate, formatTimestamp } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { BlDetail } from "@/server/bl-overview";
import { BalanceStrip } from "../balance-strip";
import { EditBlDialog, VoidBlDialog } from "../bl-dialogs";
import { updateBlOverridesAction } from "../../requests/actions";
import { FormSection } from "../form-section";
import type { ReplyTypeOption } from "../../replies/replies-screen";
import { ReplySection } from "./reply-section";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-md border p-4">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const actionLabel = (action: string) => {
  const key = `timeline.actions.${action}`;
  return isTranslationKey(key) ? t(key) : action;
};

export type BlDetailPermissions = { edit: boolean; void: boolean; forms: boolean; overrides: boolean; recordReply: boolean; linkEmail: boolean };

export function BlDetailScreen({
  detail,
  can,
  replyTypes,
  today,
}: {
  detail: BlDetail;
  can: BlDetailPermissions;
  replyTypes: ReplyTypeOption[];
  today: string;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"edit" | "void" | null>(null);
  const { bl, payment, ledger, documents, timeline } = detail;
  const done = () => {
    setDialog(null);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-4">
      <Link href="/bls" className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline">
        <ArrowLeft className="size-4" /> {t("bls.detail.back")}
      </Link>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-lg font-semibold">{bl.blNo}</h1>
        <BlStatusBadge status={bl.status} voided={!!bl.voidedAt} voidReason={bl.voidReason} />
        <span>{bl.agencyName}</span>
        <div className="ml-auto flex gap-2">
          {can.edit && !bl.voidedAt && (
            <Button size="sm" variant="outline" onClick={() => setDialog("edit")}>
              {t("bls.edit")}
            </Button>
          )}
          {can.void && !bl.voidedAt && (
            <Button size="sm" variant="outline" onClick={() => setDialog("void")}>
              {t("bls.void")}
            </Button>
          )}
        </div>
      </header>
      {bl.voidedAt && (
        <Alert variant="destructive">
          <AlertDescription>
            {t("bls.detail.voidedInfo", { date: formatTimestamp(bl.voidedAt), reason: bl.voidReason ?? "" })}
          </AlertDescription>
        </Alert>
      )}
      <BalanceStrip bl={bl} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Section title={t("bls.summary")}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">{t("bls.paidAt")}</dt>
            <dd>{formatBusinessDate(bl.paidAt)}</dd>
            <dt className="text-muted-foreground">{t("bls.daysWaiting")}</dt>
            <dd>{bl.daysWaiting ?? t("common.none")}</dd>
            <dt className="text-muted-foreground">{t("bls.attempts")}</dt>
            <dd>
              {bl.attempts}
              {bl.lastRequestOn && <span className="text-muted-foreground"> · {t("bls.lastRequestOn")}: {formatBusinessDate(bl.lastRequestOn)}</span>}
            </dd>
            <dt className="text-muted-foreground">{t("bls.lastReply")}</dt>
            <dd>{bl.lastReply ? `${bl.lastReply.typeName} · ${formatBusinessDate(bl.lastReply.repliedOn)}` : t("common.none")}</dd>
            <dt className="text-muted-foreground">{t("bls.containers")}</dt>
            <dd className="font-mono text-xs">{bl.containers.length ? bl.containers.join(", ") : t("bls.noContainers")}</dd>
            <dt className="text-muted-foreground">{t("bls.sourcePayment")}</dt>
            <dd>
              {payment ? (
                <span className="flex flex-wrap items-center gap-2">
                  {t(`payments.kinds.${payment.kind}`)} · {formatMoney(bl.depositMinor, bl.currency)} ·{" "}
                  <a href={`/api/files/${payment.evidenceDocumentId}`} target="_blank" rel="noreferrer" className="underline">
                    {payment.evidenceName}
                  </a>
                  <span className="text-muted-foreground text-xs">({payment.createdByName})</span>
                </span>
              ) : (
                t("common.none")
              )}
            </dd>
          </dl>
        </Section>

        <Section title={t("forms.sectionTitle")}>
          <FormSection blId={bl.id} form={detail.form} editable={can.forms && !bl.voidedAt} />
        </Section>

        <Section title={t("blReplies.sectionTitle")}>
          <ReplySection
            blId={bl.id}
            detail={detail}
            replyTypes={replyTypes}
            today={today}
            canRecord={can.recordReply && !bl.voidedAt}
            canLink={can.linkEmail && !bl.voidedAt}
          />
        </Section>

        <Section title={t("bls.detail.documents")}>
          {documents.length === 0 ? (
            <p className="text-muted-foreground">{t("bls.detail.noDocuments")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {documents.map((doc) => (
                <li key={doc.id} className="flex items-center gap-2">
                  <a href={`/api/files/${doc.id}`} target="_blank" rel="noreferrer" className="underline">
                    {doc.originalName}
                  </a>
                  <span className="text-muted-foreground text-xs">
                    {formatTimestamp(doc.uploadedAt)} · {doc.uploadedByName}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t("bls.detail.timeline")}>
          {timeline.length === 0 ? (
            <p className="text-muted-foreground">{t("bls.detail.noTimeline")}</p>
          ) : (
            <ol className="flex flex-col gap-2 border-l pl-4">
              {timeline.map((event) => (
                <li key={event.id}>
                  <div>{actionLabel(event.action)}</div>
                  <div className="text-muted-foreground text-xs">
                    {formatTimestamp(event.at)} · {event.actorName ?? t("timeline.system")}
                  </div>
                  {event.reason && <div className="text-xs italic">{event.reason}</div>}
                  {event.notes.map((note) => (
                    <div key={note} className="text-xs text-amber-700 dark:text-amber-400">
                      {t(`timeline.notes.${note}`)}
                    </div>
                  ))}
                </li>
              ))}
            </ol>
          )}
        </Section>

        <section className="rounded-md border p-4">
          <OverridesEditor
            idPrefix="bl-override"
            title={t("overrides.blTitle")}
            hint={t("overrides.blHint")}
            values={detail.overrides.values}
            inherited={detail.overrides.inherited}
            inheritedLabel={(value) => t("overrides.inherited", { value })}
            editable={can.overrides && !bl.voidedAt}
            hypothesisOf={(overrides) => ({ bl: { blId: bl.id, overrides } })}
            onSave={(overrides, reason) => updateBlOverridesAction({ blId: bl.id, overrides, reason })}
            saveLabel={t("overrides.save")}
            savedMessage={t("overrides.saved")}
          />
        </section>

        <Section title={t("bls.detail.ledger")}>
          <table className="tabular w-full">
            <thead className="text-muted-foreground text-left text-xs">
              <tr>
                <th className="py-1 font-normal">{t("bls.detail.entryDate")}</th>
                <th className="py-1 font-normal">{t("bls.detail.entryType")}</th>
                <th className="py-1 text-right font-normal">{t("bls.detail.amount")}</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((line) => (
                <tr key={line.id} className={cn("border-t", line.compensated && "text-muted-foreground line-through")}>
                  <td className="py-1">{formatBusinessDate(line.entryDate)}</td>
                  <td className="py-1">
                    {t(`bls.ledgerTypes.${line.type}`)}
                    {line.compensatesEntryId !== null && <span className="text-muted-foreground text-xs"> · {t("bls.detail.compensates")}</span>}
                    {line.compensated && <span className="text-xs"> · {t("bls.detail.compensated")}</span>}
                  </td>
                  <td className="py-1 text-right whitespace-nowrap">{formatMoney(line.amountMinor, line.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>

      {dialog === "edit" && <EditBlDialog bl={bl} onCancel={() => setDialog(null)} onSaved={done} />}
      {dialog === "void" && <VoidBlDialog bl={bl} onCancel={() => setDialog(null)} onVoided={done} />}
    </div>
  );
}
