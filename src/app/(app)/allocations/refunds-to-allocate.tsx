"use client";

import { useRouter } from "next/navigation";
import { DataTable } from "@/components/data-table/data-table";
import { dataTableColumns } from "@/components/data-table/features";
import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";
import { formatBusinessDate } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import type { TableLayout } from "@/lib/schemas/table-layout";
import type { RefundListItem } from "@/server/refunds";

const col = dataTableColumns<RefundListItem>();
const columns = col.columns([
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
  col.accessor("status", {
    meta: { label: "payments.status", toText: (v) => t(`refunds.statuses.${v as RefundListItem["status"]}`) },
    cell: ({ getValue }) => <Badge variant="outline">{t(`refunds.statuses.${getValue()}`)}</Badge>,
  }),
]);

/** Refunds with money still to allocate, oldest first; a row opens its review page. */
export function RefundsToAllocate({ refunds, layout }: { refunds: RefundListItem[]; layout: TableLayout | null }) {
  const router = useRouter();
  return (
    <>
      <DataTable
        tableId="refunds-to-allocate"
        data={refunds}
        columns={columns}
        getRowId={(r) => String(r.id)}
        initialLayout={layout}
        onOpenRow={(r) => router.push(`/allocations/${r.id}`)}
        emptyText={t("allocations.empty")}
      />
    </>
  );
}
