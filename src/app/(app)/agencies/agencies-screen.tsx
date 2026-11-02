"use client";

import { Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { DataTable } from "@/components/data-table/data-table";
import { dataTableColumns } from "@/components/data-table/features";
import { DetailDialog, detailNavigation } from "@/components/detail-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { agencyDetailsMissing, REQUEST_CHANNELS } from "@/domain/agency";
import { t } from "@/i18n";
import type { AgencyOverrides } from "@/lib/schemas/agencies";
import type { TableLayout } from "@/lib/schemas/table-layout";
import type { AgencyListItem } from "@/server/agencies";
import { DeleteRecord } from "@/components/delete-record";
import { deleteAgencyAction, updateAgencyContactAction } from "./actions";
import { AgencyForm } from "./agency-form";
import { ExportAgenciesButton, ImportAgenciesButton } from "./agency-transfer";
import { FormTemplateCard } from "./form-template-card";
import { OverridesForm } from "./overrides-form";

const splitList = (text: string) => text.split(/[,;\s]+/).map((part) => part.trim()).filter(Boolean);

const AGENCY_STATUSES = ["active", "incomplete", "inactive"] as const;
type AgencyStatus = (typeof AGENCY_STATUSES)[number];

export type AgencyPermissions = { create: boolean; update: boolean; updateOverrides: boolean; updateFormTemplate: boolean; delete: boolean };

export function AgenciesScreen({
  agencies,
  globals,
  layout,
  permissions,
  initialAgencyId = null,
}: {
  agencies: AgencyListItem[];
  globals: AgencyOverrides;
  layout: TableLayout | null;
  permissions: AgencyPermissions;
  /** Opens this agency's card first (a link from a notification). */
  initialAgencyId?: number | null;
}) {
  const [selected, setSelected] = useState<number | "new" | null>(initialAgencyId);
  // The table's order when the row was opened, for previous/next.
  const [order, setOrder] = useState<string[]>([]);
  const close = useCallback(() => setSelected(null), []);
  const agency = typeof selected === "number" ? agencies.find((a) => a.id === selected) : undefined;

  const columns = useMemo(() => {
    const col = dataTableColumns<AgencyListItem>();
    return col.columns([
      col.accessor("name", { meta: { label: "agencies.name", filter: "text" }, sortFn: "turkishText" }),
      col.accessor((a): AgencyStatus => (!a.active ? "inactive" : agencyDetailsMissing(a) ? "incomplete" : "active"), {
        id: "status",
        meta: {
          label: "agencies.status",
          toText: (value) => t(`agencies.${value as AgencyStatus}`),
          filter: { options: AGENCY_STATUSES.map((value) => ({ value, label: `agencies.${value}` as const })) },
        },
        cell: ({ getValue }) => {
          const status = getValue();
          if (status === "active") return t("agencies.active");
          return (
            <Badge variant={status === "incomplete" ? "destructive" : "outline"} title={status === "incomplete" ? t("agencies.incompleteHint") : undefined}>
              {t(`agencies.${status}`)}
            </Badge>
          );
        },
      }),
      col.accessor("requestChannel", {
        meta: {
          label: "agencies.channel",
          toText: (value) => t(`agencies.channels.${value as (typeof REQUEST_CHANNELS)[number]}`),
          filter: { options: REQUEST_CHANNELS.map((c) => ({ value: c, label: `agencies.channels.${c}` as const })) },
        },
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
      // Contact fields are edited inline (F2 or the pencil); the whole card is validated on the server.
      ...(["toRecipients", "ccRecipients"] as const).map((field) =>
        col.accessor((a) => a[field].join(", "), {
          id: field,
          meta: {
            label: `agencies.${field}` as const,
            filter: "text" as const,
            edit: {
              editable: () => permissions.update,
              text: (a: AgencyListItem) => a[field].join(", "),
              save: (a: AgencyListItem, text: string) => updateAgencyContactAction({ id: a.id, field, value: splitList(text) }),
            },
          },
          cell: ({ getValue }) => (
            <span className="block max-w-56 truncate" title={getValue() || undefined}>
              {getValue()}
            </span>
          ),
        }),
      ),
      col.accessor((a) => a.notes ?? "", {
        id: "notes",
        meta: {
          label: "agencies.notes",
          filter: "text",
          edit: {
            editable: () => permissions.update,
            text: (a: AgencyListItem) => a.notes ?? "",
            save: (a: AgencyListItem, text: string) => updateAgencyContactAction({ id: a.id, field: "notes", value: text }),
          },
        },
        // One line in the table; the whole note on hover and in the card.
        cell: ({ getValue }) => (
          <span className="block max-w-48 truncate" title={getValue() || undefined}>
            {getValue()}
          </span>
        ),
      }),
    ]);
  }, [permissions.update]);

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
        hiddenByDefault={["recipients", "patterns"]}
        bulkActions={(rows) => <ExportAgenciesButton agencies={rows} />}
        toolbar={
          permissions.create && (
            <>
              <Button size="sm" onClick={() => setSelected("new")}>
                <Plus /> {t("agencies.new")}
              </Button>
              <ImportAgenciesButton existing={agencies} />
            </>
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
            {agency && permissions.delete && <DeleteRecord name={agency.name} onDelete={(reason) => deleteAgencyAction({ id: agency.id, reason })} onDeleted={close} />}
          </div>
        </DetailDialog>
      )}
    </>
  );
}
