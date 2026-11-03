"use client";

import { useRouter } from "next/navigation";
import { useState, type ClipboardEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { formatBusinessDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import type { BlRowError } from "@/server/bls";
import type { PaymentListItem } from "@/server/payments";
import { createBlsAction } from "../actions";
import { blCandidatesOf, blNoWarnings } from "../bl-warnings";


/** Payments without a B/L in one editable grid; rows with a B/L number are saved together. Read-only for accountants. */
type RowInput = { blNo: string; unitId: number | null };

export function CreateBlsScreen({
  payments,
  patterns,
  units,
  readOnly,
}: {
  payments: PaymentListItem[];
  patterns: Record<number, string[]>;
  /** Active units of the agencies that have them; such a B/L needs one. */
  units: Record<number, { id: number; name: string }[]>;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [inputs, setInputs] = useState<Record<number, RowInput>>(() =>
    Object.fromEntries(
      payments.map((p) => {
        const candidates = blCandidatesOf(p);
        return [p.id, { blNo: candidates.length === 1 ? candidates[0] : "", unitId: null }];
      }),
    ),
  );
  const [errors, setErrors] = useState<Record<number, BlRowError[]>>({});
  const [busy, setBusy] = useState(false);
  const input = (id: number): RowInput => inputs[id] ?? { blNo: "", unitId: null };
  const update = (id: number, patch: Partial<RowInput>) => setInputs((all) => ({ ...all, [id]: { ...input(id), ...patch } }));
  const withUnits = payments.some((p) => units[p.agencyId]);

  /** Pasting several lines from Excel fills this row and the ones below; only the first column is taken. */
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
        next[payment.id] = { blNo: (line.split("\t")[0] ?? "").trim(), unitId: next[payment.id]?.unitId ?? null };
      });
      return next;
    });
  };

  const filled = payments.filter((p) => input(p.id).blNo.trim() !== "");

  const save = async () => {
    const rows = filled.map((p) => ({ paymentId: p.id, blNo: input(p.id).blNo, unitId: input(p.id).unitId }));
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
      {!readOnly && <p className="text-muted-foreground text-xs">{t("bls.pasteHint")}</p>}
      <div className="overflow-auto rounded-md border">
        <table className="tabular w-full border-collapse">
          <thead className="bg-muted/60">
            <tr className="text-left">
              <th className="px-2 py-1 font-medium">{t("bls.paidAt")}</th>
              <th className="px-2 py-1 font-medium">{t("bls.agency")}</th>
              <th className="px-2 py-1 text-right font-medium">{t("bls.deposit")}</th>
              <th className="px-2 py-1 font-medium">{t("bls.customer")}</th>
              <th className="px-2 py-1 font-medium">{t("bls.fileNo")}</th>
              <th className="px-2 py-1 font-medium">{t("description.title")}</th>
              <th className="px-2 py-1 font-medium">{t("bls.candidates")}</th>
              {!readOnly && <th className="px-2 py-1 font-medium">{t("bls.blNo")}</th>}
              {!readOnly && withUnits && <th className="px-2 py-1 font-medium">{t("bls.unit")}</th>}
            </tr>
          </thead>
          <tbody>
            {payments.map((payment, index) => {
              const { blNo, unitId } = input(payment.id);
              const rowErrors = errors[payment.id] ?? [];
              const agencyUnits = units[payment.agencyId] ?? [];
              const warnings = blNoWarnings(blNo, patterns[payment.agencyId] ?? []);
              return (
                <tr key={payment.id} data-testid={`bl-row-${payment.id}`} className="border-t align-top">
                  <td className="px-2 py-1 whitespace-nowrap">{formatBusinessDate(payment.paidAt)}</td>
                  <td className="px-2 py-1">{payment.agencyName}</td>
                  <td className="px-2 py-1 text-right whitespace-nowrap">{formatMoney(payment.amountMinor, payment.currency)}</td>
                  {/* Entered by the accountant on the payment; the B/L takes them over. */}
                  <td className="px-2 py-1">{payment.customerName ?? <span className="text-muted-foreground">{t("common.none")}</span>}</td>
                  <td className="px-2 py-1 font-mono whitespace-nowrap">{payment.fileNo ?? <span className="text-muted-foreground font-sans">{t("common.none")}</span>}</td>
                  <td className="max-w-56 px-2 py-1">
                    {payment.description ? (
                      <span className="block truncate text-xs" title={payment.description}>
                        {payment.description.split("\n")[0]}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t("common.none")}</span>
                    )}
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex flex-wrap gap-1">
                      {/* A candidate already in the B/L no field is not repeated as a chip. */}
                      {blCandidatesOf(payment)
                        .filter((candidate) => readOnly || candidate !== blNo.trim().toUpperCase())
                        .map((candidate) =>
                        readOnly ? (
                          <span key={candidate} className="bg-muted rounded px-1.5 font-mono text-xs">
                            {candidate}
                          </span>
                        ) : (
                        <button
                          key={candidate}
                          type="button"
                          className="bg-muted hover:bg-accent rounded px-1.5 font-mono text-xs"
                          onClick={() => update(payment.id, { blNo: candidate })}
                          title={t("bls.useCandidate", { bl: candidate })}
                        >
                          {candidate}
                        </button>
                        ),
                      )}
                    </div>
                  </td>
                  {!readOnly && (
                  <td className="w-72 px-2 py-1">
                    <Input
                      aria-label={`${t("bls.blNo")} – ${payment.agencyName} ${formatMoney(payment.amountMinor, payment.currency)}`}
                      className="h-8 font-mono uppercase"
                      value={blNo}
                      onChange={(event) => update(payment.id, { blNo: event.target.value })}
                      onPaste={(event) => onPaste(index, event)}
                    />
                    {rowErrors
                      .filter((error) => error.field !== "unit")
                      .map((error) => (
                        <p key={error.field} role="alert" className="text-destructive text-xs">
                          {t(error.message)}
                        </p>
                      ))}
                    {warnings.map((warning) => (
                      <p key={warning} className="text-xs text-amber-700 dark:text-amber-400">
                        {warning}
                      </p>
                    ))}
                  </td>
                  )}
                  {!readOnly && withUnits && (
                    <td className="w-44 px-2 py-1">
                      {agencyUnits.length > 0 && (
                        <select
                          aria-label={`${t("bls.unit")} – ${payment.agencyName} ${formatMoney(payment.amountMinor, payment.currency)}`}
                          className="border-input bg-background h-8 w-full rounded-md border px-2"
                          value={unitId ?? ""}
                          onChange={(event) => update(payment.id, { unitId: event.target.value ? Number(event.target.value) : null })}
                        >
                          <option value="">{t("bls.unitPick")}</option>
                          {agencyUnits.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name}
                            </option>
                          ))}
                        </select>
                      )}
                      {rowErrors
                        .filter((error) => error.field === "unit")
                        .map((error) => (
                          <p key={error.field} role="alert" className="text-destructive text-xs">
                            {t(error.message)}
                          </p>
                        ))}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <div className="flex justify-end">
          <Button onClick={save} disabled={busy || filled.length === 0}>
            {t("bls.saveAll", { count: filled.length })}
          </Button>
        </div>
      )}
    </div>
  );
}
