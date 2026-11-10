"use client";

import { FileText } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { AgencyCombobox } from "@/components/agency-combobox";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table/data-table";
import { useRecordFilters } from "./record-filters";
import { dataTableColumns } from "@/components/data-table/features";
import { FileDrop, uploadErrorText } from "@/components/file-drop";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PAYMENT_KINDS, type PaymentKind } from "@/domain/records";
import { isTranslationKey, t, type TranslationKey } from "@/i18n";
import { formatBusinessDate } from "@/lib/format";
import { formatAmount, formatMoney, parseAmountInput } from "@/lib/money";
import { correctRefundSchema, createRefundSchema } from "@/lib/schemas/refunds";
import type { TableLayout } from "@/lib/schemas/table-layout";
import type { ActionResult } from "@/server/errors";
import type { DuplicateCandidate } from "@/server/payments";
import type { RefundListItem, RefundStatus } from "@/server/refunds";
import { correctRefundAction, createRefundAction, voidRefundAction } from "./actions";
import { EvidenceDrop } from "./evidence-drop";
import type { ReferenceData } from "./payment-form";
import { CustomerCombobox } from "@/components/customer-combobox";

type Fields = { agencyId: number | null; customerId: number | null; amountText: string; currency: string; valueDate: string };

const firstError = (issues: { message: string }[]) => {
  const key = issues[0]?.message;
  return key && isTranslationKey(key) ? t(key) : t("errors.validation");
};

/** Agency, amount, currency and value date, shared by the new-refund form and the correction. */
function RefundFields({ refs, values, onChange, idPrefix }: { refs: ReferenceData; values: Fields; onChange: (v: Fields) => void; idPrefix: string }) {
  const amount = parseAmountInput(values.amountText);
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-agency`}>{t("payments.agency")}</Label>
        <AgencyCombobox
          id={`${idPrefix}-agency`}
          agencies={refs.agencies}
          value={values.agencyId}
          onChange={(agencyId) => onChange({ ...values, agencyId })}
          placeholder={t("payments.agencySearch")}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-customer`}>{t("refunds.customer")}</Label>
        <CustomerCombobox
          id={`${idPrefix}-customer`}
          customers={refs.customers}
          value={values.customerId}
          onChange={(customerId) => onChange({ ...values, customerId })}
          placeholder={t("refunds.customerSearch")}
        />
      </div>
      <div className="grid grid-cols-[1fr_8rem_10rem] gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-amount`}>{t("payments.amount")}</Label>
          <Input
            id={`${idPrefix}-amount`}
            inputMode="decimal"
            placeholder="6.300,00"
            className="tabular"
            value={values.amountText}
            onChange={(e) => onChange({ ...values, amountText: e.target.value })}
          />
          {amount !== null && <span className="text-muted-foreground text-xs">{formatMoney(amount, values.currency)}</span>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-currency`}>{t("payments.currency")}</Label>
          <select
            id={`${idPrefix}-currency`}
            className="border-input bg-background h-9 rounded-md border px-2"
            value={values.currency}
            onChange={(e) => onChange({ ...values, currency: e.target.value })}
          >
            {refs.currencies
              .filter((c) => c.active || c.code === values.currency)
              .map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-date`}>{t("refunds.valueDate")}</Label>
          <Input id={`${idPrefix}-date`} type="date" max={refs.today} value={values.valueDate} onChange={(e) => onChange({ ...values, valueDate: e.target.value })} />
        </div>
      </div>
    </>
  );
}

/** A new incoming refund (bank receipt) or offset (invoice); the evidence is optional (rule 12). */
export function RefundForm({ refs, onSaved }: { refs: ReferenceData; onSaved: () => void }) {
  const [kind, setKind] = useState<PaymentKind>("BANK");
  const [evidence, setEvidence] = useState<{ id: number; originalName: string } | null>(null);
  const [values, setValues] = useState<Fields>({
    agencyId: null,
    customerId: null,
    amountText: "",
    currency: refs.currencies.find((c) => c.active)?.code ?? "",
    valueDate: refs.today,
  });
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);

  const input = (confirmDuplicate: boolean) => ({
    agencyId: values.agencyId,
    customerId: values.customerId,
    amountMinor: parseAmountInput(values.amountText) ?? Number.NaN,
    currency: values.currency,
    valueDate: values.valueDate,
    kind,
    evidenceDocumentId: evidence?.id ?? null,
    confirmDuplicate,
  });

  const submit = async (confirmDuplicate: boolean) => {
    const parsed = createRefundSchema.safeParse(input(confirmDuplicate));
    if (!parsed.success) return setError(firstError(parsed.error.issues));
    setBusy(true);
    const result = await createRefundAction(input(confirmDuplicate));
    setBusy(false);
    if (!result.ok) return setError(t(result.error, result.params));
    if (result.data.status === "duplicate") return setDuplicates(result.data.duplicates);
    setDuplicates(null);
    toast.success(t("refunds.saved"));
    onSaved();
  };

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        setError(null);
        void submit(false);
      }}
      noValidate
      className="flex flex-col gap-4"
    >
      <fieldset className="flex gap-4">
        <legend className="mb-1 text-sm font-medium">{t("payments.kind")}</legend>
        {PAYMENT_KINDS.map((k) => (
          <label key={k} className="flex items-center gap-1.5">
            <input
              type="radio"
              name="refund-kind"
              checked={kind === k}
              onChange={() => {
                setKind(k);
                setEvidence(null);
              }}
            />
            {t(`refunds.kinds.${k}`)}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <Label>
          {t(`payments.evidence.${kind}`)} <span className="text-muted-foreground font-normal">{t("payments.evidenceOptional")}</span>
        </Label>
        {evidence ? (
          <div className="flex items-center gap-2">
            <a href={`/api/files/${evidence.id}`} target="_blank" rel="noreferrer" className="underline">
              {evidence.originalName}
            </a>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEvidence(null)}>
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
              setEvidence(result.response.document!);
              const p = result.response.prefill;
              if (p) {
                setValues((v) => ({
                  ...v,
                  agencyId: p.agencyIds.length === 1 ? p.agencyIds[0] : v.agencyId,
                  customerId: p.customerId ?? v.customerId,
                  amountText: p.amountMinor ? formatAmount(p.amountMinor) : v.amountText,
                  currency: p.currency ?? v.currency,
                  valueDate: p.paidAt ?? v.valueDate,
                }));
              }
            }}
          />
        )}
      </div>
      <RefundFields refs={refs} values={values} onChange={setValues} idPrefix="refund" />
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {t("refunds.save")}
        </Button>
      </div>
      {duplicates && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDuplicates(null)}
          title={t("payments.duplicateTitle")}
          description={t("refunds.duplicateText")}
          items={duplicates.map((d) => `#${d.id} · ${d.agencyName} · ${formatMoney(d.amountMinor, d.currency)} · ${formatBusinessDate(d.paidAt)}`)}
          confirmLabel={t("payments.duplicateConfirm")}
          onConfirm={() => submit(true)}
        />
      )}
    </form>
  );
}

const STATUS_VARIANT: Record<RefundStatus, "outline" | "secondary"> = {
  OPEN: "outline",
  PARTIALLY_ALLOCATED: "outline",
  ALLOCATED: "secondary",
  REMAINDER_LEFT: "secondary",
};

type RecordDialog = { kind: "correct" | "void"; refund: RefundListItem } | null;

/** The accountant's own refunds with their computed status; correct or void while unallocated. */
/** Every refund record; corrections, voids and a missing receipt stay with the one who entered it. */
export function RefundRecords({ refunds, refs, layout, currentUserId }: { refunds: RefundListItem[]; refs: ReferenceData; layout: TableLayout | null; currentUserId: number }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<RecordDialog>(null);
  const { shown, toolbar } = useRecordFilters(refunds, currentUserId);

  const finish = (result: ActionResult<void>, success: TranslationKey) => {
    if (!result.ok) return void toast.error(t(result.error, result.params));
    toast.success(t(success));
    setDialog(null);
    router.refresh();
  };

  const columns = useMemo(() => {
    const col = dataTableColumns<RefundListItem>();
    return col.columns([
      col.accessor("valueDate", {
        meta: { label: "refunds.valueDate", toText: (v) => formatBusinessDate(v as string) },
        sortFn: "basic",
        cell: ({ getValue }) => formatBusinessDate(getValue()),
      }),
      col.accessor("agencyName", { meta: { label: "payments.agency", filter: "text" }, sortFn: "turkishText" }),
      col.accessor((r) => r.customerName ?? "", { id: "customer", meta: { label: "refunds.customer", filter: "text" }, sortFn: "turkishText" }),
      col.accessor("amountMinor", {
        meta: { label: "payments.amount", align: "end", toText: (v) => formatAmount(v as number) },
        sortFn: "basic",
        cell: ({ getValue }) => formatAmount(getValue()),
      }),
      col.accessor("remainderMinor", {
        meta: { label: "refunds.remainder", align: "end", toText: (v) => formatAmount(v as number) },
        sortFn: "basic",
        cell: ({ getValue }) => formatAmount(getValue()),
      }),
      col.accessor("currency", { meta: { label: "payments.currency", filter: "text" }, sortFn: "turkishText" }),
      col.accessor("createdByName", { meta: { label: "payments.createdBy", filter: "text" }, sortFn: "turkishText" }),
      col.accessor("kind", {
        meta: { label: "payments.kind", toText: (v) => t(`refunds.kinds.${v as PaymentKind}`) },
        cell: ({ getValue }) => t(`refunds.kinds.${getValue()}`),
      }),
      col.accessor((r) => (r.voidedAt ? "VOIDED" : r.status), {
        id: "status",
        meta: { label: "payments.status", toText: (v) => (v === "VOIDED" ? t("payments.statuses.voided") : t(`refunds.statuses.${v as RefundStatus}`)) },
        cell: ({ row }) =>
          row.original.voidedAt ? (
            <Badge variant="destructive" title={row.original.voidReason ?? undefined}>
              {t("payments.statuses.voided")}
            </Badge>
          ) : (
            <Badge variant={STATUS_VARIANT[row.original.status]} title={row.original.unallocatedReason ?? undefined}>
              {t(`refunds.statuses.${row.original.status}`)}
            </Badge>
          ),
      }),
      col.display({
        id: "actions",
        meta: { label: "common.actions", searchable: false },
        enableHiding: false,
        cell: ({ row }) => {
          const refund = row.original;
          const own = refund.createdBy === currentUserId;
          return (
            <div className="flex items-center" onClick={(event) => event.stopPropagation()}>
              {refund.evidenceDocumentId !== null ? (
                <Button asChild variant="ghost" size="icon" className="size-7" aria-label={t("payments.receipt")}>
                  <a href={`/api/files/${refund.evidenceDocumentId}`} target="_blank" rel="noreferrer">
                    <FileText />
                  </a>
                </Button>
              ) : (
                own && !refund.voidedAt && <EvidenceDrop refundId={refund.id} kind={refund.kind} compact />
              )}
              {own && !refund.voidedAt && refund.allocatedMinor === 0 && (
                // Visible, not in a menu: users looked for them and did not find them.
                <span className="ml-1 flex gap-1">
                  <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setDialog({ kind: "correct", refund })}>
                    {t("payments.correct")}
                  </Button>
                  <Button variant="outline" size="sm" className="text-destructive h-6 px-2 text-xs" onClick={() => setDialog({ kind: "void", refund })}>
                    {t("payments.void")}
                  </Button>
                </span>
              )}
            </div>
          );
        },
      }),
    ]);
  }, [currentUserId]);

  return (
    <>
      <DataTable
        tableId="my-refunds"
        data={shown}
        columns={columns}
        getRowId={(r) => String(r.id)}
        initialLayout={layout}
        rowClassName={(r) => (r.voidedAt ? "text-muted-foreground line-through" : undefined)}
        toolbar={toolbar}
      />
      {dialog?.kind === "correct" && (
        <CorrectRefundDialog refund={dialog.refund} refs={refs} onCancel={() => setDialog(null)} onDone={(result) => finish(result, "refunds.corrected")} />
      )}
      {dialog?.kind === "void" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t("refunds.voidTitle")}
          description={t("payments.voidText", {
            agency: dialog.refund.agencyName,
            amount: formatMoney(dialog.refund.amountMinor, dialog.refund.currency),
            date: formatBusinessDate(dialog.refund.valueDate),
          })}
          confirmLabel={t("payments.void")}
          destructive
          requireReason
          onConfirm={async (reason) => finish(await voidRefundAction({ id: dialog.refund.id, reason }), "refunds.voided")}
        />
      )}
    </>
  );
}

function CorrectRefundDialog({
  refund,
  refs,
  onCancel,
  onDone,
}: {
  refund: RefundListItem;
  refs: ReferenceData;
  onCancel: () => void;
  onDone: (result: ActionResult<void>) => void;
}) {
  const [values, setValues] = useState<Fields>({
    agencyId: refund.agencyId,
    customerId: refund.customerId,
    amountText: formatAmount(refund.amountMinor),
    currency: refund.currency,
    valueDate: refund.valueDate,
  });
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const input = { id: refund.id, ...values, amountMinor: parseAmountInput(values.amountText) ?? Number.NaN, reason };
    const parsed = correctRefundSchema.safeParse(input);
    if (!parsed.success) return setError(firstError(parsed.error.issues));
    const result = await correctRefundAction(input);
    if (!result.ok) return setError(t(result.error, result.params));
    onDone(result);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("refunds.correctTitle")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <RefundFields refs={refs} values={values} onChange={setValues} idPrefix="refund-correct" />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="refund-correct-reason">{t("common.reasonRequired")}</Label>
            <textarea
              id="refund-correct-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="border-input bg-background rounded-md border px-2 py-1 text-sm"
            />
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save}>{t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
