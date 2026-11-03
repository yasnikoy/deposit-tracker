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
  units,
  payment,
  onCreated,
}: {
  paymentId: number;
  candidates: string[];
  patterns: string[];
  /** The agency's active units; one is required when it has any. */
  units: { id: number; name: string }[];
  /** What the B/L takes over from its payment, shown read-only. */
  payment: { customerName: string | null; fileNo: string | null; description: string | null };
  onCreated: (blNo: string) => void;
}) {
  const [blNo, setBlNo] = useState(candidates.length === 1 ? candidates[0] : "");
  const [unitId, setUnitId] = useState<number | null>(null);
  const [errors, setErrors] = useState<BlRowError[]>([]);
  const [busy, setBusy] = useState(false);
  const warnings = blNoWarnings(blNo, patterns);

  const save = async () => {
    setBusy(true);
    const result = await createBlsAction({ rows: [{ paymentId, blNo, unitId }] });
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
      <PaymentCarryOver {...payment} />
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
      {units.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="quick-unit">{t("bls.unit")}</Label>
          <select
            id="quick-unit"
            className="border-input bg-background h-9 rounded-md border px-2"
            value={unitId ?? ""}
            onChange={(event) => setUnitId(event.target.value ? Number(event.target.value) : null)}
          >
            <option value="">{t("bls.unitPick")}</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          {errorFor("unit") && <p role="alert" className="text-destructive text-xs">{t(errorFor("unit")!.message)}</p>}
        </div>
      )}
      {warnings.map((warning) => (
        <p key={warning} className="text-xs text-amber-700 dark:text-amber-400">
          {warning}
        </p>
      ))}
      <div className="flex justify-end">
        <Button onClick={save} disabled={busy || blNo.trim() === "" || (units.length > 0 && unitId === null)}>
          {t("bls.createOne")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The customer, file number and description the accountant entered on the payment, which the
 * new B/L takes over; read-only here (the B/L detail changes them afterwards).
 */
export function PaymentCarryOver({ customerName, fileNo, description }: { customerName: string | null; fileNo: string | null; description: string | null }) {
  if (!customerName && !fileNo && !description) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
      {customerName && (
        <>
          <dt className="text-muted-foreground">{t("bls.customer")}</dt>
          <dd>{customerName}</dd>
        </>
      )}
      {fileNo && (
        <>
          <dt className="text-muted-foreground">{t("bls.fileNo")}</dt>
          <dd className="font-mono">{fileNo}</dd>
        </>
      )}
      {description && (
        <>
          <dt className="text-muted-foreground">{t("description.title")}</dt>
          <dd className="whitespace-pre-line">{description}</dd>
        </>
      )}
    </dl>
  );
}
