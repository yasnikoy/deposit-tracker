import { Badge } from "@/components/ui/badge";
import type { BlStatus } from "@/domain/records";
import { t } from "@/i18n";

/** Status chip; labels and colours become configurable with the status list in settings. */
export function BlStatusBadge({ status, voided, voidReason }: { status: BlStatus; voided?: boolean; voidReason?: string | null }) {
  if (voided) {
    return (
      <Badge variant="destructive" title={voidReason ?? undefined}>
        {t("bls.voidedBadge")}
      </Badge>
    );
  }
  return <Badge variant="outline">{t(`bls.statuses.${status}`)}</Badge>;
}
