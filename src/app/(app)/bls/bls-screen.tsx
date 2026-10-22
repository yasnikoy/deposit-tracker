"use client";

import { MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ClipboardEvent } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table/data-table";
import { dataTableColumns } from "@/components/data-table/features";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseContainerList } from "@/domain/containers";
import type { BlStatus } from "@/domain/records";
import { t } from "@/i18n";
import { formatBusinessDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import type { TableLayout } from "@/lib/schemas/table-layout";
import { cn } from "@/lib/utils";
import type { BlListItem, BlRowError } from "@/server/bls";
import type { PaymentListItem } from "@/server/payments";
import { createBlsAction, updateBlAction, voidBlAction } from "./actions";
import { blCandidatesOf, blRowWarnings } from "./bl-warnings";

export type BlsTab = "awaiting" | "created";

export function BlsScreen({
  tab,
  payments,
  bls,
  patterns,
  layout,
}: {
  tab: BlsTab;
  payments: PaymentListItem[];
  bls: BlListItem[];
  patterns: Record<number, string[]>;
  layout: TableLayout | null;
}) {
  const tabs: { id: BlsTab; label: string }[] = [
    { id: "awaiting", label: `${t("bls.awaitingTab")}${payments.length ? ` (${payments.length})` : ""}` },
    { id: "created", label: t("bls.createdTab") },
  ];
  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-1 border-b">
        {tabs.map((item) => (
          <Link
            key={item.id}
            href={`/bls?tab=${item.id}`}
            aria-current={tab === item.id ? "page" : undefined}
            className={cn("-mb-px border-b-2 px-3 py-1.5", tab === item.id ? "border-primary font-medium" : "border-transparent")}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {tab === "awaiting" ? <BulkCreate payments={payments} patterns={patterns} /> : <CreatedBls bls={bls} layout={layout} />}
    </div>
  );
}

type RowInput = { blNo: string; containers: string };

/** Payments without a B/L in one editable grid; valid rows are saved together. */
function BulkCreate({ payments, patterns }: { payments: PaymentListItem[]; patterns: Record<number, string[]> }) {
  const router = useRouter();
  const [inputs, setInputs] = useState<Record<number, RowInput>>(() =>
    Object.fromEntries(
      payments.map((p) => {
        const candidates = blCandidatesOf(p);
        return [p.id, { blNo: candidates.length === 1 ? candidates[0] : "", containers: "" }];
      }),
    ),
  );
  const [errors, setErrors] = useState<Record<number, BlRowError[]>>({});
  const [busy, setBusy] = useState(false);
  const input = (id: number): RowInput => inputs[id] ?? { blNo: "", containers: "" };
  const update = (id: number, patch: Partial<RowInput>) => setInputs((all) => ({ ...all, [id]: { ...input(id), ...patch } }));

  /** Pasting several lines (or tab-separated columns) from Excel fills this row and the ones below. */
  const onPaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!/[\t\n]/.test(text.trim())) return;
    event.preventDefault();
    const lines = text.replace(/\r/g, "").replace(/\n$/, "").split("\n");
    setInputs((all) => {
      const next = { ...all };
      lines.forEach((line, offset) => {
        const payment = payments[index + offset];
        if (!payment) return;
        const [blNo = "", ...rest] = line.split("\t");
        next[payment.id] = { blNo: blNo.trim(), containers: rest.join(" ").trim() || (next[payment.id]?.containers ?? "") };
      });
      return next;
    });
  };

  const save = async () => {
    const rows = payments
      .filter((p) => input(p.id).blNo.trim() !== "")
      .map((p) => ({ paymentId: p.id, blNo: input(p.id).blNo, containers: parseContainerList(input(p.id).containers) }));
    if (rows.length === 0) return;
    setBusy(true);
    const result = await createBlsAction({ rows });
    setBusy(false);
    if (!result.ok) return void toast.error(t(result.error, result.params));

    const byPayment: Record<number, BlRowError[]> = {};
    for (const error of result.data.errors) (byPayment[rows[error.index].paymentId] ??= []).push(error);
    setErrors(byPayment);
    if (result.data.created.length) toast.success(t("bls.savedCount", { count: result.data.created.length }));
    if (result.data.errors.length) toast.error(t("bls.rowErrors", { count: Object.keys(byPayment).length }));
    router.refresh();
  };

  if (payments.length === 0) return <p className="text-muted-foreground">{t("bls.awaitingEmpty")}</p>;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-xs">{t("bls.pasteHint")}</p>
      <div className="overflow-auto rounded-md border">
        <table className="tabular w-full border-collapse">
          <thead className="bg-muted/60">
            <tr className="text-left">
              <th className="px-2 py-1 font-medium">{t("bls.paidAt")}</th>
              <th className="px-2 py-1 font-medium">{t("bls.agency")}</th>
              <th className="px-2 py-1 text-right font-medium">{t("bls.deposit")}</th>
              <th className="px-2 py-1 font-medium">{t("bls.candidates")}</th>
              <th className="px-2 py-1 font-medium">{t("bls.blNo")}</th>
              <th className="px-2 py-1 font-medium">{t("bls.containers")}</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((payment, index) => {
              const value = input(payment.id);
              const rowErrors = errors[payment.id] ?? [];
              const warnings = blRowWarnings(value.blNo, value.containers, patterns[payment.agencyId] ?? []);
              return (
                <tr key={payment.id} data-testid={`bl-row-${payment.id}`} className="border-t align-top">
                  <td className="px-2 py-1 whitespace-nowrap">{formatBusinessDate(payment.paidAt)}</td>
                  <td className="px-2 py-1">{payment.agencyName}</td>
                  <td className="px-2 py-1 text-right whitespace-nowrap">{formatMoney(payment.amountMinor, payment.currency)}</td>
                  <td className="px-2 py-1">
                    <div className="flex flex-wrap gap-1">
                      {blCandidatesOf(payment).map((candidate) => (
                        <button
                          key={candidate}
                          type="button"
                          className="bg-muted hover:bg-accent rounded px-1.5 font-mono text-xs"
                          onClick={() => update(payment.id, { blNo: candidate })}
                          title={t("bls.useCandidate", { bl: candidate })}
                        >
                          {candidate}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="w-48 px-2 py-1">
                    <Input
                      aria-label={`${t("bls.blNo")} – ${payment.agencyName} ${formatMoney(payment.amountMinor, payment.currency)}`}
                      className="h-8 font-mono uppercase"
                      value={value.blNo}
                      onChange={(event) => update(payment.id, { blNo: event.target.value })}
                      onPaste={(event) => onPaste(index, event)}
                    />
                  </td>
                  <td className="w-80 px-2 py-1">
                    <Input
                      aria-label={`${t("bls.containers")} – ${payment.agencyName} ${formatMoney(payment.amountMinor, payment.currency)}`}
                      className="h-8 font-mono uppercase"
                      value={value.containers}
                      onChange={(event) => update(payment.id, { containers: event.target.value })}
                    />
                    {rowErrors.map((error) => (
                      <p key={error.field} role="alert" className="text-destructive text-xs">
                        {t(error.message)}
                        {error.item ? ` (${error.item})` : ""}
                      </p>
                    ))}
                    {warnings.map((warning) => (
                      <p key={warning} className="text-xs text-amber-700 dark:text-amber-400">
                        {warning}
                      </p>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end">
        <Button onClick={save} disabled={busy}>
          {t("bls.saveAll")}
        </Button>
      </div>
    </div>
  );
}

type BlDialog = { kind: "edit"; bl: BlListItem } | { kind: "void"; bl: BlListItem } | null;

function CreatedBls({ bls, layout }: { bls: BlListItem[]; layout: TableLayout | null }) {
  const router = useRouter();
  const [showVoided, setShowVoided] = useState(false);
  const [dialog, setDialog] = useState<BlDialog>(null);
  const shown = useMemo(() => (showVoided ? bls : bls.filter((b) => !b.voidedAt)), [bls, showVoided]);

  const columns = useMemo(() => {
    const col = dataTableColumns<BlListItem>();
    return col.columns([
      col.accessor("blNo", { meta: { label: "bls.blNo", filter: "text" }, sortFn: "turkishText", cell: ({ getValue }) => <span className="font-mono">{getValue()}</span> }),
      col.accessor("agencyName", { meta: { label: "bls.agency", filter: "text" }, sortFn: "turkishText" }),
      col.accessor("paidAt", {
        meta: { label: "bls.paidAt", toText: (v) => formatBusinessDate(v as string) },
        sortFn: "basic",
        cell: ({ getValue }) => formatBusinessDate(getValue()),
      }),
      col.accessor("depositAmountMinor", {
        meta: { label: "bls.deposit", align: "end" },
        sortFn: "basic",
        cell: ({ row }) => formatMoney(row.original.depositAmountMinor, row.original.currency),
      }),
      col.accessor((b) => b.containers.join(", "), { id: "containers", meta: { label: "bls.containers", filter: "text" } }),
      col.accessor("status", {
        meta: { label: "bls.status", toText: (v) => t(`bls.statuses.${v as BlStatus}`) },
        cell: ({ row }) =>
          row.original.voidedAt ? (
            <Badge variant="destructive" title={row.original.voidReason ?? undefined}>
              {t("bls.voidedBadge")}
            </Badge>
          ) : (
            t(`bls.statuses.${row.original.status as BlStatus}`)
          ),
      }),
      col.display({
        id: "actions",
        meta: { label: "common.actions", searchable: false },
        enableHiding: false,
        cell: ({ row }) =>
          row.original.voidedAt ? null : (
            <div onClick={(event) => event.stopPropagation()}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-7" aria-label={t("common.actions")}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setDialog({ kind: "edit", bl: row.original })}>{t("bls.edit")}</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => setDialog({ kind: "void", bl: row.original })}>
                    {t("bls.void")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ),
      }),
    ]);
  }, []);

  return (
    <>
      <DataTable
        tableId="created-bls"
        data={shown}
        columns={columns}
        getRowId={(b) => String(b.id)}
        initialLayout={layout}
        onOpenRow={(bl) => !bl.voidedAt && setDialog({ kind: "edit", bl })}
        rowClassName={(b) => (b.voidedAt ? "text-muted-foreground line-through" : undefined)}
        toolbar={
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={showVoided} onCheckedChange={(checked) => setShowVoided(checked === true)} />
            {t("payments.showVoided")}
          </label>
        }
      />
      {dialog?.kind === "edit" && (
        <EditBlDialog
          bl={dialog.bl}
          onCancel={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            router.refresh();
          }}
        />
      )}
      {dialog?.kind === "void" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t("bls.void")}
          description={t("bls.voidText", { bl: dialog.bl.blNo })}
          confirmLabel={t("bls.void")}
          destructive
          requireReason
          onConfirm={async (reason) => {
            const result = await voidBlAction({ id: dialog.bl.id, reason });
            if (!result.ok) return void toast.error(t(result.error, result.params));
            toast.success(t("bls.voided"));
            setDialog(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function EditBlDialog({ bl, onCancel, onSaved }: { bl: BlListItem; onCancel: () => void; onSaved: () => void }) {
  const [blNo, setBlNo] = useState(bl.blNo);
  const [containers, setContainers] = useState(bl.containers.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const result = await updateBlAction({ id: bl.id, blNo, containers: parseContainerList(containers) });
    setBusy(false);
    if (!result.ok) {
      const field = result.fieldErrors ? Object.values(result.fieldErrors)[0] : undefined;
      return setError(t(field ?? result.error, result.params));
    }
    toast.success(t("bls.updated"));
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("bls.edit")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-bl-no">{t("bls.blNo")}</Label>
            <Input id="edit-bl-no" className="font-mono uppercase" value={blNo} onChange={(event) => setBlNo(event.target.value)} autoFocus />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-containers">{t("bls.containers")}</Label>
            <textarea
              id="edit-containers"
              rows={3}
              value={containers}
              onChange={(event) => setContainers(event.target.value)}
              className="border-input bg-background rounded-md border px-2 py-1 font-mono text-xs uppercase"
            />
            <p className="text-muted-foreground text-xs">{t("bls.containersHint")}</p>
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={busy}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
