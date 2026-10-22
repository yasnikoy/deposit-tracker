"use client";

import { useState } from "react";
import { useForm, useWatch, type FieldErrors, type Resolver } from "react-hook-form";
import { AgencyCombobox } from "@/components/agency-combobox";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isTranslationKey, t } from "@/i18n";
import { formatAmount, formatMoney, parseAmountInput } from "@/lib/money";
import { correctPaymentSchema } from "@/lib/schemas/payments";
import type { ActionResult } from "@/server/errors";
import type { PaymentListItem } from "@/server/payments";
import { correctPaymentAction } from "./actions";
import type { ReferenceData } from "./payment-form";

type Values = { agencyId: number | null; amountText: string; currency: string; paidAt: string; reason: string };

/** Accountant corrects an own payment with a reason; a linked B/L follows on the server. */
export function CorrectPaymentDialog({
  payment,
  refs,
  onDone,
  onCancel,
}: {
  payment: PaymentListItem;
  refs: ReferenceData;
  onDone: (result: ActionResult<void>) => void;
  onCancel: () => void;
}) {
  const [serverError, setServerError] = useState<string | null>(null);
  const toInput = (v: Values) => ({
    id: payment.id,
    agencyId: v.agencyId,
    amountMinor: parseAmountInput(v.amountText) ?? Number.NaN,
    currency: v.currency,
    paidAt: v.paidAt,
    reason: v.reason,
  });
  const resolver: Resolver<Values> = async (values) => {
    const parsed = correctPaymentSchema.safeParse(toInput(values));
    if (parsed.success) return { values, errors: {} };
    const errors: FieldErrors<Values> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]);
      const field = (key === "amountMinor" ? "amountText" : key) as keyof Values;
      if (!errors[field]) errors[field] = { type: "validation", message: isTranslationKey(issue.message) ? issue.message : "errors.validation" };
    }
    return { values: {}, errors };
  };
  const form = useForm<Values>({
    resolver,
    defaultValues: {
      agencyId: payment.agencyId,
      amountText: formatAmount(payment.amountMinor),
      currency: payment.currency,
      paidAt: payment.paidAt,
      reason: "",
    },
  });
  const [agencyId, currency, amountText] = useWatch({ control: form.control, name: ["agencyId", "currency", "amountText"] });
  const amount = parseAmountInput(amountText);
  const { errors, isSubmitting } = form.formState;
  const message = (key?: string) =>
    key ? (
      <p role="alert" className="text-destructive text-xs">
        {isTranslationKey(key) ? t(key) : key}
      </p>
    ) : null;

  const onSubmit = form.handleSubmit(async (values) => {
    const result = await correctPaymentAction(toInput(values));
    if (!result.ok) setServerError(t(result.error, result.params));
    onDone(result);
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("payments.correctTitle")}</DialogTitle>
        </DialogHeader>
        <form id="correct-payment" onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="correct-agency">{t("payments.agency")}</Label>
            <AgencyCombobox
              id="correct-agency"
              agencies={refs.agencies}
              value={agencyId}
              onChange={(id) => form.setValue("agencyId", id)}
              placeholder={t("payments.agencySearch")}
            />
            {message(errors.agencyId?.message)}
          </div>
          <div className="grid grid-cols-[1fr_7rem_10rem] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="correct-amount">{t("payments.amount")}</Label>
              <Input id="correct-amount" className="tabular" {...form.register("amountText")} />
              {amount !== null && <span className="text-muted-foreground text-xs">{formatMoney(amount, currency)}</span>}
              {message(errors.amountText?.message)}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="correct-currency">{t("payments.currency")}</Label>
              <select id="correct-currency" className="border-input bg-background h-9 rounded-md border px-2" {...form.register("currency")}>
                {refs.currencies
                  .filter((c) => c.active || c.code === payment.currency)
                  .map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="correct-date">{t("payments.paidAt")}</Label>
              <Input id="correct-date" type="date" max={refs.today} {...form.register("paidAt")} />
              {message(errors.paidAt?.message)}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="correct-reason">{t("common.reasonRequired")}</Label>
            <textarea id="correct-reason" rows={2} className="border-input bg-background rounded-md border px-2 py-1" {...form.register("reason")} />
            {message(errors.reason?.message)}
          </div>
          {serverError && (
            <p role="alert" className="text-destructive text-sm">
              {serverError}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={isSubmitting}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="correct-payment" disabled={isSubmitting}>
            {t("payments.correct")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
