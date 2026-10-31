"use client";

import { FileText, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { DataTable } from "@/components/data-table/data-table";
import { dataTableColumns } from "@/components/data-table/features";
import { FileDrop, uploadErrorText } from "@/components/file-drop";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PAYMENT_KINDS, type PaymentKind } from "@/domain/records";
import { t, type TranslationKey } from "@/i18n";
import { formatBusinessDate } from "@/lib/format";
import { formatAmount, formatMoney } from "@/lib/money";
import type { TableLayout } from "@/lib/schemas/table-layout";
import type { RefundListItem } from "@/server/refunds";
import { MyRefunds, RefundForm } from "./refunds-tab";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/server/errors";
import type { PaymentListItem, QueueItem } from "@/server/payments";
import { BlQuickCreate } from "../bls/bl-quick-create";
import { blCandidatesOf } from "../bls/bl-warnings";
import { discardQueueItemAction, voidPaymentAction } from "./actions";
import { CorrectPaymentDialog } from "./correct-payment-dialog";
import { EvidenceDrop } from "./evidence-drop";
import { PaymentForm, type ReferenceData, type SavedPayment } from "./payment-form";

export type AccountingTab = "new" | "queue" | "records" | "refund" | "refunds";

type Status = "awaitingBl" | "hasBl" | "voided";
const statusOf = (p: PaymentListItem): Status => (p.voidedAt ? "voided" : p.blId ? "hasBl" : "awaitingBl");

export function AccountingScreen({
  tab,
  refs,
  payments,
  refunds,
  queue,
  layout,
  refundsLayout,
  canCreateBl,
}: {
  tab: AccountingTab;
  refs: ReferenceData;
  payments: PaymentListItem[];
  refunds: RefundListItem[];
  queue: QueueItem[];
  layout: TableLayout | null;
  refundsLayout: TableLayout | null;
  canCreateBl: boolean;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState<SavedPayment | null>(null);
  const [formKey, setFormKey] = useState(0);

  const afterSave = (payment: SavedPayment) => {
    router.refresh();
    // An additional deposit joined its B/L already: there is no B/L to create.
    if (canCreateBl && !payment.additionalTo) setSaved(payment);
    else setFormKey((k) => k + 1);
  };
  const startOver = () => {
    setSaved(null);
    setFormKey((k) => k + 1);
  };

  const tabs: { id: AccountingTab; label: string }[] = [
    { id: "new", label: t("payments.newTitle") },
    { id: "queue", label: `${t("payments.queueTitle")}${queue.length ? ` (${queue.length})` : ""}` },
    { id: "records", label: t("payments.myRecords") },
    { id: "refund", label: t("refunds.newTitle") },
    { id: "refunds", label: t("refunds.myRefunds") },
  ];

  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-1 border-b">
        {tabs.map((item) => (
          <Link
            key={item.id}
            href={`/accounting?tab=${item.id}`}
            aria-current={tab === item.id ? "page" : undefined}
            className={cn("-mb-px border-b-2 px-3 py-1.5", tab === item.id ? "border-primary font-medium" : "border-transparent")}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {saved && (tab === "new" || tab === "queue") ? (
        <Continuation saved={saved} refs={refs} onDone={startOver} />
      ) : tab === "new" ? (
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle>{t("payments.newTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <PaymentForm key={formKey} refs={refs} onSaved={afterSave} />
          </CardContent>
        </Card>
      ) : tab === "queue" ? (
        <ReviewQueue queue={queue} refs={refs} onSaved={afterSave} />
      ) : tab === "refund" ? (
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle>{t("refunds.newTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <RefundForm
              key={formKey}
              refs={refs}
              onSaved={() => {
                router.refresh();
                setFormKey((k) => k + 1);
              }}
            />
          </CardContent>
        </Card>
      ) : tab === "refunds" ? (
        <MyRefunds refunds={refunds} refs={refs} layout={refundsLayout} />
      ) : (
        <MyRecords payments={payments} refs={refs} layout={layout} />
      )}
    </div>
  );
}

/** Dual-role users continue from the saved payment straight to its B/L. */
function Continuation({ saved, refs, onDone }: { saved: SavedPayment; refs: ReferenceData; onDone: () => void }) {
  const agency = refs.agencies.find((a) => a.id === saved.agencyId);
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>{t("payments.continueToBl")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <BlQuickCreate
          paymentId={saved.id}
          candidates={blCandidatesOf({ blNoHint: saved.blNoHint, extractedBlNumbers: saved.blCandidates })}
          patterns={agency?.blNumberPatterns ?? []}
          onCreated={onDone}
        />
        <Button variant="ghost" className="self-start" onClick={onDone}>
          {t("payments.newTitle")}
        </Button>
      </CardContent>
    </Card>
  );
}

function ReviewQueue({ queue, refs, onSaved }: { queue: QueueItem[]; refs: ReferenceData; onSaved: (payment: SavedPayment) => void }) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = queue.find((q) => q.id === selectedId) ?? queue[0] ?? null;

  return (
    <div className="flex items-start gap-4">
      <div className="flex w-80 shrink-0 flex-col gap-3">
        <FileDrop
          kind="RECEIPT"
          multiple
          queue
          label={t("files.dropMany")}
          onUploaded={(results) => {
            const ok = results.filter((r) => r.response.ok).length;
            for (const r of results) if (!r.response.ok) toast.error(`${r.file.name}: ${uploadErrorText(r.response)}`);
            if (ok) toast.success(t("payments.queueAdded", { count: ok }));
            router.refresh();
          }}
        />
        <p className="text-muted-foreground text-xs">
          {queue.length ? t("payments.queueCount", { count: queue.length }) : t("payments.queueEmpty")}
        </p>
        <ul className="flex flex-col gap-1">
          {queue.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setSelectedId(item.id)}
                className={cn("hover:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1 text-left", selected?.id === item.id && "bg-muted font-medium")}
              >
                <FileText className="size-4 shrink-0" />
                <span className="truncate">{item.originalName}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {selected && (
        <Card className="max-w-2xl flex-1">
          <CardHeader className="flex flex-row items-center gap-2">
            <CardTitle className="truncate">{selected.originalName}</CardTitle>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={async () => {
                const result = await discardQueueItemAction({ id: selected.id });
                if (!result.ok) return void toast.error(t(result.error, result.params));
                toast.success(t("payments.discarded"));
                setSelectedId(null);
                router.refresh();
              }}
            >
              {t("payments.discard")}
            </Button>
          </CardHeader>
          <CardContent>
            <PaymentForm
              key={selected.id}
              refs={refs}
              evidence={{ id: selected.documentId, originalName: selected.originalName }}
              queueItemId={selected.id}
              prefill={selected.prefill}
              onSaved={(payment) => {
                setSelectedId(null);
                onSaved(payment);
              }}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

type RecordDialog = { kind: "correct"; payment: PaymentListItem } | { kind: "void"; payment: PaymentListItem } | null;

const STATUS_LABEL: Record<Status, TranslationKey> = {
  awaitingBl: "payments.statuses.awaitingBl",
  hasBl: "payments.statuses.hasBl",
  voided: "payments.statuses.voided",
};

function MyRecords({ payments, refs, layout }: { payments: PaymentListItem[]; refs: ReferenceData; layout: TableLayout | null }) {
  const router = useRouter();
  const [showVoided, setShowVoided] = useState(false);
  const [dialog, setDialog] = useState<RecordDialog>(null);
  const shown = useMemo(() => (showVoided ? payments : payments.filter((p) => !p.voidedAt)), [payments, showVoided]);

  const finish = (result: ActionResult<void>, success: TranslationKey) => {
    if (!result.ok) return void toast.error(t(result.error, result.params));
    toast.success(t(success));
    setDialog(null);
    router.refresh();
  };

  const columns = useMemo(() => {
    const col = dataTableColumns<PaymentListItem>();
    return col.columns([
      col.accessor("paidAt", {
        meta: { label: "payments.paidAt", toText: (v) => formatBusinessDate(v as string) },
        sortFn: "basic",
        cell: ({ getValue }) => formatBusinessDate(getValue()),
      }),
      col.accessor("agencyName", { meta: { label: "payments.agency", filter: "text" }, sortFn: "turkishText" }),
      col.accessor("amountMinor", {
        meta: { label: "payments.amount", align: "end", toText: (v) => formatAmount(v as number) },
        sortFn: "basic",
        cell: ({ getValue }) => formatAmount(getValue()),
      }),
      col.accessor("currency", { meta: { label: "payments.currency", filter: "text" }, sortFn: "turkishText" }),
      col.accessor("kind", {
        meta: {
          label: "payments.kind",
          toText: (v) => t(`payments.kinds.${v as PaymentKind}`),
          filter: { options: PAYMENT_KINDS.map((k) => ({ value: k, label: `payments.kinds.${k}` as const })) },
        },
        cell: ({ getValue }) => t(`payments.kinds.${getValue()}`),
      }),
      col.accessor((p) => p.blNo ?? "", {
        id: "blNo",
        meta: { label: "payments.bl", filter: "text" },
        // Accountants see linked B/L numbers read-only, with a copy button.
        cell: ({ row }) =>
          row.original.blNo ? (
            <span className="inline-flex items-center gap-1 font-mono">
              {row.original.blNo}
              <CopyButton value={row.original.blNo} />
            </span>
          ) : null,
      }),
      col.accessor(statusOf, {
        id: "status",
        meta: {
          label: "payments.status",
          toText: (v) => t(STATUS_LABEL[v as Status]),
          filter: { options: (Object.keys(STATUS_LABEL) as Status[]).map((s) => ({ value: s, label: STATUS_LABEL[s] })) },
        },
        cell: ({ row }) => {
          const status = statusOf(row.original);
          return (
            <Badge variant={status === "voided" ? "destructive" : status === "hasBl" ? "secondary" : "outline"} title={row.original.voidReason ?? undefined}>
              {t(STATUS_LABEL[status])}
            </Badge>
          );
        },
      }),
      col.display({
        id: "actions",
        meta: { label: "common.actions", searchable: false },
        enableHiding: false,
        cell: ({ row }) => {
          const payment = row.original;
          return (
            <div className="flex items-center" onClick={(event) => event.stopPropagation()}>
              {payment.evidenceDocumentId !== null ? (
                <Button asChild variant="ghost" size="icon" className="size-7" aria-label={t("payments.receipt")}>
                  <a href={`/api/files/${payment.evidenceDocumentId}`} target="_blank" rel="noreferrer">
                    <FileText />
                  </a>
                </Button>
              ) : (
                !payment.voidedAt && <EvidenceDrop paymentId={payment.id} kind={payment.kind} compact />
              )}
              {!payment.voidedAt && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-7" aria-label={t("common.actions")}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setDialog({ kind: "correct", payment })}>{t("payments.correct")}</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => setDialog({ kind: "void", payment })}>
                      {t("payments.void")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          );
        },
      }),
    ]);
  }, []);

  return (
    <>
      <DataTable
        tableId="my-payments"
        data={shown}
        columns={columns}
        getRowId={(p) => String(p.id)}
        initialLayout={layout}
        rowClassName={(p) => (p.voidedAt ? "text-muted-foreground line-through" : undefined)}
        toolbar={
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={showVoided} onCheckedChange={(checked) => setShowVoided(checked === true)} />
            {t("payments.showVoided")}
          </label>
        }
      />
      {dialog?.kind === "correct" && (
        <CorrectPaymentDialog
          payment={dialog.payment}
          refs={refs}
          onCancel={() => setDialog(null)}
          onDone={(result) => result.ok && finish(result, "payments.corrected")}
        />
      )}
      {dialog?.kind === "void" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t("payments.voidTitle")}
          description={t("payments.voidText", {
            agency: dialog.payment.agencyName,
            amount: formatMoney(dialog.payment.amountMinor, dialog.payment.currency),
            date: formatBusinessDate(dialog.payment.paidAt),
          })}
          confirmLabel={t("payments.void")}
          destructive
          requireReason
          onConfirm={async (reason) => finish(await voidPaymentAction({ id: dialog.payment.id, reason }), "payments.voided")}
        />
      )}
    </>
  );
}
