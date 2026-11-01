"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm, useWatch, type FieldErrors, type Resolver } from "react-hook-form";
import { toast } from "sonner";
import { AgencyCombobox } from "@/components/agency-combobox";
import { CustomerCombobox } from "@/components/customer-combobox";
import { FileDrop, uploadErrorText, type UploadResponse } from "@/components/file-drop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseContainerList } from "@/domain/containers";
import { PAYMENT_KINDS, type PaymentKind } from "@/domain/records";
import { isTranslationKey, t } from "@/i18n";
import { formatAmount, formatMoney, parseAmountInput } from "@/lib/money";
import { openingBalanceSchema } from "@/lib/schemas/opening-balances";
import { cn } from "@/lib/utils";
import type { ReferenceData } from "../../accounting/payment-form";
import { createOpeningBalanceAction } from "./actions";

type FormValues = {
  kind: PaymentKind;
  agencyId: number | null;
  newAgencyName: string | null;
  customerId: number | null;
  newCustomerName: string | null;
  amountText: string;
  currency: string;
  paidAt: string;
  blNo: string;
  fileNo: string;
  containersText: string;
  pastAttempts: string;
  lastRequestOn: string;
  note: string;
};

type Prefill = NonNullable<Extract<UploadResponse, { ok: true }>["prefill"]>;
/** An uploaded receipt waiting to be entered, with what the app read from it. */
type QueuedReceipt = { id: number; originalName: string; prefill: Prefill | null; read: boolean };

/** Schema fields shown under another form field. */
const FIELD_OF: Record<string, keyof FormValues> = { amountMinor: "amountText", containers: "containersText", newAgencyName: "agencyId", newCustomerName: "customerId" };

/**
 * Open Excel records moved into the app one after another. Receipts dropped together wait in a
 * queue and fill the form one by one; the kind, agency, customer and currency carry over to
 * the next record, so usually only the amount, dates and B/L number change.
 */
export function OpeningBalanceForm({ refs }: { refs: ReferenceData }) {
  const { customers } = refs;
  const router = useRouter();
  const activeCurrencies = refs.currencies.filter((c) => c.active);
  const [receipt, setReceipt] = useState<QueuedReceipt | null>(null);
  const [queue, setQueue] = useState<QueuedReceipt[]>([]);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [created, setCreated] = useState<{ id: number; blNo: string }[]>([]);

  const toInput = (values: FormValues) => ({
    agencyId: values.agencyId,
    newAgencyName: values.newAgencyName,
    customerId: values.customerId,
    newCustomerName: values.newCustomerName,
    kind: values.kind,
    amountMinor: parseAmountInput(values.amountText) ?? Number.NaN,
    currency: values.currency,
    paidAt: values.paidAt,
    blNo: values.blNo,
    fileNo: values.fileNo,
    containers: parseContainerList(values.containersText),
    documentId: receipt?.id ?? null,
    pastAttempts: Number(values.pastAttempts),
    lastRequestOn: values.lastRequestOn || null,
    note: values.note,
  });

  const resolver: Resolver<FormValues> = async (values) => {
    const parsed = openingBalanceSchema.safeParse(toInput(values));
    if (parsed.success) return { values, errors: {} };
    const errors: FieldErrors<FormValues> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]);
      const field = (FIELD_OF[key] ?? key) as keyof FormValues;
      if (!errors[field]) errors[field] = { type: "validation", message: isTranslationKey(issue.message) ? issue.message : "errors.validation" };
    }
    return { values: {}, errors };
  };

  const blank: FormValues = {
    kind: "BANK",
    agencyId: null,
    newAgencyName: null,
    customerId: null,
    newCustomerName: null,
    amountText: "",
    currency: activeCurrencies[0]?.code ?? "",
    paidAt: "",
    blNo: "",
    fileNo: "",
    containersText: "",
    pastAttempts: "0",
    lastRequestOn: "",
    note: "",
  };
  const form = useForm<FormValues>({ resolver, defaultValues: blank });
  const errors = form.formState.errors;
  const [kind, agencyId, newAgencyName, customerId, newCustomerName, amountText, currency, pastAttempts] = useWatch({
    control: form.control,
    name: ["kind", "agencyId", "newAgencyName", "customerId", "newCustomerName", "amountText", "currency", "pastAttempts"],
  });
  const amount = parseAmountInput(amountText);
  const isKnownAgency = (name: string) => refs.agencies.some((a) => a.name.toLocaleLowerCase("tr-TR") === name.toLocaleLowerCase("tr-TR"));

  /** Puts a receipt on the form: what it reads overrides, the rest stays as carried over. */
  const load = (next: QueuedReceipt | null) => {
    setReceipt(next);
    const p = next?.prefill;
    setCandidates(p?.blCandidates ?? []);
    if (!p) return;
    if (p.agencyIds.length === 1) {
      form.setValue("agencyId", p.agencyIds[0]);
      form.setValue("newAgencyName", null);
    }
    if (p.customerId !== null) {
      form.setValue("customerId", p.customerId);
      form.setValue("newCustomerName", null);
    }
    if (p.amountMinor) form.setValue("amountText", formatAmount(p.amountMinor));
    if (p.currency) form.setValue("currency", p.currency);
    if (p.paidAt) form.setValue("paidAt", p.paidAt);
    if (p.blCandidates.length > 0) form.setValue("blNo", p.blCandidates[0]);
    if (p.fileNo) form.setValue("fileNo", p.fileNo);
  };

  const onUploaded = (results: { file: File; response: UploadResponse }[]) => {
    const added: QueuedReceipt[] = [];
    for (const { response } of results) {
      if (!response.ok) {
        toast.error(uploadErrorText(response));
        continue;
      }
      if (response.document) added.push({ ...response.document, prefill: response.prefill ?? null, read: response.parser === "garanti" });
    }
    if (added.length === 0) return;
    if (receipt) setQueue((q) => [...q, ...added]);
    else {
      load(added[0]);
      setQueue((q) => [...q, ...added.slice(1)]);
    }
  };

  /** Takes a queued receipt onto the form; the one there goes back to the queue. */
  const pick = (item: QueuedReceipt) => {
    setQueue((q) => [...q.filter((r) => r.id !== item.id), ...(receipt ? [receipt] : [])]);
    load(item);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    const result = await createOpeningBalanceAction(toInput(values));
    if (!result.ok) return void toast.error(t(result.error, result.params));
    toast.success(t("openingBalances.saved"));
    if (values.newAgencyName && !isKnownAgency(values.newAgencyName)) toast.info(t("payments.newAgencyAdded", { name: values.newAgencyName }));
    setCreated((list) => [{ id: result.data, blNo: values.blNo.toUpperCase().replace(/\s+/g, "") }, ...list]);
    // The next record: kind, agency, customer and currency carry over; a new agency or customer is now registered.
    form.reset({
      ...blank,
      kind: values.kind,
      agencyId: values.agencyId,
      newAgencyName: values.newAgencyName,
      customerId: values.customerId,
      newCustomerName: values.newCustomerName,
      currency: values.currency,
    });
    router.refresh();
    const [next, ...rest] = queue;
    setQueue(rest);
    load(next ?? null);
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
                  // The evidence type depends on the kind.
                  setReceipt(null);
                  setQueue([]);
                }}
              />
              {t(`payments.kinds.${k}`)}
            </label>
          ))}
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <Label>
            {t(`openingBalances.receipt.${kind}`)} <span className="text-muted-foreground font-normal">{t("payments.evidenceOptional")}</span>
          </Label>
          {receipt && (
            <div className="flex items-center gap-2">
              <a href={`/api/files/${receipt.id}`} target="_blank" rel="noreferrer" className="underline">
                {receipt.originalName}
              </a>
              <Button type="button" variant="ghost" size="sm" onClick={() => load(null)}>
                {t("openingBalances.withoutReceipt")}
              </Button>
            </div>
          )}
          {receipt && !receipt.read && kind === "BANK" && <p className="text-muted-foreground text-xs">{t("payments.parserUnknown")}</p>}
          <FileDrop kind={kind === "BANK" ? "RECEIPT" : "INVOICE"} multiple compact={!!receipt} label={t("openingBalances.dropReceipts")} onUploaded={onUploaded} />
          {queue.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">{t("openingBalances.queue", { count: queue.length })}</span>
              <ul className="flex flex-wrap gap-2">
                {queue.map((item) => (
                  <li key={item.id} className="flex items-center rounded border text-xs">
                    <button type="button" className="px-2 py-1 hover:underline" onClick={() => pick(item)}>
                      {item.originalName}
                    </button>
                    <button
                      type="button"
                      aria-label={t("openingBalances.removeFromQueue", { name: item.originalName })}
                      className="text-muted-foreground hover:text-foreground px-1"
                      onClick={() => setQueue((q) => q.filter((r) => r.id !== item.id))}
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opening-agency">{t("payments.agency")}</Label>
            <AgencyCombobox
              id="opening-agency"
              agencies={refs.agencies}
              value={agencyId}
              onChange={(id) => form.setValue("agencyId", id, { shouldValidate: form.formState.isSubmitted })}
              newName={newAgencyName}
              onNewName={(name) => form.setValue("newAgencyName", name, { shouldValidate: form.formState.isSubmitted })}
              placeholder={t("payments.agencySearch")}
              invalid={!!errors.agencyId}
            />
            {newAgencyName && !isKnownAgency(newAgencyName) && <p className="text-muted-foreground text-xs">{t("openingBalances.newAgencyHelp")}</p>}
            {message(errors.agencyId?.message)}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opening-customer">
              {t("openingBalances.customer")} <span className="text-muted-foreground font-normal">{t("payments.evidenceOptional")}</span>
            </Label>
            <CustomerCombobox
              id="opening-customer"
              customers={customers}
              value={customerId}
              onChange={(id) => form.setValue("customerId", id)}
              newName={newCustomerName}
              onNewName={(name) => form.setValue("newCustomerName", name)}
              placeholder={t("openingBalances.customerSearch")}
              invalid={!!errors.customerId}
            />
            {newCustomerName && !customers.some((c) => c.name.toLocaleLowerCase("tr-TR") === newCustomerName.toLocaleLowerCase("tr-TR")) && (
              <p className="text-muted-foreground text-xs">{t("openingBalances.newCustomerHelp")}</p>
            )}
            {message(errors.customerId?.message)}
          </div>
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

        <div className="grid grid-cols-[14rem_10rem_1fr] gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opening-bl-no">{t("bls.blNo")}</Label>
            <Input id="opening-bl-no" className="font-mono uppercase" {...form.register("blNo")} />
            {candidates.length > 1 && (
              <p className="text-xs">
                {t("openingBalances.candidates")}{" "}
                {candidates.map((c) => (
                  <button key={c} type="button" className={cn("mr-1 font-mono underline")} onClick={() => form.setValue("blNo", c)}>
                    {c}
                  </button>
                ))}
              </p>
            )}
            {message(errors.blNo?.message)}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opening-file-no">{t("openingBalances.fileNo")}</Label>
            <Input id="opening-file-no" className="font-mono uppercase" {...form.register("fileNo")} />
            {message(errors.fileNo?.message)}
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
            {queue.length > 0 ? t("openingBalances.saveAndNext") : t("openingBalances.save")}
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
