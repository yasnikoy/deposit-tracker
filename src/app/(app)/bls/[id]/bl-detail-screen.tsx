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
import { DescriptionEditor } from "../description-editor";
import type { CustomerOption } from "@/components/customer-combobox";
import { ContainersField } from "./containers-field";
import { CustomerField } from "./customer-field";
import { UnitField } from "./unit-field";
import { recordAccountingEntryAction } from "../../accounting/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { reverseTransferAction } from "../actions";
import { TransferDialog } from "./transfer-dialog";
import { toastWithUndo } from "@/components/undo-toast";

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
  recordOutsideRequest: boolean;
  /** Open the B/L's emails in place (the message and its reply buttons). */
  viewEmails: boolean;
  linkEmail: boolean;
  reverseAllocation: boolean;
  /** Attach the receipt or invoice the source payment was saved without. */
  attachEvidence: boolean;
  attachOpeningEvidence: boolean;
  recordDeduction: boolean;
  disputeDeduction: boolean;
  proposeWriteOff: boolean;
  editDescription: boolean;
  setCustomer: boolean;
  /** Send a sent request email again (wrong recipients, or redirected by a reply). */
  resend: boolean;
  /** Confirm the accounting entry of a B/L settled with deductions or an offset. */
  recordAccounting: boolean;
  /** Move the whole deposit to another B/L (accounting or operations). */
  transfer: boolean;
  /** Take a transfer back before it is booked (admin). */
  reverseTransfer: boolean;
};

export function BlDetailScreen({
  detail,
  can,
  replyTypes,
  deductionTypes,
  customers,
  units,
  today,
}: {
  detail: BlDetail;
  can: BlDetailPermissions;
  replyTypes: ReplyTypeOption[];
  deductionTypes: DeductionTypeOption[];
  customers: CustomerOption[];
  /** The agency's active units; empty for agencies without units. */
  units: { id: number; name: string }[];
  today: string;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"edit" | "void" | "transfer" | "reverseTransfer" | null>(null);

  // R records a reply, N starts a note (when the viewer may), outside text fields and dialogs.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlainKey(event) || isTyping(event.target) || document.querySelector('[role="dialog"]')) return;
      const key = event.key.toLowerCase();
      const target = key === "r" ? document.getElementById("record-reply") : key === "n" ? document.getElementById("bl-description") : null;
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
  // A deposit moves on while the B/L is open and nothing was refunded on it.
  const canTransfer =
    can.transfer && !bl.voidedAt && ["PAID", "DUE", "REQUESTED", "AWAITING_RETURN"].includes(bl.status) && bl.expectedMinor > 0 && bl.collectedMinor === 0;
  const canReverseTransfer = can.reverseTransfer && !bl.voidedAt && bl.status === "ACCOUNTING_PENDING" && detail.transfers.out.length > 0;
  const opening = detail.openingBalance;
  const depositParts = (payment ? 1 : 0) + detail.additionalPayments.length + (opening?.entries.length ?? 0);
  // Deposits moved from Excel: each amount with its date, their receipts, and a drop for a missing one.
  const openingLine = opening && (
    <span className="flex flex-wrap items-center gap-2">
      {t("openingBalances.source")} ·{" "}
      {opening.entries.map((e) => `${formatMoney(e.amountMinor, e.currency)} (${formatBusinessDate(e.entryDate)})`).join(" + ")}
      {opening.documents.map((d) => (
        <a key={d.id} href={`/api/files/${d.id}`} target="_blank" rel="noreferrer" className="underline">
          {d.originalName}
        </a>
      ))}
      {opening.missingEvidence > 0 && <span className="text-amber-700 dark:text-amber-400">{t("payments.evidenceMissing.BANK")}</span>}
      {opening.missingEvidence > 0 && can.attachOpeningEvidence && !bl.voidedAt && (
        <span className="w-full">
          <EvidenceDrop blId={bl.id} kind="BANK" compact />
        </span>
      )}
    </span>
  );
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
          {can.recordAccounting && bl.status === "ACCOUNTING_PENDING" && !bl.voidedAt && (
            <Button
              size="sm"
              onClick={async () => {
                const result = await recordAccountingEntryAction({ blIds: [bl.id] });
                if (!result.ok) return void toast.error(t(result.error, result.params));
                toastWithUndo(t("payments.accountingEntries.recorded", { count: 1 }), result.data, () => router.refresh());
                router.refresh();
              }}
            >
              {t("payments.accountingEntries.record")}
            </Button>
          )}
          {canTransfer && (
            <Button size="sm" variant="outline" onClick={() => setDialog("transfer")}>
              {t("transfers.action")}
            </Button>
          )}
          {canReverseTransfer && (
            <Button size="sm" variant="outline" className="text-destructive" onClick={() => setDialog("reverseTransfer")}>
              {t("transfers.reverse")}
            </Button>
          )}
          {can.edit && !bl.voidedAt && (
            <Button size="sm" variant="outline" onClick={() => setDialog("edit")}>
              {t("bls.edit")}
            </Button>
          )}
          {can.void && !bl.voidedAt && (
            <Button size="sm" variant="outline" className="text-destructive" onClick={() => setDialog("void")}>
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
        {/* Work and money first; documents, admin-only overrides and the long timeline last. */}
        <Section title={t("bls.summary")}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">{t("bls.customer")}</dt>
            <dd>
              <CustomerField blId={bl.id} customerId={bl.customerId} customerName={bl.customerName} customers={customers} editable={can.setCustomer && !bl.voidedAt} />
            </dd>
            {(units.length > 0 || bl.unitId !== null) && (
              <>
                <dt className="text-muted-foreground">{t("bls.unit")}</dt>
                <dd>
                  <UnitField key={bl.unitId ?? 0} blId={bl.id} unitId={bl.unitId} unitName={bl.unitName} units={units} editable={can.edit && !bl.voidedAt} />
                </dd>
              </>
            )}
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
            <dd>
              <ContainersField key={bl.containers.join(",")} blId={bl.id} containers={bl.containers} editable={can.edit && !bl.voidedAt} />
            </dd>
            {(detail.transfers.out.length > 0 || detail.transfers.in.length > 0) && (
              <>
                <dt className="text-muted-foreground">{t("transfers.label")}</dt>
                <dd className="flex flex-col gap-0.5" data-testid="bl-transfers">
                  {detail.transfers.in.map((tr) => (
                    <span key={tr.blId}>
                      {t("transfers.from")}{" "}
                      <Link href={`/bls/${tr.blId}`} className="font-mono underline">
                        {tr.blNo}
                      </Link>{" "}
                      · {formatMoney(tr.amountMinor, tr.currency)} · {formatBusinessDate(tr.transferredOn)}
                    </span>
                  ))}
                  {detail.transfers.out.map((tr) => (
                    <span key={tr.blId}>
                      {t("transfers.to")}{" "}
                      <Link href={`/bls/${tr.blId}`} className="font-mono underline">
                        {tr.blNo}
                      </Link>{" "}
                      · {formatMoney(tr.amountMinor, tr.currency)} · {formatBusinessDate(tr.transferredOn)}
                    </span>
                  ))}
                </dd>
              </>
            )}
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
              ) : (
                (openingLine ?? t("common.none"))
              )}
            </dd>
            {payment && openingLine && (
              <>
                <dt className="text-muted-foreground">{t("openingBalances.title")}</dt>
                <dd>{openingLine}</dd>
              </>
            )}
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
                        {p.description && <div className="text-muted-foreground text-xs whitespace-pre-line">{p.description}</div>}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {depositParts > 1 && (
              <>
                <dt />
                <dd className="text-muted-foreground text-xs">{t("bls.depositTotal", { amount: formatMoney(bl.depositMinor, bl.currency) })}</dd>
              </>
            )}
          </dl>
        </Section>

        <Section title={t("description.title")}>
          <DescriptionEditor key={bl.id} blId={bl.id} description={bl.description} editable={can.editDescription && !bl.voidedAt} />
        </Section>

        <Section title={t("forms.sectionTitle")}>
          <FormSection blId={bl.id} form={detail.form} editable={can.forms && !bl.voidedAt} />
        </Section>

        <Section title={t("blReplies.sectionTitle")}>
          <ReplySection
            blId={bl.id}
            detail={detail}
            replyTypes={replyTypes}
            deductionTypes={deductionTypes}
            today={today}
            canView={can.viewEmails}
            canRecord={can.recordReply && !bl.voidedAt}
            // The statuses a refund request can still be made from.
            canRecordRequest={can.recordOutsideRequest && !bl.voidedAt && ["PAID", "DUE", "REQUESTED", "AWAITING_RETURN"].includes(bl.status)}
            canLink={can.linkEmail && !bl.voidedAt}
            canRecordDeduction={can.recordDeduction && !bl.voidedAt}
            // Only while the B/L is still open: a settled B/L takes no more requests.
            canResend={can.resend && !bl.voidedAt && bl.status !== "COLLECTED" && bl.status !== "ACCOUNTING_PENDING"}
          />
        </Section>

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

        {/* Read-only exceptions only matter when one is set; admins always see the editor. */}
        {(can.overrides || Object.values(detail.overrides.values).some((value) => value !== null)) && (
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
        )}

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
      </div>

      {dialog === "edit" && <EditBlDialog bl={bl} onCancel={() => setDialog(null)} onSaved={done} />}
      {dialog === "void" && <VoidBlDialog bl={bl} onCancel={() => setDialog(null)} onVoided={done} />}
      {dialog === "transfer" && (
        <TransferDialog
          sources={[{ id: bl.id, blNo: bl.blNo, amountMinor: bl.expectedMinor }]}
          currency={bl.currency}
          defaults={bl}
          customers={customers}
          units={units}
          today={today}
          onCancel={() => setDialog(null)}
          onDone={(targets) => {
            setDialog(null);
            // One target opens; a split stays here, where the detail links every target.
            if (targets.length === 1) router.push(`/bls/${targets[0].blId}`);
            else router.refresh();
          }}
        />
      )}
      {dialog === "reverseTransfer" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t("transfers.reverse")}
          description={t("transfers.reverseHint")}
          items={detail.transfers.out.map((tr) => `${bl.blNo} → ${tr.blNo}`)}
          confirmLabel={t("transfers.reverse")}
          destructive
          requireReason
          onConfirm={async (reason) => {
            const result = await reverseTransferAction({ sourceBlId: bl.id, reason });
            if (!result.ok) return void toast.error(t(result.error, result.params));
            toast.success(t("transfers.reversed"));
            done();
          }}
        />
      )}
    </div>
  );
}
