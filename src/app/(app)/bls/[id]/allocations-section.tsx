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
import { cn } from "@/lib/utils";
import type { BlAllocation } from "@/server/bl-overview";
import { reverseAllocationAction } from "../../allocations/actions";

/** Refund allocations on this B/L; an admin reverses a confirmed one with a reason (rule 8). */
export function AllocationsSection({ blNo, allocations, canReverse }: { blNo: string; allocations: BlAllocation[]; canReverse: boolean }) {
  const router = useRouter();
  const [reversing, setReversing] = useState<BlAllocation | null>(null);

  if (allocations.length === 0) return <p className="text-muted-foreground">{t("blAllocations.none")}</p>;
  return (
    <>
      <ul className="flex flex-col gap-2">
        {allocations.map((a) => (
          <li key={a.id} className={cn("flex flex-wrap items-center gap-2", a.state === "REVERSED" && "text-muted-foreground")}>
            <span className={cn("tabular font-medium", a.state === "REVERSED" && "line-through")}>{formatMoney(a.amountMinor, a.currency)}</span>
            <span className="text-sm">
              {t("blAllocations.refund", { id: a.refundId, date: formatBusinessDate(a.valueDate) })}
            </span>
            <span className="text-muted-foreground text-xs">
              {formatTimestamp(a.confirmedAt)} · {a.confirmedByName}
            </span>
            {a.state === "REVERSED" ? (
              <Badge variant="outline" title={a.reversalReason ?? undefined}>
                {t("blAllocations.reversed")}
              </Badge>
            ) : (
              canReverse && (
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => setReversing(a)}>
                  {t("blAllocations.reverse")}
                </Button>
              )
            )}
            {a.reversalReason && <div className="w-full text-xs italic">{a.reversalReason}</div>}
          </li>
        ))}
      </ul>
      {reversing && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setReversing(null)}
          title={t("blAllocations.reverseTitle")}
          description={t("blAllocations.reverseText", { amount: formatMoney(reversing.amountMinor, reversing.currency), bl: blNo })}
          confirmLabel={t("blAllocations.reverse")}
          destructive
          requireReason
          onConfirm={async (reason) => {
            const result = await reverseAllocationAction({ allocationId: reversing.id, reason });
            if (!result.ok) return void toast.error(t(result.error, result.params));
            toast.success(t("blAllocations.reversedToast"));
            setReversing(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
