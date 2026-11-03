"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import type { BlRowError } from "@/server/bls";
import { createBlsAction } from "./actions";
import { blNoWarnings } from "./bl-warnings";

/** One B/L from one payment: the continuous flow for users with both roles. */
export function BlQuickCreate({
  paymentId,
  candidates,
  patterns,
  onCreated,
}: {
  paymentId: number;
  candidates: string[];
  patterns: string[];
  onCreated: (blNo: string) => void;
}) {
  const [blNo, setBlNo] = useState(candidates.length === 1 ? candidates[0] : "");
  const [errors, setErrors] = useState<BlRowError[]>([]);
  const [busy, setBusy] = useState(false);
  const warnings = blNoWarnings(blNo, patterns);

  const save = async () => {
    setBusy(true);
    const result = await createBlsAction({ rows: [{ paymentId, blNo }] });
    setBusy(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));
    setErrors(result.data.errors);
    const created = result.data.created[0];
    if (created) {
      toast.success(t("bls.createdOne", { bl: created.blNo }));
      onCreated(created.blNo);
    }
  };

  const errorFor = (field: BlRowError["field"]) => errors.find((e) => e.field === field);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="quick-bl-no">{t("bls.blNo")}</Label>
        <Input id="quick-bl-no" className="uppercase" value={blNo} onChange={(event) => setBlNo(event.target.value)} autoFocus />
        {candidates.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {candidates.map((candidate) => (
              <Button key={candidate} type="button" size="sm" variant="outline" onClick={() => setBlNo(candidate)}>
                {t("bls.useCandidate", { bl: candidate })}
              </Button>
            ))}
          </div>
        )}
        {errorFor("blNo") && <p role="alert" className="text-destructive text-xs">{t(errorFor("blNo")!.message)}</p>}
        {errorFor("payment") && <p role="alert" className="text-destructive text-xs">{t(errorFor("payment")!.message)}</p>}
      </div>
      {warnings.map((warning) => (
        <p key={warning} className="text-xs text-amber-700 dark:text-amber-400">
          {warning}
        </p>
      ))}
      <div className="flex justify-end">
        <Button onClick={save} disabled={busy || blNo.trim() === ""}>
          {t("bls.createOne")}
        </Button>
      </div>
    </div>
  );
}
