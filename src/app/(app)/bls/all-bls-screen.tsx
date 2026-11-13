"use client";

import { Lock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { BlStatusBadge } from "@/components/bl-status-badge";
import { DataTable } from "@/components/data-table/data-table";
import { dataTableColumns } from "@/components/data-table/features";
import { DetailDialog, detailNavigation } from "@/components/detail-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { BL_STATUSES } from "@/domain/records";
import { t } from "@/i18n";
import { formatBusinessDate } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import type { TableLayout } from "@/lib/schemas/table-layout";
import type { BlOverview } from "@/server/bl-overview";
import { updateBlAction } from "./actions";
import { EditBlDialog, VoidBlDialog } from "./bl-dialogs";
import { BalanceStrip } from "./balance-strip";
import { BlBulkActions, type BulkOptions } from "./bl-bulk-actions";
import { BulkDescriptionDialog } from "./bulk-description-dialog";
import { DescriptionEditor } from "./description-editor";
import { TransferDialog } from "./[id]/transfer-dialog";
import type { CustomerOption } from "@/components/customer-combobox";

/** A deposit moves on while the B/L is open and nothing was refunded on it (as on the B/L detail). */
const transferable = (b: BlOverview) =>
  !b.voidedAt && ["PAID", "DUE", "REQUESTED", "AWAITING_RETURN"].includes(b.status) && b.expectedMinor > 0 && b.collectedMinor === 0;

/** The hold column's value: one word to filter on; the cell shows the reason. */
export const HELD = "HELD";

const STATUS_OPTIONS = BL_STATUSES.map((status) => ({ value: status, label: `bls.statuses.${status}` as const }));

const col = dataTableColumns<BlOverview>();
/** Inline editing (rule 11: never money or status): the B/L number while still PAID and the file number. */
const buildColumns = (canEdit: boolean) => col.columns([
  col.accessor("blNo", {
    meta: {
      label: "bls.blNo",
      filter: "text",
      edit: {
        editable: (b: BlOverview) => canEdit && !b.voidedAt && b.status === "PAID",
        text: (b: BlOverview) => b.blNo,
        save: (b: BlOverview, text: string) => updateBlAction({ id: b.id, blNo: text.trim() }),
      },
    },
    sortFn: "turkishText",
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-2">
        <span className="font-mono">{row.original.blNo}</span>
        {row.original.lockedBy && (
          <Badge variant="secondary" title={t("requests.lockedBy", { user: row.original.lockedBy })}>
            <Lock />
          </Badge>
        )}
      </span>
    ),
  }),
  col.accessor("agencyName", { meta: { label: "bls.agency", filter: "text" }, sortFn: "turkishText" }),
  // Only agencies with units fill it, so it is hidden by default.
  col.accessor((b) => b.unitName ?? "", { id: "unit", meta: { label: "bls.unit", filter: "text" }, sortFn: "turkishText" }),
  col.accessor((b) => b.customerName ?? "", { id: "customer", meta: { label: "bls.customer", filter: "text" }, sortFn: "turkishText" }),
  col.accessor((b) => b.fileNo ?? "", {
    id: "fileNo",
    meta: {
      label: "bls.fileNo",
      filter: "text",
      edit: {
        editable: (b: BlOverview) => canEdit && !b.voidedAt,
        text: (b: BlOverview) => b.fileNo ?? "",
        save: (b: BlOverview, text: string) => updateBlAction({ id: b.id, fileNo: text }),
      },
    },
    sortFn: "turkishText",
    cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span>,
  }),
  col.accessor("status", {
    meta: { label: "bls.status", filter: { options: STATUS_OPTIONS }, toText: (v) => t(`bls.statuses.${v as BlOverview["status"]}`) },
    sortFn: "turkishText",
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-1">
        <BlStatusBadge status={row.original.status} voided={!!row.original.voidedAt} voidReason={row.original.voidReason} />
        {row.original.hold && (
          <Badge variant="secondary" title={row.original.hold.reason}>
            {t("holds.chip")}
          </Badge>
        )}
      </span>
    ),
  }),
  // On hold (Beklemeye al): the reason, and when it comes back; filter to see them all.
  col.accessor((b) => (b.hold ? HELD : ""), {
    id: "hold",
    meta: { label: "holds.label", filter: { options: [{ value: HELD, label: "holds.chip" }] }, toText: (v) => (v ? t("holds.chip") : "") },
    sortFn: "basic",
    cell: ({ row }) =>
      row.original.hold && (
        <span className="text-xs">
          {row.original.hold.reason}
          {row.original.hold.until && <span className="text-muted-foreground"> · {formatBusinessDate(row.original.hold.until)}</span>}
        </span>
      ),
  }),
  col.accessor("paidAt", {
    meta: { label: "bls.paidAt", toText: (v) => formatBusinessDate(v as string) },
    sortFn: "basic",
    cell: ({ getValue }) => formatBusinessDate(getValue()),
  }),
  col.accessor("depositMinor", {
    meta: { label: "bls.deposit", align: "end", toText: (v) => formatAmount(v as number) },
    sortFn: "basic",
    cell: ({ row }) => formatAmount(row.original.depositMinor),
  }),
  col.accessor("currency", { meta: { label: "bls.currency", filter: "text" }, sortFn: "turkishText" }),
  col.accessor("expectedMinor", {
    meta: { label: "bls.expected", align: "end", toText: (v) => formatAmount(v as number) },
    sortFn: "basic",
    cell: ({ row }) => formatAmount(row.original.expectedMinor),
  }),
  col.accessor("collectedMinor", {
    meta: { label: "bls.collected", align: "end", toText: (v) => formatAmount(v as number) },
    sortFn: "basic",
    cell: ({ row }) => formatAmount(row.original.collectedMinor),
  }),
  col.accessor("attempts", { meta: { label: "bls.attempts", align: "end", searchable: false }, sortFn: "basic" }),
  col.accessor("lastRequestOn", {
    meta: { label: "bls.lastRequestOn", toText: (v) => (v ? formatBusinessDate(v as string) : "") },
    sortFn: "basic",
    cell: ({ getValue }) => {
      const value = getValue();
      return value ? formatBusinessDate(value) : t("common.none");
    },
  }),
  col.accessor((b) => (b.lastReply ? `${b.lastReply.typeName} · ${formatBusinessDate(b.lastReply.repliedOn)}` : ""), {
    id: "lastReply",
    meta: { label: "bls.lastReply", filter: "text" },
    cell: ({ getValue }) => getValue() || t("common.none"),
  }),
  col.accessor("daysWaiting", {
    meta: { label: "bls.daysWaiting", align: "end", searchable: false },
    sortFn: "basic",
    cell: ({ getValue }) => getValue() ?? t("common.none"),
  }),
  col.accessor((b) => b.description ?? "", {
    id: "description",
    meta: { label: "description.title", filter: "text" },
    // The first line in the table; the whole text in the row panel and on the detail.
    cell: ({ getValue }) => (
      <span className="block max-w-64 truncate text-xs" title={getValue() || undefined}>
        {getValue().split("\n")[0]}
      </span>
    ),
  }),
  col.accessor((b) => b.containers.join(", "), {
    id: "containers",
    // Entered on the B/L detail only; shown here read-only.
    meta: { label: "bls.containers", filter: "text" },
  }),
]);

type Dialog = { kind: "edit" | "void"; bl: BlOverview } | null;

/** Every B/L in one dense table; the row opens a summary panel with a link to the full detail. */
export function AllBlsScreen({
  bls,
  layout,
  status,
  held,
  canEdit,
  canVoid,
  canEditDescription,
  transfer,
  bulk,
}: {
  bls: BlOverview[];
  layout: TableLayout | null;
  /** A status the page was opened with (e.g. from the dashboard): the list starts filtered to it. */
  status: BlOverview["status"] | null;
  /** Opened from the dashboard's on-hold count: the list starts filtered to B/Ls on hold. */
  held: boolean;
  canEdit: boolean;
  canVoid: boolean;
  canEditDescription: boolean;
  /** What the bulk deposit transfer needs; null for users who cannot transfer. */
  transfer: { customers: CustomerOption[]; today: string } | null;
  /** The B/L detail's everyday actions on the selected rows; null for users who can do none. */
  bulk: BulkOptions | null;
}) {
  const router = useRouter();
  const [showVoided, setShowVoided] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  // The table's order when the row was opened, for previous/next.
  const [order, setOrder] = useState<string[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const columns = useMemo(() => buildColumns(canEdit), [canEdit]);
  const [describeFor, setDescribeFor] = useState<{ bls: BlOverview[]; clear: () => void } | null>(null);
  const [transferFor, setTransferFor] = useState<{ bls: BlOverview[]; clear: () => void } | null>(null);
  const shown = useMemo(() => (showVoided ? bls : bls.filter((b) => !b.voidedAt)), [bls, showVoided]);
  const open = bls.find((b) => b.id === openId) ?? null;
  const done = () => {
    setDialog(null);
    router.refresh();
  };

  return (
    <>
      <DataTable
        tableId="all-bls"
        data={shown}
        columns={columns}
        getRowId={(b) => String(b.id)}
        initialLayout={layout}
        initialFilters={status ? [{ id: "status", value: status }] : held ? [{ id: "hold", value: HELD }] : undefined}
        // Beklenen equals Depozito until money comes in; request count and last reply are on the row panel.
        hiddenByDefault={["unit", "expectedMinor", "attempts", "lastReply", "containers", "hold"]}
        onOpenRow={(b, visible) => {
          setOrder(visible.map((v) => String(v.id)));
          setOpenId(b.id);
        }}
        rowClassName={(b) => (b.voidedAt ? "text-muted-foreground line-through" : undefined)}
        shortcuts={
          canEditDescription
            ? {
                n: (rows, clear) => {
                  const active = rows.filter((b) => !b.voidedAt);
                  if (active.length > 0) setDescribeFor({ bls: active, clear });
                },
              }
            : undefined
        }
        bulkActions={
          canEditDescription || transfer || bulk
            ? (selected, clear) => {
                const active = selected.filter((b) => !b.voidedAt);
                return (
                  <>
                    {bulk && (
                      <BlBulkActions
                        bls={active.map((b) => ({ id: b.id, blNo: b.blNo, agencyId: b.agencyId, held: b.hold !== null }))}
                        options={bulk}
                        onDone={clear}
                      />
                    )}
                    {canEditDescription && (
                      <Button size="sm" variant="outline" disabled={active.length === 0} onClick={() => setDescribeFor({ bls: active, clear })}>
                        {t("description.bulk")}
                      </Button>
                    )}
                    {transfer && (
                      <Button
                        size="sm"
                        variant="outline"
                        // The server checks each B/L again; the button only offers what can work.
                        disabled={selected.length === 0 || !selected.every((b) => transferable(b) && b.agencyId === selected[0].agencyId && b.currency === selected[0].currency)}
                        onClick={() => setTransferFor({ bls: selected, clear })}
                      >
                        {t("transfers.action")}
                      </Button>
                    )}
                  </>
                );
              }
            : undefined
        }
        toolbar={
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={showVoided} onCheckedChange={(checked) => setShowVoided(checked === true)} />
            {t("payments.showVoided")}
          </label>
        }
      />
      {describeFor && (
        <BulkDescriptionDialog
          bls={describeFor.bls}
          onClose={() => setDescribeFor(null)}
          onDone={() => {
            describeFor.clear();
            setDescribeFor(null);
            router.refresh();
          }}
        />
      )}
      {transfer && transferFor && (
        <TransferDialog
          sources={transferFor.bls.map((b) => ({ id: b.id, blNo: b.blNo, amountMinor: b.expectedMinor }))}
          currency={transferFor.bls[0].currency}
          defaults={transferFor.bls[0]}
          customers={transfer.customers}
          today={transfer.today}
          onCancel={() => setTransferFor(null)}
          onDone={() => {
            transferFor.clear();
            setTransferFor(null);
            router.refresh();
          }}
        />
      )}
      {open && (
        <DetailDialog
          title={<span className="font-mono">{open.blNo}</span>}
          navigation={detailNavigation(order, String(open.id), (id) => setOpenId(Number(id)))}
          onClose={() => setOpenId(null)}
        >
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <BlStatusBadge status={open.status} voided={!!open.voidedAt} voidReason={open.voidReason} />
              <span>{open.agencyName}</span>
            </div>
            <BalanceStrip bl={open} />
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">{t("bls.paidAt")}</dt>
              <dd>{formatBusinessDate(open.paidAt)}</dd>
              <dt className="text-muted-foreground">{t("bls.daysWaiting")}</dt>
              <dd>{open.daysWaiting ?? t("common.none")}</dd>
              <dt className="text-muted-foreground">{t("bls.attempts")}</dt>
              <dd>
                {open.attempts}
                {open.lastRequestOn && <span className="text-muted-foreground"> · {t("bls.lastRequestOn")}: {formatBusinessDate(open.lastRequestOn)}</span>}
              </dd>
              <dt className="text-muted-foreground">{t("bls.lastReply")}</dt>
              <dd>{open.lastReply ? `${open.lastReply.typeName} · ${formatBusinessDate(open.lastReply.repliedOn)}` : t("common.none")}</dd>
              <dt className="text-muted-foreground">{t("bls.containers")}</dt>
              <dd className="font-mono text-xs">{open.containers.length ? open.containers.join(", ") : t("bls.noContainers")}</dd>
            </dl>
            <section className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">{t("description.title")}</h3>
              <DescriptionEditor key={open.id} id="panel-description" blId={open.id} description={open.description} editable={canEditDescription && !open.voidedAt} />
            </section>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm">
                <Link href={`/bls/${open.id}`}>{t("bls.openDetail")}</Link>
              </Button>
              {canEdit && !open.voidedAt && (
                <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "edit", bl: open })}>
                  {t("bls.edit")}
                </Button>
              )}
              {canVoid && !open.voidedAt && (
                <Button size="sm" variant="outline" className="text-destructive" onClick={() => setDialog({ kind: "void", bl: open })}>
                  {t("bls.void")}
                </Button>
              )}
            </div>
          </div>
        </DetailDialog>
      )}
      {dialog?.kind === "edit" && <EditBlDialog bl={dialog.bl} onCancel={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === "void" && (
        <VoidBlDialog
          bl={dialog.bl}
          onCancel={() => setDialog(null)}
          onVoided={() => {
            // A voided B/L leaves the list, so its detail closes too.
            setOpenId(null);
            done();
          }}
        />
      )}
    </>
  );
}
