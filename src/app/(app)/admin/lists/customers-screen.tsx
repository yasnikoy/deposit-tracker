"use client";

import { Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { CustomerOption } from "@/components/customer-combobox";
import { DataTable } from "@/components/data-table/data-table";
import { dataTableColumns } from "@/components/data-table/features";
import { DetailDialog, detailNavigation } from "@/components/detail-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { TableLayout } from "@/lib/schemas/table-layout";
import { CustomerForm } from "./customer-form";

/** Registered customers: searchable list, card in a dialog (accounting and operations edit). */
export function CustomersScreen({ customers, layout, canManage }: { customers: CustomerOption[]; layout: TableLayout | null; canManage: boolean }) {
  const [selected, setSelected] = useState<number | "new" | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const close = useCallback(() => setSelected(null), []);
  const customer = typeof selected === "number" ? customers.find((c) => c.id === selected) : undefined;

  const columns = useMemo(() => {
    const col = dataTableColumns<CustomerOption>();
    return col.columns([
      col.accessor("name", { meta: { label: "customers.name", filter: "text" }, sortFn: "turkishText" }),
      col.accessor((c) => c.code ?? "", { id: "code", meta: { label: "customers.code", filter: "text" }, sortFn: "turkishText" }),
      col.accessor((c) => c.aliases.join(", "), { id: "aliases", meta: { label: "customers.aliases", filter: "text" } }),
      col.accessor((c) => (c.active ? "active" : "inactive"), {
        id: "status",
        meta: {
          label: "customers.status",
          toText: (value) => t(value === "active" ? "agencies.active" : "agencies.inactive"),
          filter: {
            options: [
              { value: "active", label: "agencies.active" },
              { value: "inactive", label: "agencies.inactive" },
            ],
          },
        },
        cell: ({ getValue }) => (getValue() === "active" ? t("agencies.active") : <Badge variant="outline">{t("agencies.inactive")}</Badge>),
      }),
    ]);
  }, []);

  return (
    <>
      <DataTable
        tableId="customers"
        data={customers}
        columns={columns}
        getRowId={(c) => String(c.id)}
        initialLayout={layout}
        onOpenRow={(c, visible) => {
          setOrder(visible.map((v) => String(v.id)));
          setSelected(c.id);
        }}
        rowClassName={(c) => (c.active ? undefined : "text-muted-foreground")}
        toolbar={
          canManage && (
            <Button size="sm" onClick={() => setSelected("new")}>
              <Plus /> {t("customers.new")}
            </Button>
          )
        }
      />
      {selected !== null && (selected === "new" || customer) && (
        <DetailDialog
          title={customer ? customer.name : t("customers.new")}
          navigation={customer ? detailNavigation(order, String(customer.id), (id) => setSelected(Number(id))) : null}
          onClose={close}
        >
          <CustomerForm key={selected} customer={customer ?? null} readOnly={!canManage} onCreated={(id) => setSelected(id)} />
        </DetailDialog>
      )}
    </>
  );
}
