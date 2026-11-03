import { Badge } from "@/components/ui/badge";
import type { BlStatus } from "@/domain/records";
import { t } from "@/i18n";

/** Status chip of a B/L. */
export function BlStatusBadge({ status, voided, voidReason }: { status: BlStatus; voided?: boolean; voidReason?: string | null }) {
  if (voided) {
    return (
      <Badge variant="destructive" title={voidReason ?? undefined}>
        {t("bls.voidedBadge")}
      </Badge>
    );
  }
  return <Badge variant={STATUS_VARIANT[status] ?? "outline"}>{t(`bls.statuses.${status}`)}</Badge>;
}

/**
 * One colour scheme for every status chip: outline for the normal course, amber where
 * someone has to act, red for a problem, grey once closed.
 */
const STATUS_VARIANT: Partial<Record<BlStatus, "warning" | "destructive" | "secondary">> = {
  DUE: "warning",
  DEDUCTION_OPEN: "warning",
  ACCOUNTING_PENDING: "warning",
  DISPUTED: "destructive",
  COLLECTED: "secondary",
  TRANSFERRED: "secondary",
};
