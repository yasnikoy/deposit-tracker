"use client";

import { useRouter } from "next/navigation";
import { useState, type ClipboardEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseContainerList } from "@/domain/containers";
import { t } from "@/i18n";
import { formatBusinessDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import type { BlRowError } from "@/server/bls";
import type { PaymentListItem } from "@/server/payments";
import { createBlsAction } from "../actions";
import { blCandidatesOf, blRowWarnings } from "../bl-warnings";

type RowInput = { blNo: string; containers: string };

/** Payments without a B/L in one editable grid; valid rows are saved together. */
export function CreateBlsScreen({ payments, patterns }: { payments: PaymentListItem[]; patterns: Record<number, string[]> }) {
  const router = useRouter();
  const [inputs, setInputs] = useState<Record<number, RowInput>>(() =>
    Object.fromEntries(
      payments.map((p) => {
        const candidates = blCandidatesOf(p);
        return [p.id, { blNo: candidates.length === 1 ? candidates[0] : "", containers: "" }];
      }),
    ),
  );
  const [errors, setErrors] = useState<Record<number, BlRowError[]>>({});
  const [busy, setBusy] = useState(false);
  const input = (id: number): RowInput => inputs[id] ?? { blNo: "", containers: "" };
  const update = (id: number, patch: Partial<RowInput>) => setInputs((all) => ({ ...all, [id]: { ...input(id), ...patch } }));

  /** Pasting several lines (or tab-separated columns) from Excel fills this row and the ones below. */
  const onPaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!/[\t\n]/.test(text.trim())) return;
    event.preventDefault();
    const lines = text.replace(/\r/g, "").replace(/\n$/, "").split("\n");
    setInputs((all) => {
      const next = { ...all };
      lines.forEach((line, offset) => {
        const payment = payments[index + offset];
        if (!payment) return;
        const [blNo = "", ...rest] = line.split("\t");
        next[payment.id] = { blNo: blNo.trim(), containers: rest.join(" ").trim() || (next[payment.id]?.containers ?? "") };
      });
      return next;
    });
  };

  const save = async () => {
    const rows = payments
      .filter((p) => input(p.id).blNo.trim() !== "")
      .map((p) => ({ paymentId: p.id, blNo: input(p.id).blNo, containers: parseContainerList(input(p.id).containers) }));
    if (rows.length === 0) return;
    setBusy(true);
    const result = await createBlsAction({ rows });
    setBusy(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));

    const byPayment: Record<number, BlRowError[]> = {};
    for (const error of result.data.errors) (byPayment[rows[error.index].paymentId] ??= []).push(error);
    setErrors(byPayment);
    if (result.data.created.length) toast.success(t("bls.savedCount", { count: result.data.created.length }));
    if (result.data.errors.length) toast.error(t("bls.rowErrors", { count: Object.keys(byPayment).length }));
    router.refresh();
  };

  if (payments.length === 0) return <p className="text-muted-foreground">{t("bls.awaitingEmpty")}</p>;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-xs">{t("bls.pasteHint")}</p>
      <div className="overflow-auto rounded-md border">
        <table className="tabular w-full border-collapse">
          <thead className="bg-muted/60">
            <tr className="text-left">
              <th className="px-2 py-1 font-medium">{t("bls.paidAt")}</th>
              <th className="px-2 py-1 font-medium">{t("bls.agency")}</th>
              <th className="px-2 py-1 text-right font-medium">{t("bls.deposit")}</th>
              <th className="px-2 py-1 font-medium">{t("bls.candidates")}</th>
              <th className="px-2 py-1 font-medium">{t("bls.blNo")}</th>
              <th className="px-2 py-1 font-medium">{t("bls.containers")}</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((payment, index) => {
              const value = input(payment.id);
              const rowErrors = errors[payment.id] ?? [];
              const warnings = blRowWarnings(value.blNo, value.containers, patterns[payment.agencyId] ?? []);
              return (
                <tr key={payment.id} data-testid={`bl-row-${payment.id}`} className="border-t align-top">
                  <td className="px-2 py-1 whitespace-nowrap">{formatBusinessDate(payment.paidAt)}</td>
                  <td className="px-2 py-1">{payment.agencyName}</td>
                  <td className="px-2 py-1 text-right whitespace-nowrap">{formatMoney(payment.amountMinor, payment.currency)}</td>
                  <td className="px-2 py-1">
                    <div className="flex flex-wrap gap-1">
                      {blCandidatesOf(payment).map((candidate) => (
                        <button
                          key={candidate}
                          type="button"
                          className="bg-muted hover:bg-accent rounded px-1.5 font-mono text-xs"
                          onClick={() => update(payment.id, { blNo: candidate })}
                          title={t("bls.useCandidate", { bl: candidate })}
                        >
                          {candidate}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="w-48 px-2 py-1">
                    <Input
                      aria-label={`${t("bls.blNo")} – ${payment.agencyName} ${formatMoney(payment.amountMinor, payment.currency)}`}
                      className="h-8 font-mono uppercase"
                      value={value.blNo}
                      onChange={(event) => update(payment.id, { blNo: event.target.value })}
                      onPaste={(event) => onPaste(index, event)}
                    />
                  </td>
                  <td className="w-80 px-2 py-1">
                    <Input
                      aria-label={`${t("bls.containers")} – ${payment.agencyName} ${formatMoney(payment.amountMinor, payment.currency)}`}
                      className="h-8 font-mono uppercase"
                      value={value.containers}
                      onChange={(event) => update(payment.id, { containers: event.target.value })}
                    />
                    {rowErrors.map((error) => (
                      <p key={error.field} role="alert" className="text-destructive text-xs">
                        {t(error.message)}
                        {error.item ? ` (${error.item})` : ""}
                      </p>
                    ))}
                    {warnings.map((warning) => (
                      <p key={warning} className="text-xs text-amber-700 dark:text-amber-400">
                        {warning}
                      </p>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end">
        <Button onClick={save} disabled={busy}>
          {t("bls.saveAll")}
        </Button>
      </div>
    </div>
  );
}
