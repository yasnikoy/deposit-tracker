"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { formatTimestamp } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import type { WriteOffRow } from "@/server/write-offs";
import { approveWriteOffAction, rejectWriteOffAction } from "./actions";

/** Admin approvals (rule 16): an approved write-off closes the B/L; a rejected one changes nothing. */
export function WriteOffsScreen({ lists, canDecide }: { lists: { pending: WriteOffRow[]; decided: WriteOffRow[] }; canDecide: boolean }) {
  const router = useRouter();
  const [deciding, setDeciding] = useState<{ row: WriteOffRow; action: "approve" | "reject" } | null>(null);
  const money = (row: WriteOffRow, minor: number) => formatMoney(minor, row.currency);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">{t("writeOffs.pending")}</h2>
        {lists.pending.length === 0 ? (
          <p className="text-muted-foreground">{t("writeOffs.nonePending")}</p>
        ) : (
          <table className="tabular w-full text-sm">
            <thead className="text-muted-foreground text-left text-xs">
              <tr>
                <th className="px-3 py-1 font-normal">{t("bls.blNo")}</th>
                <th className="px-3 py-1 font-normal">{t("bls.agency")}</th>
                <th className="px-3 py-1 text-right font-normal">{t("writeOffs.amount")}</th>
                <th className="px-3 py-1 font-normal">{t("writeOffs.reason")}</th>
                <th className="px-3 py-1 font-normal">{t("writeOffs.proposedBy")}</th>
                <th className="px-3 py-1 font-normal">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {lists.pending.map((row) => {
                const changed = row.currentAmountMinor !== null && row.currentAmountMinor !== row.amountMinor;
                return (
                  <tr key={row.id} className="border-t align-top">
                    <td className="px-3 py-1.5">
                      <Link href={`/bls/${row.blId}`} className="font-mono hover:underline">
                        {row.blNo}
                      </Link>
                    </td>
                    <td className="px-3 py-1.5">{row.agencyName}</td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                      {money(row, row.amountMinor)}
                      {changed && (
                        <div className="text-xs text-amber-700 dark:text-amber-400">
                          {t("writeOffs.changedSince", { amount: money(row, row.currentAmountMinor!) })}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 italic">{row.reason}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {row.proposedByName}
                      <div className="text-muted-foreground text-xs">{formatTimestamp(row.proposedAt)}</div>
                    </td>
                    <td className="px-3 py-1.5">
                      {canDecide && (
                        <div className="flex gap-2">
                          <Button size="sm" disabled={changed} onClick={() => setDeciding({ row, action: "approve" })}>
                            {t("writeOffs.approve")}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setDeciding({ row, action: "reject" })}>
                            {t("writeOffs.reject")}
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">{t("writeOffs.decided")}</h2>
        {lists.decided.length === 0 ? (
          <p className="text-muted-foreground">{t("writeOffs.noneDecided")}</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {lists.decided.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2">
                <Badge variant={row.state === "APPROVED" ? "default" : "outline"}>{t(`writeOffs.states.${row.state}`)}</Badge>
                <Link href={`/bls/${row.blId}`} className="font-mono hover:underline">
                  {row.blNo}
                </Link>
                <span>{row.agencyName}</span>
                <span className="tabular font-medium">{money(row, row.amountMinor)}</span>
                <span className="text-muted-foreground text-xs">
                  {row.decidedAt && formatTimestamp(row.decidedAt)} · {row.decidedByName}
                </span>
                {row.decisionNote && <span className="text-xs italic">{row.decisionNote}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {deciding && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeciding(null)}
          title={t(deciding.action === "approve" ? "writeOffs.approveTitle" : "writeOffs.rejectTitle")}
          description={t(deciding.action === "approve" ? "writeOffs.approveText" : "writeOffs.rejectText", {
            amount: money(deciding.row, deciding.row.amountMinor),
          })}
          items={[`${deciding.row.blNo} · ${deciding.row.agencyName} · ${money(deciding.row, deciding.row.amountMinor)}`]}
          confirmLabel={t(deciding.action === "approve" ? "writeOffs.approve" : "writeOffs.reject")}
          destructive={deciding.action === "approve"}
          requireReason={deciding.action === "reject"}
          onConfirm={async (reason) => {
            const result =
              deciding.action === "approve"
                ? await approveWriteOffAction({ writeOffId: deciding.row.id, note: null })
                : await rejectWriteOffAction({ writeOffId: deciding.row.id, reason });
            if (!result.ok) return void toast.error(t(result.error, result.params));
            toast.success(t(deciding.action === "approve" ? "writeOffs.approved" : "writeOffs.rejected"));
            setDeciding(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
