import { createRequire } from "node:module";
import { constructTable, type ColumnFiltersState } from "@tanstack/react-table";
import { describe, expect, it } from "vitest";
import { dataTableColumns, dataTableFeatures, withFilterFns } from "@/components/data-table/features";

// useTable adds React reactivity; outside React, table-core's plain store bindings do. The
// package is reached through react-table, which depends on it (it is not a direct dependency).
const fromReactTable = createRequire(createRequire(import.meta.url).resolve("@tanstack/react-table"));
const { storeReactivityBindings } = (await import(fromReactTable.resolve("@tanstack/table-core/store-reactivity-bindings"))) as {
  storeReactivityBindings: () => unknown;
};

type Row = { agencyName: string; status: string };

const col = dataTableColumns<Row>();
const columns = [
  col.accessor("agencyName", { meta: { label: "bls.agency", filter: "text" } }),
  col.accessor("status", { meta: { label: "bls.status", filter: { options: [{ value: "PAID", label: "bls.statuses.PAID" }] } } }),
];
const data: Row[] = [
  { agencyName: "Yang Ming", status: "PAID" },
  { agencyName: "MSC", status: "REQUESTED" },
  { agencyName: "Ocean Network Express", status: "PAID" },
];

function filtered(columnFilters: ColumnFiltersState): string[] {
  const table = constructTable({
    features: { ...dataTableFeatures, coreReactivityFeature: storeReactivityBindings() } as unknown as typeof dataTableFeatures,
    columns: withFilterFns(columns) as Parameters<typeof constructTable<typeof dataTableFeatures, Row>>[0]["columns"],
    data,
    state: { columnFilters },
  });
  return table.getFilteredRowModel().rows.map((r) => r.original.agencyName);
}

describe("shared table column filters", () => {
  it("filter by text, Turkish case-insensitive, and by a choice", () => {
    expect(filtered([{ id: "agencyName", value: "yang" }])).toEqual(["Yang Ming"]);
    expect(filtered([{ id: "agencyName", value: "OCEAN" }])).toEqual(["Ocean Network Express"]);
    expect(filtered([{ id: "status", value: "PAID" }])).toEqual(["Yang Ming", "Ocean Network Express"]);
  });
});
