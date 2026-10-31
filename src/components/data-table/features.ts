import {
  columnFilteringFeature,
  columnOrderingFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  metaHelper,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_basic,
  sortFn_datetime,
  tableFeatures,
  type Row,
  type RowData,
} from "@tanstack/react-table";
import type { TranslationKey } from "@/i18n";
import { matchesSearch } from "@/lib/search";

export type FilterOption = { value: string; label: TranslationKey };

export type DataColumnMeta = {
  /** Column title in headers and column menus. */
  label: TranslationKey;
  align?: "start" | "end";
  /** Display text of a value, used by search, filters, CSV export and copy. Defaults to String(value). */
  toText?: (value: unknown) => string;
  /** Per-column filter: free text, or a choice list matched against the raw value (or any array element). */
  filter?: "text" | { options: FilterOption[] };
  /** Set false to leave the column out of the table search. */
  searchable?: boolean;
};

const collator = new Intl.Collator("tr-TR", { sensitivity: "base", numeric: true });

// Row type is left open here: the registry is shared by every table.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Row<any, any>;

/** A cell value as the table shows it in text: what search, filters and exports use. */
export function valueText(value: unknown, meta: DataColumnMeta | undefined): string {
  if (value === null || value === undefined) return "";
  if (meta?.toText) return meta.toText(value);
  return Array.isArray(value) ? value.join(" ") : String(value);
}

function cellText(row: AnyRow, columnId: string): string {
  return valueText(row.getValue(columnId), row.table.getColumn(columnId)?.columnDef.meta as DataColumnMeta | undefined);
}

/** Turkish case- and accent-insensitive "contains" on the column's display text. */
const textSearch = Object.assign(
  (row: AnyRow, columnId: string, filterValue: unknown) => matchesSearch(cellText(row, columnId), String(filterValue ?? "")),
  { autoRemove: (value: unknown) => typeof value !== "string" || value.trim() === "" },
);

/** Exact match on the raw value; for arrays, any element matches. */
const oneOf = Object.assign(
  (row: AnyRow, columnId: string, filterValue: unknown) => {
    const value = row.getValue(columnId);
    return Array.isArray(value) ? value.includes(filterValue) : String(value) === String(filterValue);
  },
  { autoRemove: (value: unknown) => value === undefined || value === "" },
);

/** Turkish alphabetical order (ç after c, ı before i, ...), numbers compared numerically. */
const turkishText = (rowA: AnyRow, rowB: AnyRow, columnId: string) =>
  collator.compare(cellText(rowA, columnId), cellText(rowB, columnId));

export const dataTableFeatures = tableFeatures({
  columnMeta: metaHelper<DataColumnMeta>(),
  columnVisibilityFeature,
  columnOrderingFeature,
  rowSelectionFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { textSearch, oneOf },
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { turkishText, basic: sortFn_basic, datetime: sortFn_datetime },
});

export type DataTableFeatures = typeof dataTableFeatures;

/** Column helper bound to the shared table features; build columns at module scope. */
export function dataTableColumns<TData extends RowData>() {
  return createColumnHelper<DataTableFeatures, TData>();
}
