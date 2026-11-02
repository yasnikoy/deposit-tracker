"use client";

import { useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { t } from "@/i18n";

/**
 * The two toggles of the accounting record lists (payments and refunds): records entered by
 * the viewer only, and voided records. Every accountant sees all records; only the owner
 * corrects or voids one (rule 7).
 */
export function useRecordFilters<T extends { createdBy: number; voidedAt: string | null }>(records: T[], currentUserId: number) {
  const [onlyMine, setOnlyMine] = useState(false);
  const [showVoided, setShowVoided] = useState(false);
  const shown = useMemo(
    () => records.filter((r) => (showVoided || !r.voidedAt) && (!onlyMine || r.createdBy === currentUserId)),
    [records, showVoided, onlyMine, currentUserId],
  );
  const toolbar = (
    <div className="flex items-center gap-4 text-sm">
      <label className="flex items-center gap-2">
        <Checkbox checked={onlyMine} onCheckedChange={(checked) => setOnlyMine(checked === true)} />
        {t("payments.onlyMine")}
      </label>
      <label className="flex items-center gap-2">
        <Checkbox checked={showVoided} onCheckedChange={(checked) => setShowVoided(checked === true)} />
        {t("payments.showVoided")}
      </label>
    </div>
  );
  return { shown, toolbar };
}
