"use client";

import { useState } from "react";
import { useForm, useWatch, type FieldErrors, type Resolver } from "react-hook-form";
import { toast } from "sonner";
import { AgencyCombobox, type AgencyOption } from "@/components/agency-combobox";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FileDrop, uploadErrorText } from "@/components/file-drop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PAYMENT_KINDS, type PaymentKind } from "@/domain/records";
import { isTranslationKey, t } from "@/i18n";
import { formatBusinessDate } from "@/lib/format";
import { formatAmount, formatMoney, parseAmountInput } from "@/lib/money";
import { createPaymentSchema } from "@/lib/schemas/payments";
import type { BankAccount, Currency } from "@/server/lists";
import type { DuplicateCandidate, PaymentPrefill } from "@/server/payments";
import { createPaymentAction } from "./actions";

export type ReferenceData = {
  agencies: AgencyOption[];
  currencies: Currency[];
  bankAccounts: BankAccount[];
  today: string;
};

type FormValues = {
  kind: PaymentKind;
  agencyId: number | null;
  amountText: string;
  currency: string;
  paidAt: string;
  bankAccountId: string;
  blNoHint: string;
};

const FIELD_OF: Record<string, keyof FormValues | "evidence"> = {
  amountMinor: "amountText",
  evidenceDocumentId: "evidence",
};

export type SavedPayment = { id: number; agencyId: number; blNoHint: string | null; blCandidates: string[] };

/**
 * Deposit payment form. In "new" mode the receipt or invoice is uploaded here;
 * in queue mode the receipt is already uploaded and comes with its queue item.
 */
export function PaymentForm({
  refs,
  evidence: fixedEvidence,
  queueItemId = null,
  prefill,
  onSaved,
}: {
  refs: ReferenceData;
  evidence?: { id: number; originalName: string };
  queueItemId?: number | null;
  prefill?: PaymentPrefill;
  onSaved: (payment: SavedPayment) => void;
}) {
  const activeCurrencies = refs.currencies.filter((c) => c.active);
  const [evidence, setEvidence] = useState(fixedEvidence ?? null);
  const [candidates, setCandidates] = useState<string[]>(prefill?.blCandidates ?? []);
  const [stubNotice, setStubNotice] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);

  const defaultAccount = (currency: string) => {
    const accounts = refs.bankAccounts.filter((a) => a.active && a.currency === currency);
    return accounts.length === 1 ? String(accounts[0].id) : "";
  };
  const initialCurrency = prefill?.currency ?? activeCurrencies[0]?.code ?? "";

  const toInput = (values: FormValues, confirmDuplicate = false) => ({
    agencyId: values.agencyId,
    amountMinor: parseAmountInput(values.amountText) ?? Number.NaN,
    currency: values.currency,
    paidAt: values.paidAt,
    kind: values.kind,
    bankAccountId: values.kind === "BANK" && values.bankAccountId ? Number(values.bankAccountId) : null,
    blNoHint: values.blNoHint,
    evidenceDocumentId: evidence?.id ?? null,
    queueItemId,
    confirmDuplicate,
  });

  const resolver: Resolver<FormValues> = async (values) => {
    const parsed = createPaymentSchema.safeParse(toInput(values));
    if (parsed.success) return { values, errors: {} };
    const errors: FieldErrors<FormValues & { evidence: string }> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]);
      const field = (FIELD_OF[key] ?? key) as keyof FormValues | "evidence";
      if (!errors[field]) errors[field] = { type: "validation", message: isTranslationKey(issue.message) ? issue.message : "errors.validation" };
    }
    return { values: {}, errors: errors as FieldErrors<FormValues> };
  };

  const form = useForm<FormValues>({
    resolver,
    defaultValues: {
      kind: "BANK",
      agencyId: prefill?.agencyIds.length === 1 ? prefill.agencyIds[0] : null,
      amountText: prefill?.amountMinor ? formatAmount(prefill.amountMinor) : "",
      currency: initialCurrency,
      paidAt: prefill?.paidAt ?? refs.today,
      bankAccountId: defaultAccount(initialCurrency),
      blNoHint: "",
    },
  });
  const errors = form.formState.errors as FieldErrors<FormValues & { evidence: string }>;
  const [kind, currency, amountText, agencyId] = useWatch({ control: form.control, name: ["kind", "currency", "amountText", "agencyId"] });
  const amount = parseAmountInput(amountText);
  const accounts = refs.bankAccounts.filter((a) => a.currency === currency && a.active);

  const submit = async (values: FormValues, confirmDuplicate: boolean) => {
    const result = await createPaymentAction(toInput(values, confirmDuplicate));
    if (!result.ok) {
      toast.error(t(result.error, result.params));
      return;
    }
    if (result.data.status === "duplicate") {
      setDuplicates(result.data.duplicates);
      return;
    }
    setDuplicates(null);
    toast.success(t("payments.saved"));
    onSaved({ id: result.data.id, agencyId: values.agencyId!, blNoHint: values.blNoHint.trim() || null, blCandidates: candidates });
  };
  const onSubmit = form.handleSubmit((values) => submit(values, false));

  const message = (key?: string) =>
    key ? (
      <p role="alert" className="text-destructive text-xs">
        {isTranslationKey(key) ? t(key) : key}
      </p>
    ) : null;

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      {!fixedEvidence && (
        <fieldset className="flex gap-4">
          <legend className="mb-1 text-sm font-medium">{t("payments.kind")}</legend>
          {PAYMENT_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-1.5">
              <input
                type="radio"
                value={k}
                checked={kind === k}
                onChange={() => {
                  form.setValue("kind", k);
                  setEvidence(null); // the evidence type depends on the kind
                }}
              />
              {t(`payments.kinds.${k}`)}
            </label>
          ))}
        </fieldset>
      )}

      <div className="flex flex-col gap-1.5">
        <Label>{t(`payments.evidence.${kind}`)}</Label>
        {evidence ? (
          <div className="flex items-center gap-2">
            <a href={`/api/files/${evidence.id}`} target="_blank" rel="noreferrer" className="underline">
              {evidence.originalName}
            </a>
            {!fixedEvidence && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setEvidence(null)}>
                {t("files.change")}
              </Button>
            )}
          </div>
        ) : (
          <FileDrop
            kind={kind === "BANK" ? "RECEIPT" : "INVOICE"}
            label={t("files.drop")}
            onUploaded={([result]) => {
              if (!result) return;
              if (!result.response.ok) return void toast.error(uploadErrorText(result.response));
              setEvidence(result.response.document!);
              const p = result.response.prefill;
              setStubNotice(result.response.parser === "stub");
              if (p) {
                if (p.agencyIds.length === 1) form.setValue("agencyId", p.agencyIds[0]);
                if (p.amountMinor) form.setValue("amountText", formatAmount(p.amountMinor));
                if (p.currency) form.setValue("currency", p.currency);
                if (p.paidAt) form.setValue("paidAt", p.paidAt);
                setCandidates(p.blCandidates);
              }
            }}
          />
        )}
        {stubNotice && <p className="text-muted-foreground text-xs">{t("payments.parserStub")}</p>}
        {message(errors.evidence?.message)}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="payment-agency">{t("payments.agency")}</Label>
        <AgencyCombobox
          id="payment-agency"
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
          <Label htmlFor="payment-amount">{t("payments.amount")}</Label>
          <Input id="payment-amount" inputMode="decimal" placeholder="3.000,00" className="tabular" {...form.register("amountText")} />
          {amount !== null && <span className="text-muted-foreground text-xs">{formatMoney(amount, currency)}</span>}
          {message(errors.amountText?.message)}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="payment-currency">{t("payments.currency")}</Label>
          <select
            id="payment-currency"
            className="border-input bg-background h-9 rounded-md border px-2"
            {...form.register("currency", {
              onChange: (event) => form.setValue("bankAccountId", defaultAccount(event.target.value)),
            })}
          >
            {activeCurrencies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}
              </option>
            ))}
          </select>
          {message(errors.currency?.message)}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="payment-date">{t("payments.paidAt")}</Label>
          <Input id="payment-date" type="date" max={refs.today} {...form.register("paidAt")} />
          {message(errors.paidAt?.message)}
        </div>
      </div>

      {kind === "BANK" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="payment-account">{t("payments.bankAccount")}</Label>
          <select id="payment-account" className="border-input bg-background h-9 rounded-md border px-2" {...form.register("bankAccountId")}>
            <option value="" />
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} – {a.iban}
              </option>
            ))}
          </select>
          {message(errors.bankAccountId?.message)}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="payment-hint">{t("payments.blNoHint")}</Label>
        <Input id="payment-hint" className="uppercase" {...form.register("blNoHint")} />
        <p className="text-muted-foreground text-xs">{t("payments.blNoHintHelp")}</p>
        {candidates.length > 0 && <p className="text-xs">{t("payments.blCandidates", { list: candidates.join(", ") })}</p>}
        {message(errors.blNoHint?.message)}
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {t("payments.save")}
        </Button>
      </div>

      {duplicates && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDuplicates(null)}
          title={t("payments.duplicateTitle")}
          description={t("payments.duplicateText")}
          items={duplicates.map((d) => `#${d.id} · ${d.agencyName} · ${formatMoney(d.amountMinor, d.currency)} · ${formatBusinessDate(d.paidAt)}`)}
          confirmLabel={t("payments.duplicateConfirm")}
          onConfirm={() => submit(form.getValues(), true)}
        />
      )}
    </form>
  );
}
