"use client";

import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { blNotOnReceipt, isValidBlNumber, normalizeBlNumber } from "@/domain/bl-number";
import { t } from "@/i18n";
import { formatBusinessDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import type { BlJoinPreview, DuplicateCandidate } from "@/server/payments";
import { previewBlJoinAction } from "./actions";

/**
 * Checks shared by the deposit forms (payment and opening balance): what the typed B/L number
 * joins, and the warnings the user confirms before saving.
 */

/** The existing B/L the typed number would add to, looked up while typing. */
export function useBlJoinPreview(blNoText: string, agencyId: number | null, currency: string): BlJoinPreview | null {
  const blNo = normalizeBlNumber(blNoText);
  const lookup = isValidBlNumber(blNo) ? blNo : "";
  const [found, setFound] = useState<{ key: string; preview: BlJoinPreview | null } | null>(null);
  const key = `${lookup}|${agencyId}|${currency}`;

  useEffect(() => {
    if (!lookup) return;
    let current = true;
    const timer = setTimeout(async () => {
      const result = await previewBlJoinAction({ blNo: lookup, agencyId, currency });
      if (current) setFound({ key, preview: result.ok ? result.data : null });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [lookup, agencyId, currency, key]);

  return lookup && found?.key === key ? found.preview : null;
}

/** Shown under the B/L number: the deposit adds to this B/L (previous → new amount), or why it cannot. */
export function BlJoinNotice({ preview, amountMinor, children }: { preview: BlJoinPreview | null; amountMinor: number | null; children?: React.ReactNode }) {
  if (!preview) return null;
  if (preview.problem) {
    const key = preview.problem === "closed" ? "payments.errors.additionalClosed" : "payments.errors.additionalMismatch";
    return (
      <p role="alert" data-testid="bl-join-notice" className="text-destructive text-xs">
        {t(key, { bl: preview.blNo })}
      </p>
    );
  }
  const from = formatMoney(preview.depositMinor, preview.currency);
  return (
    <div data-testid="bl-join-notice" className="rounded-md border border-sky-300 bg-sky-50 px-2 py-1.5 text-xs text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100">
      <p className="font-medium">
        {amountMinor !== null
          ? t("blJoin.adds", { bl: preview.blNo, from, to: formatMoney(preview.depositMinor + amountMinor, preview.currency) })
          : t("blJoin.addsNoAmount", { bl: preview.blNo, from })}
      </p>
      {children}
    </div>
  );
}

/** Inline hint while typing: the B/L number is not among those read from the receipt. */
export function ReceiptMismatchHint({ blNo, candidates }: { blNo: string; candidates: string[] }) {
  if (!blNotOnReceipt(blNo, candidates)) return null;
  return <p className="text-xs text-amber-700 dark:text-amber-400">{t("blJoin.mismatchHint", { list: candidates.join(", ") })}</p>;
}

const duplicateLine = (d: DuplicateCandidate) =>
  `${d.blNo ? t("payments.duplicateOpening", { bl: d.blNo }) : `#${d.id}`} · ${d.agencyName} · ${formatMoney(d.amountMinor, d.currency)} · ${formatBusinessDate(d.paidAt)}`;

type Pending =
  | { kind: "mismatch"; blNo: string; candidates: string[]; proceed: () => Promise<void> }
  | { kind: "duplicate"; duplicates: DuplicateCandidate[]; proceed: () => Promise<void> };

/**
 * The confirmations of a deposit save: first the B/L number that is not on the receipt
 * (checked here), then a possible duplicate (reported by the server). Render `dialog`.
 */
export function useDepositConfirmations() {
  const [pending, setPending] = useState<Pending | null>(null);

  /** Runs `proceed` at once, or after the user confirms a B/L number the receipt does not name. */
  const checkReceiptMatch = (blNo: string, candidates: string[], proceed: () => Promise<void>) =>
    blNotOnReceipt(blNo, candidates) ? setPending({ kind: "mismatch", blNo: normalizeBlNumber(blNo), candidates, proceed }) : proceed();

  const confirmDuplicates = (duplicates: DuplicateCandidate[], proceed: () => Promise<void>) => setPending({ kind: "duplicate", duplicates, proceed });

  const run = async () => {
    const next = pending;
    setPending(null);
    await next?.proceed();
  };

  const dialog =
    pending?.kind === "mismatch" ? (
      <ConfirmDialog
        open
        onOpenChange={(open) => !open && setPending(null)}
        title={t("blJoin.mismatchTitle")}
        description={t("blJoin.mismatchText", { list: pending.candidates.join(", "), bl: pending.blNo })}
        confirmLabel={t("blJoin.mismatchConfirm")}
        onConfirm={run}
      />
    ) : pending?.kind === "duplicate" ? (
      <ConfirmDialog
        open
        onOpenChange={(open) => !open && setPending(null)}
        title={t("payments.duplicateTitle")}
        description={t("payments.duplicateText")}
        items={pending.duplicates.map(duplicateLine)}
        confirmLabel={t("payments.duplicateConfirm")}
        onConfirm={run}
      />
    ) : null;

  return { checkReceiptMatch, confirmDuplicates, dialog };
}
