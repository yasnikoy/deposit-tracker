"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AllocationLine } from "@/domain/allocation";
import type { DeductionTypeCode } from "@/domain/records";
import { t } from "@/i18n";
import { formatBusinessDate } from "@/lib/format";
import { formatAmount, formatMoney, parseAmountInput } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { AllocationProposal } from "@/server/allocations";
import { confirmAllocationAction } from "../actions";

type DeductionTypeOption = { id: number; name: string; code: DeductionTypeCode | null };

/**
 * Review of one refund: suggestion cards fill an editable split; the user decides which B/L
 * bears a difference and its type, or leaves money unallocated with a reason. Nothing is
 * posted until the user confirms (rule 6).
 */
export function AllocationReview({
  proposal,
  deductionTypes,
  canConfirm,
}: {
  proposal: AllocationProposal;
  deductionTypes: DeductionTypeOption[];
  canConfirm: boolean;
}) {
  const router = useRouter();
  const { refund, candidates, otherCandidates, suggestions } = proposal;
  // Other customers' B/Ls (same agency and currency) are not suggested, but can be added by hand.
  const [showOthers, setShowOthers] = useState(false);
  const rows = useMemo(() => (showOthers ? [...candidates, ...otherCandidates] : candidates), [showOthers, candidates, otherCandidates]);
  const money = (minor: number) => formatMoney(minor, refund.currency);
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [deductionTypeId, setDeductionTypeId] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);

  const apply = (lines: AllocationLine[]) => {
    setAmounts(Object.fromEntries(lines.map((l) => [l.blId, formatAmount(l.amountMinor)])));
    setDeductionTypeId(null);
  };

  const state = useMemo(() => {
    const lines = rows
      .map((c) => ({ candidate: c, amountMinor: amounts[c.blId] ? parseAmountInput(amounts[c.blId]) : null }))
      .filter((l) => l.amountMinor !== null && l.amountMinor !== 0);
    const invalid = lines.some((l) => l.amountMinor === null || l.amountMinor! < 0 || l.amountMinor! > l.candidate.expectedMinor);
    const short = lines.filter((l) => l.amountMinor! < l.candidate.expectedMinor);
    const total = lines.reduce((sum, l) => sum + (l.amountMinor ?? 0), 0);
    const remainder = refund.remainderMinor - total;
    const problems: string[] = [];
    if (invalid) problems.push(t("allocations.review.lineInvalid"));
    if (short.length > 1) problems.push(t("allocations.review.oneDifference"));
    if (remainder < 0) problems.push(t("allocations.errors.exceedsRefund"));
    if (short.length === 1 && deductionTypeId === null) problems.push(t("allocations.review.chooseType"));
    if (remainder > 0 && reason.trim() === "") problems.push(t("allocations.errors.remainderReason"));
    if (lines.length === 0) problems.push(t("allocations.review.nothingChosen"));
    const shortfall = short.length === 1 ? { line: short[0], amountMinor: short[0].candidate.expectedMinor - short[0].amountMinor! } : null;
    return { lines, total, remainder, shortfall, problems };
  }, [amounts, rows, deductionTypeId, reason, refund.remainderMinor]);

  const confirm = async () => {
    const result = await confirmAllocationAction({
      refundId: refund.id,
      lines: state.lines.map((l) => ({ blId: l.candidate.blId, amountMinor: l.amountMinor! })),
      shortfall: state.shortfall ? { blId: state.shortfall.line.candidate.blId, amountMinor: state.shortfall.amountMinor, deductionTypeId: deductionTypeId! } : null,
      remainderReason: state.remainder > 0 ? reason : null,
    });
    if (!result.ok) {
      setConfirming(false);
      return void toast.error(t(result.error, result.params));
    }
    toast.success(t("allocations.review.confirmed", { count: result.data.length }));
    router.push("/allocations");
    router.refresh();
  };

  const blNo = (blId: number) => rows.find((c) => c.blId === blId)?.blNo ?? String(blId);
  const typeName = deductionTypes.find((d) => d.id === deductionTypeId)?.name ?? "";

  return (
    <div className="flex flex-col gap-4">
      <Link href="/allocations" className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline">
        <ArrowLeft className="size-4" /> {t("allocations.back")}
      </Link>
      <header className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <h1 className="text-lg font-semibold">
          {refund.agencyName} · {money(refund.amountMinor)}
        </h1>
        <span>
          {t("refunds.customer")}: {refund.customerName ?? t("common.none")}
        </span>
        <span>
          {t("refunds.valueDate")}: {formatBusinessDate(refund.valueDate)}
        </span>
        <span>
          {t("allocations.review.toAllocate")}: <strong className="tabular">{money(refund.remainderMinor)}</strong>
        </span>
        <a href={`/api/files/${refund.evidenceDocumentId}`} target="_blank" rel="noreferrer" className="text-sm underline">
          {t("payments.receipt")}
        </a>
      </header>

      {candidates.length === 0 ? (
        <Alert>
          <AlertDescription>{t("allocations.review.noCandidates")}</AlertDescription>
        </Alert>
      ) : (
        <section className="flex flex-col gap-2">
          <h2 className="font-semibold">{t("allocations.review.suggestions")}</h2>
          {suggestions.incomplete && <p className="text-amber-700 text-sm dark:text-amber-400">{t("allocations.review.incomplete")}</p>}
          <div className="flex flex-wrap gap-3">
            {suggestions.exact.map((combo, i) => (
              <SuggestionCard
                key={`exact-${i}`}
                title={t("allocations.review.exact", { n: i + 1 })}
                lines={combo.map((l) => `${blNo(l.blId)} · ${money(l.amountMinor)}`)}
                footer={t("allocations.review.noDifference")}
                onUse={() => apply(combo)}
              />
            ))}
            <SuggestionCard
              title={t("allocations.review.fifo")}
              lines={suggestions.fifo.lines.map((l) => `${blNo(l.blId)} · ${money(l.amountMinor)}`)}
              footer={
                suggestions.fifo.shortfall
                  ? t("allocations.review.differenceOn", { amount: money(suggestions.fifo.shortfall.amountMinor), bl: blNo(suggestions.fifo.shortfall.blId) })
                  : suggestions.fifo.remainderMinor > 0
                    ? t("allocations.review.leftOver", { amount: money(suggestions.fifo.remainderMinor) })
                    : t("allocations.review.noDifference")
              }
              onUse={() => apply(suggestions.fifo.lines)}
            />
          </div>
        </section>
      )}

      {otherCandidates.length > 0 && (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setShowOthers((v) => !v)}>
          {showOthers ? t("allocations.review.hideOthers") : t("allocations.review.showOthers", { count: otherCandidates.length })}
        </Button>
      )}

      {rows.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-semibold">{t("allocations.review.split")}</h2>
          <table className="tabular w-full max-w-4xl">
            <thead className="text-muted-foreground text-left text-xs">
              <tr>
                <th className="py-1 font-normal">{t("bls.blNo")}</th>
                <th className="py-1 font-normal">{t("allocations.review.firstRequest")}</th>
                <th className="py-1 text-right font-normal">{t("bls.deposit")}</th>
                <th className="py-1 text-right font-normal">{t("bls.expected")}</th>
                <th className="py-1 text-right font-normal">{t("allocations.review.allocate")}</th>
                <th className="py-1 text-right font-normal">{t("allocations.review.difference")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const amount = amounts[c.blId] ? parseAmountInput(amounts[c.blId]) : null;
                const diff = amount !== null && amount > 0 ? c.expectedMinor - amount : 0;
                return (
                  <tr key={c.blId} className="border-t">
                    <td className="py-1">
                      <Link href={`/bls/${c.blId}`} className="font-mono hover:underline">
                        {c.blNo}
                      </Link>
                      {refund.customerId !== null && c.customerId !== refund.customerId && (
                        <span className="text-muted-foreground ml-2 text-xs">{c.customerName ?? t("allocations.review.noCustomer")}</span>
                      )}
                      {c.disputedEntryId !== null && (
                        <Badge variant="destructive" className="ml-2" title={t("allocations.review.disputedHint")}>
                          {t("allocations.review.disputedDifference")}
                        </Badge>
                      )}
                    </td>
                    <td className="py-1">{formatBusinessDate(c.firstRequestOn)}</td>
                    <td className="py-1 text-right">{money(c.depositMinor)}</td>
                    <td className="py-1 text-right">{money(c.expectedMinor)}</td>
                    <td className="py-1 text-right">
                      <Input
                        aria-label={`${t("allocations.review.allocate")} – ${c.blNo}`}
                        inputMode="decimal"
                        className="ml-auto h-8 w-36 text-right"
                        value={amounts[c.blId] ?? ""}
                        disabled={!canConfirm}
                        onChange={(e) => setAmounts((a) => ({ ...a, [c.blId]: e.target.value }))}
                        onDoubleClick={() => setAmounts((a) => ({ ...a, [c.blId]: formatAmount(c.expectedMinor) }))}
                      />
                    </td>
                    <td className={cn("py-1 text-right", diff !== 0 && "text-amber-700 dark:text-amber-400")}>{diff !== 0 ? money(diff) : ""}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t font-medium">
                <td className="py-1" colSpan={4}>
                  {t("allocations.review.total")}
                </td>
                <td className="py-1 text-right">{money(state.total)}</td>
                <td />
              </tr>
              <tr>
                <td className="py-1" colSpan={4}>
                  {t("allocations.review.remainder")}
                </td>
                <td className={cn("py-1 text-right", state.remainder !== 0 && "text-amber-700 dark:text-amber-400")}>{money(state.remainder)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
          <p className="text-muted-foreground text-xs">{t("allocations.review.splitHint")}</p>

          {state.shortfall && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
              <span>
                {t("allocations.review.differenceRow", { amount: money(state.shortfall.amountMinor), bl: state.shortfall.line.candidate.blNo })}
              </span>
              <select
                aria-label={t("allocations.review.deductionType")}
                className="border-input bg-background h-9 rounded-md border px-2"
                value={deductionTypeId ?? ""}
                onChange={(e) => setDeductionTypeId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">{t("allocations.review.deductionType")}</option>
                {deductionTypes.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              {deductionTypes.find((d) => d.id === deductionTypeId)?.code === "UNEXPLAINED" && (
                <Badge variant="outline">{t("allocations.review.staysOpen")}</Badge>
              )}
            </div>
          )}
          {state.remainder > 0 && (
            <div className="flex max-w-2xl flex-col gap-1.5">
              <label htmlFor="remainder-reason" className="text-sm font-medium">
                {t("allocations.review.remainderReason")}
              </label>
              <textarea
                id="remainder-reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="border-input bg-background rounded-md border px-2 py-1 text-sm"
              />
            </div>
          )}
          {state.problems.length > 0 && (
            <ul className="text-muted-foreground list-disc pl-5 text-sm">
              {state.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {canConfirm && (
            <div>
              <Button disabled={state.problems.length > 0} onClick={() => setConfirming(true)}>
                {t("allocations.review.confirm")}
              </Button>
            </div>
          )}
        </section>
      )}

      {confirming && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirming(false)}
          title={t("allocations.review.confirmTitle")}
          description={t("allocations.review.confirmText", { amount: money(state.total) })}
          items={[
            ...state.lines.map((l) => `${l.candidate.blNo} · ${money(l.amountMinor!)}`),
            ...(state.shortfall ? [t("allocations.review.differenceRow", { amount: money(state.shortfall.amountMinor), bl: state.shortfall.line.candidate.blNo }) + ` · ${typeName}`] : []),
            ...(state.remainder > 0 ? [t("allocations.review.leftOver", { amount: money(state.remainder) })] : []),
          ]}
          confirmLabel={t("allocations.review.confirm")}
          onConfirm={confirm}
        />
      )}
    </div>
  );
}

function SuggestionCard({ title, lines, footer, onUse }: { title: string; lines: string[]; footer: string; onUse: () => void }) {
  return (
    <div className="flex w-72 flex-col gap-2 rounded-md border p-3">
      <div className="font-medium">{title}</div>
      <ul className="font-mono text-xs">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <div className="text-muted-foreground text-xs">{footer}</div>
      <Button size="sm" variant="outline" onClick={onUse} disabled={lines.length === 0}>
        {t("allocations.review.use")}
      </Button>
    </div>
  );
}
