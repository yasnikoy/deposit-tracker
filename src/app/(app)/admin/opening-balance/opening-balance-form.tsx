"use client";

import Link from "next/link";
import { useState } from "react";
import { useForm, useWatch, type FieldErrors, type Resolver } from "react-hook-form";
import { toast } from "sonner";
import { AgencyCombobox } from "@/components/agency-combobox";
import { FileDrop, uploadErrorText } from "@/components/file-drop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseContainerList } from "@/domain/containers";
import { PAYMENT_KINDS, type PaymentKind } from "@/domain/records";
import { isTranslationKey, t } from "@/i18n";
import { formatMoney, parseAmountInput } from "@/lib/money";
import { openingBalanceSchema } from "@/lib/schemas/opening-balances";
import type { ReferenceData } from "../../accounting/payment-form";
import { createOpeningBalanceAction } from "./actions";

type FormValues = {
  kind: PaymentKind;
  agencyId: number | null;
  amountText: string;
  currency: string;
  paidAt: string;
  blNo: string;
  containersText: string;
  pastAttempts: string;
  lastRequestOn: string;
  note: string;
};

/** Schema fields shown under another form field. */
const FIELD_OF: Record<string, keyof FormValues | "receipt"> = { amountMinor: "amountText", containers: "containersText", documentId: "receipt" };

/** An open Excel record moved into the app: the deposit with its original receipt, and the requests made so far. */
export function OpeningBalanceForm({ refs }: { refs: ReferenceData }) {
  const activeCurrencies = refs.currencies.filter((c) => c.active);
  const [receipt, setReceipt] = useState<{ id: number; originalName: string } | null>(null);
  const [created, setCreated] = useState<{ id: number; blNo: string }[]>([]);

  const toInput = (values: FormValues) => ({
    agencyId: values.agencyId,
    kind: values.kind,
    amountMinor: parseAmountInput(values.amountText) ?? Number.NaN,
    currency: values.currency,
    paidAt: values.paidAt,
    blNo: values.blNo,
    containers: parseContainerList(values.containersText),
    documentId: receipt?.id ?? null,
    pastAttempts: Number(values.pastAttempts),
    lastRequestOn: values.lastRequestOn || null,
    note: values.note,
  });

  const resolver: Resolver<FormValues> = async (values) => {
    const parsed = openingBalanceSchema.safeParse(toInput(values));
    if (parsed.success) return { values, errors: {} };
    const errors: FieldErrors<FormValues & { receipt: string }> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]);
      const field = (FIELD_OF[key] ?? key) as keyof FormValues | "receipt";
      if (!errors[field]) errors[field] = { type: "validation", message: isTranslationKey(issue.message) ? issue.message : "errors.validation" };
    }
    return { values: {}, errors: errors as FieldErrors<FormValues> };
  };

  const blank: FormValues = {
    kind: "BANK",
    agencyId: null,
    amountText: "",
    currency: activeCurrencies[0]?.code ?? "",
    paidAt: "",
    blNo: "",
    containersText: "",
    pastAttempts: "1",
    lastRequestOn: "",
    note: "",
  };
  const form = useForm<FormValues>({ resolver, defaultValues: blank });
  const errors = form.formState.errors as FieldErrors<FormValues & { receipt: string }>;
  const [kind, agencyId, amountText, currency, pastAttempts] = useWatch({ control: form.control, name: ["kind", "agencyId", "amountText", "currency", "pastAttempts"] });
  const amount = parseAmountInput(amountText);

  const onSubmit = form.handleSubmit(async (values) => {
    const result = await createOpeningBalanceAction(toInput(values));
    if (!result.ok) return void toast.error(t(result.error, result.params));
    toast.success(t("openingBalances.saved"));
    setCreated((list) => [{ id: result.data, blNo: values.blNo.toUpperCase().replace(/\s+/g, "") }, ...list]);
    // Ready for the next record; agency and currency usually repeat.
    form.reset({ ...blank, agencyId: values.agencyId, currency: values.currency });
    setReceipt(null);
  });

  const message = (key?: string) =>
    key ? (
      <p role="alert" className="text-destructive text-xs">
        {isTranslationKey(key) ? t(key) : key}
      </p>
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={onSubmit} noValidate className="flex max-w-3xl flex-col gap-4">
        <fieldset className="flex gap-4">
          <legend className="mb-1 text-sm font-medium">{t("payments.kind")}</legend>
          {PAYMENT_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                value={k}
                checked={kind === k}
                onChange={() => {
                  form.setValue("kind", k);
                  setReceipt(null); // the evidence type depends on the kind
                }}
              />
              {t(`payments.kinds.${k}`)}
            </label>
          ))}
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <Label>{t(`openingBalances.receipt.${kind}`)}</Label>
          {receipt ? (
            <div className="flex items-center gap-2">
              <a href={`/api/files/${receipt.id}`} target="_blank" rel="noreferrer" className="underline">
                {receipt.originalName}
              </a>
              <Button type="button" variant="ghost" size="sm" onClick={() => setReceipt(null)}>
                {t("files.change")}
              </Button>
            </div>
          ) : (
            <FileDrop
              kind={kind === "BANK" ? "RECEIPT" : "INVOICE"}
              label={t("files.drop")}
              onUploaded={([result]) => {
                if (!result) return;
                if (!result.response.ok) return void toast.error(uploadErrorText(result.response));
                setReceipt(result.response.document ?? null);
              }}
            />
          )}
          {message(errors.receipt?.message)}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="opening-agency">{t("payments.agency")}</Label>
          <AgencyCombobox
            id="opening-agency"
            agencies={refs.agencies}
            value={agencyId}
            onChange={(id) => form.setValue("agencyId", id, { shouldValidate: form.formState.isSubmitted })}
            placeholder={t("payments.agencySearch")}
            invalid={!!errors.agencyId}
          />
          {message(errors.agencyId?.message)}
        </div>

        <div className="grid grid-cols-[1fr_8rem_10rem] gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opening-amount">{t("openingBalances.amount")}</Label>
            <Input id="opening-amount" inputMode="decimal" placeholder="3.000,00" className="tabular" {...form.register("amountText")} />
            {amount !== null && <span className="text-muted-foreground text-xs">{formatMoney(amount, currency)}</span>}
            {message(errors.amountText?.message)}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opening-currency">{t("payments.currency")}</Label>
            <select id="opening-currency" className="border-input bg-background h-9 rounded-md border px-2" {...form.register("currency")}>
              {activeCurrencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </select>
            {message(errors.currency?.message)}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opening-paid-at">{t("payments.paidAt")}</Label>
            <Input id="opening-paid-at" type="date" max={refs.today} {...form.register("paidAt")} />
            {message(errors.paidAt?.message)}
          </div>
        </div>

        <div className="grid grid-cols-[14rem_1fr] gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opening-bl-no">{t("bls.blNo")}</Label>
            <Input id="opening-bl-no" className="font-mono uppercase" {...form.register("blNo")} />
            {message(errors.blNo?.message)}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opening-containers">{t("bls.containers")}</Label>
            <Input id="opening-containers" className="font-mono uppercase" placeholder="MSCU1234565, CSQU3054383" {...form.register("containersText")} />
            {message(errors.containersText?.message)}
          </div>
        </div>

        <div className="grid grid-cols-[14rem_14rem] gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opening-attempts">{t("openingBalances.pastAttempts")}</Label>
            <Input id="opening-attempts" type="number" min={0} max={50} className="w-24" {...form.register("pastAttempts")} />
            {message(errors.pastAttempts?.message)}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opening-last-request">{t("openingBalances.lastRequestOn")}</Label>
            <Input id="opening-last-request" type="date" max={refs.today} disabled={pastAttempts === "0"} {...form.register("lastRequestOn")} />
            {message(errors.lastRequestOn?.message)}
          </div>
        </div>
        <p className="text-muted-foreground -mt-2 text-xs">{t("openingBalances.attemptsHelp")}</p>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="opening-note">{t("openingBalances.note")}</Label>
          <Input id="opening-note" placeholder={t("openingBalances.notePlaceholder")} {...form.register("note")} />
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t("openingBalances.save")}
          </Button>
        </div>
      </form>

      {created.length > 0 && (
        <section className="flex flex-col gap-1">
          <h2 className="font-semibold">{t("openingBalances.createdNow")}</h2>
          <ul className="flex flex-wrap gap-3">
            {created.map((bl) => (
              <li key={bl.id}>
                <Link href={`/bls/${bl.id}`} className="font-mono underline">
                  {bl.blNo}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
