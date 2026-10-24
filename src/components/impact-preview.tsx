"use client";

import { useEffect, useState } from "react";
import { previewImpactAction } from "@/app/(app)/requests/actions";
import { t } from "@/i18n";
import type { DueImpact, SettingsHypothesis } from "@/server/requests";

const DEBOUNCE_MS = 300;

/** Before a timing or calendar change is saved: how many B/Ls move into or out of the request lists. */
export function ImpactPreview({ hypothesis }: { hypothesis: SettingsHypothesis | null }) {
  const [impact, setImpact] = useState<DueImpact | null>(null);
  const key = JSON.stringify(hypothesis);

  useEffect(() => {
    if (!hypothesis) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await previewImpactAction(hypothesis);
      if (!cancelled) setImpact(result.ok ? result.data : null);
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // The serialized key stands for the hypothesis object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!hypothesis || !impact) return null;
  const lists = (["DUE", "UPCOMING"] as const).filter((list) => impact[list].entering + impact[list].leaving > 0);
  return (
    <div role="status" className="bg-muted/50 rounded-md border px-3 py-2 text-xs">
      <div className="font-medium">{t("impact.title")}</div>
      {lists.length === 0 ? (
        <div className="text-muted-foreground">{t("impact.none")}</div>
      ) : (
        lists.map((list) => <div key={list}>{t(`impact.${list}`, impact[list])}</div>)
      )}
    </div>
  );
}
