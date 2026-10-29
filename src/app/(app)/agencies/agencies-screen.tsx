"use client";

import { Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { DataTable } from "@/components/data-table/data-table";
import { dataTableColumns } from "@/components/data-table/features";
import { DetailDialog, detailNavigation } from "@/components/detail-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { REQUEST_CHANNELS } from "@/domain/agency";
import { t } from "@/i18n";
import type { AgencyOverrides } from "@/lib/schemas/agencies";
import type { TableLayout } from "@/lib/schemas/table-layout";
import type { AgencyListItem } from "@/server/agencies";
import { AgencyForm } from "./agency-form";
import { FormTemplateCard } from "./form-template-card";
import { OverridesForm } from "./overrides-form";

export type AgencyPermissions = { create: boolean; update: boolean; updateOverrides: boolean; updateFormTemplate: boolean };

export function AgenciesScreen({
  agencies,
  globals,
  layout,
  permissions,
}: {
  agencies: AgencyListItem[];
  globals: AgencyOverrides;
  layout: TableLayout | null;
  permissions: AgencyPermissions;
}) {
  const [selected, setSelected] = useState<number | "new" | null>(null);
  // The table's order when the row was opened, for previous/next.
  const [order, setOrder] = useState<string[]>([]);
  const close = useCallback(() => setSelected(null), []);
  const agency = typeof selected === "number" ? agencies.find((a) => a.id === selected) : undefined;

  const columns = useMemo(() => {
    const col = dataTableColumns<AgencyListItem>();
    return col.columns([
      col.accessor("name", { meta: { label: "agencies.name", filter: "text" }, sortFn: "turkishText" }),
      col.accessor((a) => (a.active ? "active" : "inactive"), {
        id: "status",
        meta: {
          label: "agencies.status",
          toText: (value) => t(value === "active" ? "agencies.active" : "agencies.inactive"),
          filter: {
            options: [
              { value: "active", label: "agencies.active" },
              { value: "inactive", label: "agencies.inactive" },
            ],
          },
        },
        filterFn: "oneOf",
        cell: ({ getValue }) =>
          getValue() === "active" ? t("agencies.active") : <Badge variant="outline">{t("agencies.inactive")}</Badge>,
      }),
      col.accessor("requestChannel", {
        meta: {
          label: "agencies.channel",
          toText: (value) => t(`agencies.channels.${value as (typeof REQUEST_CHANNELS)[number]}`),
          filter: { options: REQUEST_CHANNELS.map((c) => ({ value: c, label: `agencies.channels.${c}` as const })) },
        },
        filterFn: "oneOf",
        cell: ({ getValue }) => t(`agencies.channels.${getValue()}`),
      }),
      col.accessor((a) => (a.batchSending ? t("agencies.batch") : t("agencies.single")), {
        id: "sending",
        meta: { label: "agencies.sending" },
        sortFn: "turkishText",
      }),
      col.accessor((a) => a.toRecipients.length + a.ccRecipients.length, {
        id: "recipients",
        meta: { label: "agencies.recipientCount", align: "end", searchable: false },
        sortFn: "basic",
      }),
      col.accessor((a) => a.blNumberPatterns.length, {
        id: "patterns",
        meta: { label: "agencies.patternCount", align: "end", searchable: false },
        sortFn: "basic",
      }),
    ]);
  }, []);

  return (
    <>
      <DataTable
        tableId="agencies"
        data={agencies}
        columns={columns}
        getRowId={(a) => String(a.id)}
        initialLayout={layout}
        onOpenRow={(a, visible) => {
          setOrder(visible.map((v) => String(v.id)));
          setSelected(a.id);
        }}
        rowClassName={(a) => (a.active ? undefined : "text-muted-foreground")}
        toolbar={
          permissions.create && (
            <Button size="sm" onClick={() => setSelected("new")}>
              <Plus /> {t("agencies.new")}
            </Button>
          )
        }
      />
      {selected !== null && (selected === "new" || agency) && (
        <DetailDialog
          title={agency ? agency.name : t("agencies.new")}
          navigation={agency ? detailNavigation(order, String(agency.id), (id) => setSelected(Number(id))) : null}
          onClose={close}
        >
          <div className="flex flex-col gap-6">
            <AgencyForm
              key={selected}
              agency={agency ?? null}
              readOnly={agency ? !permissions.update : !permissions.create}
              onCreated={(id) => setSelected(id)}
            />
            {agency && <FormTemplateCard agency={agency} editable={permissions.updateFormTemplate} />}
            {agency && (
              <OverridesForm key={`${agency.id}:${JSON.stringify(agency.overrides)}`} agency={agency} globals={globals} editable={permissions.updateOverrides} />
            )}
          </div>
        </DetailDialog>
      )}
    </>
  );
}
