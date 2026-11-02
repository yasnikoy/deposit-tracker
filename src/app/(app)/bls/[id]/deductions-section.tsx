"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { formatBusinessDate, formatTimestamp } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import type { BlDetail } from "@/server/bl-overview";
import { disputeDeductionAction, proposeWriteOffAction } from "../actions";
import { DeductionDialog, type DeductionTypeOption } from "../deduction-dialog";

export type DeductionPermissions = { record: boolean; dispute: boolean; proposeWriteOff: boolean };

/**
 * Deductions in effect on the B/L with their statement and dispute, and the actions that
 * apply now: deductions from a statement, classifying or disputing an unexplained one,
 * clearing a dispute, and proposing a write-off for an admin to approve.
 */
export function DeductionsSection({
  detail,
  deductionTypes,
  can,
}: {
  detail: Pick<BlDetail, "bl" | "ledger" | "documents" | "emails" | "deductionTarget" | "writeOffs" | "writeOffAmountMinor">;
  deductionTypes: DeductionTypeOption[];
  can: DeductionPermissions;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"deduction" | "dispute" | "writeOff" | null>(null);
  const { bl, deductionTarget: target } = detail;
  const money = (minor: number) => formatMoney(minor, bl.currency);
  const deductions = detail.ledger.filter((l) => l.deduction && !l.compensated && l.compensatesEntryId === null);
  const pending = detail.writeOffs.find((w) => w.state === "PROPOSED");
  const statements = [
    ...detail.documents.filter((d) => d.kind === "DEDUCTION_STATEMENT").map((d) => ({ documentId: d.id, originalName: d.originalName })),
    ...detail.emails.flatMap((e) => e.attachments.map((a) => ({ documentId: a.id, originalName: a.originalName }))),
  ];
  const done = () => {
    setDialog(null);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      {deductions.length === 0 ? (
        <p className="text-muted-foreground">{t("deductions.none")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {deductions.map((line) => (
            <li key={line.id} className="flex flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="tabular font-medium">{formatMoney(line.amountMinor, line.currency)}</span>
                <span>{line.deduction!.typeName}</span>
                <span className="text-muted-foreground text-xs">
                  {t(`bls.deductionSources.${line.deduction!.source}`)} · {formatBusinessDate(line.entryDate)}
                </span>
                {line.deduction!.code === "UNEXPLAINED" && !line.deduction!.disputed && <Badge variant="warning">{t("deductions.open")}</Badge>}
                {line.deduction!.disputed && <Badge variant="destructive">{t("deductions.disputed")}</Badge>}
                {line.deduction!.documentId !== null && (
                  <a href={`/api/files/${line.deduction!.documentId}`} target="_blank" rel="noreferrer" className="text-sm underline">
                    {t("deductions.statementLink")}
                  </a>
                )}
              </div>
              {line.deduction!.disputeNote && <div className="text-xs italic">{line.deduction!.disputeNote}</div>}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        {target && can.record && (
          <Button size="sm" variant="outline" onClick={() => setDialog("deduction")}>
            {t(target.mode === "STATEMENT" ? "deductions.addFromStatement" : target.disputed ? "deductions.clearDispute" : "deductions.classify")}
          </Button>
        )}
        {target?.mode === "CLASSIFY" && !target.disputed && can.dispute && (
          <Button size="sm" variant="outline" onClick={() => setDialog("dispute")}>
            {t("deductions.dispute")}
          </Button>
        )}
        {can.proposeWriteOff && !pending && detail.writeOffAmountMinor > 0 && (
          <Button size="sm" variant="outline" onClick={() => setDialog("writeOff")}>
            {t("writeOffs.propose")}
          </Button>
        )}
      </div>

      {detail.writeOffs.length > 0 && (
        <ul className="flex flex-col gap-2 border-t pt-2">
          {detail.writeOffs.map((w) => (
            <li key={w.id} className="flex flex-col gap-0.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={w.state === "PROPOSED" ? "warning" : "secondary"}>{t(`writeOffs.states.${w.state}`)}</Badge>
                <span className="tabular font-medium">{formatMoney(w.amountMinor, w.currency)}</span>
                <span className="text-muted-foreground text-xs">
                  {formatTimestamp(w.proposedAt)} · {w.proposedByName}
                </span>
              </div>
              <div className="text-xs italic">{w.reason}</div>
              {w.decidedAt && (
                <div className="text-muted-foreground text-xs">
                  {formatTimestamp(w.decidedAt)} · {w.decidedByName}
                  {w.decisionNote && <span className="italic"> · {w.decisionNote}</span>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {dialog === "deduction" && target && (
        <DeductionDialog
          bl={{ id: bl.id, blNo: bl.blNo, currency: bl.currency }}
          target={target}
          deductionTypes={deductionTypes}
          statements={statements}
          onCancel={() => setDialog(null)}
          onDone={done}
        />
      )}
      {dialog === "dispute" && target?.mode === "CLASSIFY" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t("deductions.disputeTitle", { bl: bl.blNo })}
          description={t("deductions.disputeText", { amount: money(target.amountMinor) })}
          confirmLabel={t("deductions.dispute")}
          requireReason
          onConfirm={async (note) => {
            const result = await disputeDeductionAction({ entryId: target.entryId, note });
            if (!result.ok) return void toast.error(t(result.error, result.params));
            toast.success(t("deductions.disputedToast"));
            done();
          }}
        />
      )}
      {dialog === "writeOff" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t("writeOffs.proposeTitle", { bl: bl.blNo })}
          description={t("writeOffs.proposeText", { amount: money(detail.writeOffAmountMinor) })}
          confirmLabel={t("writeOffs.propose")}
          requireReason
          onConfirm={async (reason) => {
            const result = await proposeWriteOffAction({ blId: bl.id, reason });
            if (!result.ok) return void toast.error(t(result.error, result.params));
            toast.success(t("writeOffs.proposed"));
            done();
          }}
        />
      )}
    </div>
  );
}
