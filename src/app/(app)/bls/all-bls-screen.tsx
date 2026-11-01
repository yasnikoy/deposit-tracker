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
import { parseContainerList } from "@/domain/containers";
import { BL_STATUSES } from "@/domain/records";
import { t } from "@/i18n";
import { formatBusinessDate } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import type { TableLayout } from "@/lib/schemas/table-layout";
import type { BlOverview } from "@/server/bl-overview";
import { updateBlAction } from "./actions";
import { EditBlDialog, VoidBlDialog } from "./bl-dialogs";
import { BalanceStrip } from "./balance-strip";
import { BulkNoteDialog } from "./bulk-note-dialog";
import type { MentionableUser } from "./note-editor";

const STATUS_OPTIONS = BL_STATUSES.map((status) => ({ value: status, label: `bls.statuses.${status}` as const }));

const col = dataTableColumns<BlOverview>();
/** Inline editing (rule 11: never money or status): the B/L number while still PAID, and containers. */
const buildColumns = (canEdit: boolean) => col.columns([
  col.accessor("blNo", {
    meta: {
      label: "bls.blNo",
      filter: "text",
      edit: {
        editable: (b: BlOverview) => canEdit && !b.voidedAt && b.status === "PAID",
        text: (b: BlOverview) => b.blNo,
        save: (b: BlOverview, text: string) => updateBlAction({ id: b.id, blNo: text.trim(), containers: b.containers }),
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
  col.accessor((b) => b.customerName ?? "", { id: "customer", meta: { label: "bls.customer", filter: "text" }, sortFn: "turkishText" }),
  col.accessor((b) => b.fileNo ?? "", {
    id: "fileNo",
    meta: { label: "bls.fileNo", filter: "text" },
    sortFn: "turkishText",
    cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span>,
  }),
  col.accessor("status", {
    meta: { label: "bls.status", filter: { options: STATUS_OPTIONS }, toText: (v) => t(`bls.statuses.${v as BlOverview["status"]}`) },
    sortFn: "turkishText",
    cell: ({ row }) => <BlStatusBadge status={row.original.status} voided={!!row.original.voidedAt} voidReason={row.original.voidReason} />,
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
  col.accessor((b) => b.containers.join(", "), {
    id: "containers",
    meta: {
      label: "bls.containers",
      filter: "text",
      edit: {
        editable: (b: BlOverview) => canEdit && !b.voidedAt,
        text: (b: BlOverview) => b.containers.join(", "),
        save: (b: BlOverview, text: string) => updateBlAction({ id: b.id, blNo: b.blNo, containers: parseContainerList(text) }),
      },
    },
  }),
]);

type Dialog = { kind: "edit" | "void"; bl: BlOverview } | null;

/** Every B/L in one dense table; the row opens a summary panel with a link to the full detail. */
export function AllBlsScreen({
  bls,
  layout,
  status,
  canEdit,
  canVoid,
  canAddNote,
  mentionable,
}: {
  bls: BlOverview[];
  layout: TableLayout | null;
  /** A status the page was opened with (e.g. from the dashboard): the list starts filtered to it. */
  status: BlOverview["status"] | null;
  canEdit: boolean;
  canVoid: boolean;
  canAddNote: boolean;
  mentionable: MentionableUser[];
}) {
  const router = useRouter();
  const [showVoided, setShowVoided] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  // The table's order when the row was opened, for previous/next.
  const [order, setOrder] = useState<string[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const columns = useMemo(() => buildColumns(canEdit), [canEdit]);
  const [noteFor, setNoteFor] = useState<{ bls: BlOverview[]; clear: () => void } | null>(null);
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
        initialFilters={status ? [{ id: "status", value: status }] : undefined}
        onOpenRow={(b, visible) => {
          setOrder(visible.map((v) => String(v.id)));
          setOpenId(b.id);
        }}
        rowClassName={(b) => (b.voidedAt ? "text-muted-foreground line-through" : undefined)}
        shortcuts={
          canAddNote
            ? {
                n: (rows, clear) => {
                  const active = rows.filter((b) => !b.voidedAt);
                  if (active.length > 0) setNoteFor({ bls: active, clear });
                },
              }
            : undefined
        }
        bulkActions={
          canAddNote
            ? (selected, clear) => {
                const active = selected.filter((b) => !b.voidedAt);
                return (
                  <Button size="sm" variant="outline" disabled={active.length === 0} onClick={() => setNoteFor({ bls: active, clear })}>
                    {t("notes.bulk")}
                  </Button>
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
      {noteFor && (
        <BulkNoteDialog
          bls={noteFor.bls}
          users={mentionable}
          onClose={() => setNoteFor(null)}
          onDone={() => {
            noteFor.clear();
            setNoteFor(null);
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
              <dt className="text-muted-foreground">{t("bls.containers")}</dt>
              <dd className="font-mono text-xs">{open.containers.length ? open.containers.join(", ") : t("bls.noContainers")}</dd>
            </dl>
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
                <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "void", bl: open })}>
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
