"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table/data-table";
import { dataTableColumns } from "@/components/data-table/features";
import { Button } from "@/components/ui/button";
import { toastWithUndo } from "@/components/undo-toast";
import { t } from "@/i18n";
import { formatBusinessDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import type { TableLayout } from "@/lib/schemas/table-layout";
import type { BlOverview } from "@/server/bl-overview";
import { recordAccountingEntryAction } from "./actions";

/**
 * Accounting's work list: B/Ls settled with deductions or an offset. Each is marked once its
 * entry is in the accounting software; only then is it collected. Every confirmation lists
 * the B/Ls it covers (rule 11) and can be undone from the toast.
 */
export function AccountingEntries({ bls, layout }: { bls: BlOverview[]; layout: TableLayout | null }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<{ bls: BlOverview[]; clear?: () => void } | null>(null);

  const columns = useMemo(() => {
    const col = dataTableColumns<BlOverview>();
    return col.columns([
      col.accessor("blNo", {
        meta: { label: "bls.blNo", filter: "text" },
        sortFn: "turkishText",
        cell: ({ row }) => (
          <Link href={`/bls/${row.original.id}`} className="font-mono underline">
            {row.original.blNo}
          </Link>
        ),
      }),
      col.accessor("agencyName", { meta: { label: "bls.agency", filter: "text" }, sortFn: "turkishText" }),
      col.accessor((b) => b.customerName ?? "", { id: "customer", meta: { label: "bls.customer", filter: "text" }, sortFn: "turkishText" }),
      col.accessor((b) => b.fileNo ?? "", { id: "fileNo", meta: { label: "bls.fileNo", filter: "text" }, sortFn: "turkishText" }),
      col.accessor("paidAt", { meta: { label: "bls.paidAt" }, sortFn: "basic", cell: ({ getValue }) => formatBusinessDate(getValue()) }),
      col.accessor("depositMinor", {
        meta: { label: "bls.deposit", align: "end", searchable: false },
        sortFn: "basic",
        cell: ({ row }) => formatMoney(row.original.depositMinor, row.original.currency),
      }),
      col.accessor("collectedMinor", {
        meta: { label: "bls.collected", align: "end", searchable: false },
        sortFn: "basic",
        cell: ({ row }) => formatMoney(row.original.collectedMinor, row.original.currency),
      }),
      col.accessor("deductionsMinor", {
        meta: { label: "payments.accountingEntries.deductions", align: "end", searchable: false },
        sortFn: "basic",
        cell: ({ row }) => formatMoney(row.original.deductionsMinor, row.original.currency),
      }),
      col.display({
        id: "record",
        meta: { label: "common.actions", searchable: false },
        enableHiding: false,
        cell: ({ row }) => (
          <Button size="sm" variant="outline" onClick={() => setConfirm({ bls: [row.original] })}>
            {t("payments.accountingEntries.record")}
          </Button>
        ),
      }),
    ]);
  }, []);

  const record = async () => {
    if (!confirm) return;
    const result = await recordAccountingEntryAction({ blIds: confirm.bls.map((b) => b.id) });
    if (!result.ok) return void toast.error(t(result.error, result.params));
    toastWithUndo(t("payments.accountingEntries.recorded", { count: result.data.length }), result.data, () => router.refresh());
    confirm.clear?.();
    setConfirm(null);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground max-w-3xl text-sm">{t("payments.accountingEntries.hint")}</p>
      <DataTable
        tableId="accounting-entries"
        data={bls}
        columns={columns}
        getRowId={(b) => String(b.id)}
        initialLayout={layout}
        bulkActions={(selected, clear) => (
          <Button size="sm" onClick={() => setConfirm({ bls: selected, clear })}>
            {t("payments.accountingEntries.recordSelected")}
          </Button>
        )}
      />
      {bls.length === 0 && <p className="text-muted-foreground">{t("payments.accountingEntries.empty")}</p>}
      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirm(null)}
          title={t("payments.accountingEntries.confirmTitle")}
          description={t("payments.accountingEntries.confirmText")}
          items={confirm.bls.map((b) => `${b.blNo} · ${b.agencyName} · ${formatMoney(b.deductionsMinor, b.currency)}`)}
          confirmLabel={t("payments.accountingEntries.record")}
          onConfirm={record}
        />
      )}
    </div>
  );
}
