"use client";

import { ArrowLeft, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { BlStatusBadge } from "@/components/bl-status-badge";
import { OverridesEditor } from "@/components/overrides-editor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { isTranslationKey, t } from "@/i18n";
import { formatBusinessDate, formatTimestamp } from "@/lib/format";
import { isPlainKey, isTyping } from "@/lib/keyboard";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { BlDetail } from "@/server/bl-overview";
import { EvidenceDrop } from "../../accounting/evidence-drop";
import { BalanceStrip } from "../balance-strip";
import { EditBlDialog, VoidBlDialog } from "../bl-dialogs";
import { updateBlOverridesAction } from "../../requests/actions";
import { undoAction } from "../../undo-actions";
import { FormSection } from "../form-section";
import type { ReplyTypeOption } from "../../replies/replies-screen";
import type { DeductionTypeOption } from "../deduction-dialog";
import { AllocationsSection } from "./allocations-section";
import { DeductionsSection } from "./deductions-section";
import { ReplySection } from "./reply-section";
import { NotesSection } from "./notes-section";
import type { MentionableUser } from "../note-editor";

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

export type BlDetailPermissions = {
  edit: boolean;
  void: boolean;
  forms: boolean;
  overrides: boolean;
  recordReply: boolean;
  linkEmail: boolean;
  reverseAllocation: boolean;
  /** Attach the receipt or invoice the source payment was saved without. */
  attachEvidence: boolean;
  attachOpeningEvidence: boolean;
  recordDeduction: boolean;
  disputeDeduction: boolean;
  proposeWriteOff: boolean;
  addNote: boolean;
};

export function BlDetailScreen({
  detail,
  can,
  replyTypes,
  deductionTypes,
  mentionable,
  today,
}: {
  detail: BlDetail;
  can: BlDetailPermissions;
  replyTypes: ReplyTypeOption[];
  deductionTypes: DeductionTypeOption[];
  mentionable: MentionableUser[];
  today: string;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"edit" | "void" | null>(null);

  // R records a reply, N starts a note (when the viewer may), outside text fields and dialogs.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlainKey(event) || isTyping(event.target) || document.querySelector('[role="dialog"]')) return;
      const key = event.key.toLowerCase();
      const target = key === "r" ? document.getElementById("record-reply") : key === "n" ? document.getElementById("note-body") : null;
      if (!target) return;
      event.preventDefault();
      if (key === "r") target.click();
      else {
        target.scrollIntoView({ block: "center" });
        target.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
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
                  {t(`payments.kinds.${payment.kind}`)} · {formatMoney(payment.amountMinor, bl.currency)} ·{" "}
                  {payment.evidenceDocumentId !== null ? (
                    <a href={`/api/files/${payment.evidenceDocumentId}`} target="_blank" rel="noreferrer" className="underline">
                      {payment.evidenceName}
                    </a>
                  ) : (
                    <span className="text-amber-700 dark:text-amber-400">{t(`payments.evidenceMissing.${payment.kind}`)}</span>
                  )}
                  <span className="text-muted-foreground text-xs">({payment.createdByName})</span>
                  {payment.evidenceDocumentId === null && can.attachEvidence && !bl.voidedAt && (
                    <span className="w-full">
                      <EvidenceDrop paymentId={payment.id} kind={payment.kind} compact />
                    </span>
                  )}
                </span>
              ) : detail.openingBalance ? (
                <span className="flex flex-wrap items-center gap-2">
                  {t("openingBalances.source")} · {formatMoney(bl.depositMinor, bl.currency)} ·{" "}
                  {detail.openingBalance.documentId !== null ? (
                    <a href={`/api/files/${detail.openingBalance.documentId}`} target="_blank" rel="noreferrer" className="underline">
                      {detail.openingBalance.originalName}
                    </a>
                  ) : (
                    <span className="text-amber-700 dark:text-amber-400">{t("payments.evidenceMissing.BANK")}</span>
                  )}
                  {detail.openingBalance.documentId === null && can.attachOpeningEvidence && !bl.voidedAt && (
                    <span className="w-full">
                      <EvidenceDrop blId={bl.id} kind="BANK" compact />
                    </span>
                  )}
                </span>
              ) : (
                t("common.none")
              )}
            </dd>
            {detail.additionalPayments.length > 0 && (
              <>
                <dt className="text-muted-foreground">{t("bls.additionalPayments")}</dt>
                <dd>
                  <ul className="flex flex-col gap-0.5" data-testid="additional-payments">
                    {detail.additionalPayments.map((p) => (
                      <li key={p.id}>
                        {formatMoney(p.amountMinor, p.currency)} · {formatBusinessDate(p.paidAt)} ·{" "}
                        {p.evidenceDocumentId !== null ? (
                          <a href={`/api/files/${p.evidenceDocumentId}`} target="_blank" rel="noreferrer" className="underline">
                            {p.evidenceName}
                          </a>
                        ) : (
                          <span className="text-amber-700 dark:text-amber-400">{t("payments.evidenceMissing.BANK")}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <span className="text-muted-foreground text-xs">{t("bls.depositTotal", { amount: formatMoney(bl.depositMinor, bl.currency) })}</span>
                </dd>
              </>
            )}
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

        <Section title={t("notes.title")}>
          <NotesSection blId={bl.id} notes={detail.notes} canAdd={can.addNote && !bl.voidedAt} users={mentionable} />
        </Section>

        <Section title={t("bls.detail.documents")}>
          {documents.length === 0 ? (
            <p className="text-muted-foreground">{t("bls.detail.noDocuments")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {documents.map((doc) => (
                <li key={doc.id} className={cn("flex items-center gap-2", doc.withdrawn && "text-muted-foreground line-through")} title={doc.withdrawn ? t("undo.undone") : undefined}>
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
                <li key={event.id} className={cn(event.undone && "text-muted-foreground")}>
                  <div className="flex items-center gap-2">
                    <span className={cn(event.undone && "line-through")}>
                      {event.undoOfAction ? t("undo.timeline", { action: actionLabel(event.undoOfAction) }) : actionLabel(event.action)}
                    </span>
                    {event.undoable && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        onClick={async () => {
                          const result = await undoAction({ auditIds: [event.id] });
                          if (!result.ok) return void toast.error(t(result.error, result.params));
                          toast.success(t("undo.done"));
                          router.refresh();
                        }}
                      >
                        <Undo2 className="size-3.5" /> {t("undo.action")}
                      </Button>
                    )}
                  </div>
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

        <Section title={t("deductions.sectionTitle")}>
          <DeductionsSection
            detail={detail}
            deductionTypes={deductionTypes}
            can={{
              record: can.recordDeduction && !bl.voidedAt,
              dispute: can.disputeDeduction && !bl.voidedAt,
              proposeWriteOff: can.proposeWriteOff && !bl.voidedAt,
            }}
          />
        </Section>

        <Section title={t("blAllocations.title")}>
          <AllocationsSection blNo={bl.blNo} allocations={detail.allocations} canReverse={can.reverseAllocation} />
        </Section>

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
                    {line.deduction && (
                      <span className="text-muted-foreground text-xs">
                        {" "}
                        · {line.deduction.typeName} ({t(`bls.deductionSources.${line.deduction.source}`)})
                      </span>
                    )}
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
