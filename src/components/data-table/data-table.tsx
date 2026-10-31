"use client";

import {
  useTable,
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnOrderState,
  type ColumnVisibilityState,
  type RowData,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Columns3, Copy, Download, Filter, Pencil, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { saveTableLayoutAction } from "@/app/(app)/preferences-actions";
import { toastWithUndo } from "@/components/undo-toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { istanbulToday } from "@/domain/business-days";
import { t } from "@/i18n";
import { copyText } from "@/lib/clipboard";
import { exportFileName, toCsv, toTsv, type Grid } from "@/lib/csv";
import { DEFAULT_TABLE_LAYOUT, type TableLayout } from "@/lib/schemas/table-layout";
import { cn } from "@/lib/utils";
import { valueText, dataTableColumns, dataTableFeatures, type DataColumnMeta, type DataTableFeatures } from "./features";

const SELECT_COLUMN_ID = "_select";
const SAVE_DELAY_MS = 600;

export type DataTableProps<TData extends RowData> = {
  /** Key under which each user's layout is stored; lowercase letters, digits and dashes. */
  tableId: string;
  data: TData[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<DataTableFeatures, TData, any>[];
  getRowId: (row: TData) => string;
  initialLayout: TableLayout | null;
  /**
   * Filters a link opened the table with (e.g. from the dashboard). They replace the saved
   * filters for this visit, and the layout is not saved meanwhile, so the link does not change
   * the user's own layout.
   */
  initialFilters?: ColumnFiltersState;
  /**
   * Enter, or a click on a row, opens it (usually in the detail dialog). `visible` is every
   * row as the table shows it now (sorted and filtered), for previous/next in the detail.
   */
  onOpenRow?: (row: TData, visible: TData[]) => void;
  /** Screen-specific actions in the bar shown while rows are selected, next to "copy". */
  bulkActions?: (selected: TData[], clearSelection: () => void) => ReactNode;
  /** Extra controls on the right of the toolbar, e.g. a "new" button. */
  toolbar?: ReactNode;
  /** Letter shortcuts of the screen (lower-case key), given the selected rows, or the active row when none is selected. */
  shortcuts?: Record<string, (rows: TData[], clearSelection: () => void) => void>;
  rowClassName?: (row: TData) => string | undefined;
};

export function DataTable<TData extends RowData>({
  tableId,
  data,
  columns,
  getRowId,
  initialLayout,
  initialFilters,
  onOpenRow,
  bulkActions,
  toolbar,
  shortcuts,
  rowClassName,
}: DataTableProps<TData>) {
  const start = initialLayout ?? DEFAULT_TABLE_LAYOUT;
  const [sorting, setSorting] = useState<SortingState>(start.sorting);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(initialFilters ?? start.columnFilters);
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>(start.columnVisibility);
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(start.columnOrder);
  const [density, setDensity] = useState(start.density);
  const [showFilters, setShowFilters] = useState(initialFilters ? true : start.showFilters);
  const [globalFilter, setGlobalFilter] = useState("");
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [activeIndex, setActiveIndex] = useState(-1);
  const [editing, setEditing] = useState<{ rowId: string; columnId: string; text: string; saving: boolean } | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const router = useRouter();

  // Every table selects rows: at least for copying them.
  const allColumns = useMemo(() => [selectionColumn<TData>(), ...columns], [columns]);
  const effectiveOrder = useMemo(
    () => (columnOrder.length > 0 ? [SELECT_COLUMN_ID, ...columnOrder.filter((id) => id !== SELECT_COLUMN_ID)] : columnOrder),
    [columnOrder],
  );

  const table = useTable({
    features: dataTableFeatures,
    columns: allColumns,
    data,
    getRowId,
    state: { sorting, columnFilters, columnVisibility, columnOrder: effectiveOrder, globalFilter, rowSelection },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnOrderChange: setColumnOrder,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: true,
    globalFilterFn: "textSearch",
    getColumnCanGlobalFilter: (column) =>
      column.id !== SELECT_COLUMN_ID && (column.columnDef.meta as DataColumnMeta | undefined)?.searchable !== false,
  });

  // Persist the personal layout (not search text or selection) shortly after it changes.
  const layout = useMemo<TableLayout>(
    () => ({ sorting, columnFilters, columnVisibility, columnOrder, density, showFilters }) as TableLayout,
    [sorting, columnFilters, columnVisibility, columnOrder, density, showFilters],
  );
  const savedLayout = useRef(JSON.stringify(layout));
  const persist = initialFilters === undefined;
  useEffect(() => {
    const serialized = JSON.stringify(layout);
    if (!persist || serialized === savedLayout.current) return;
    const timer = setTimeout(async () => {
      savedLayout.current = serialized;
      // Table state objects are not plain objects; send the JSON copy so the server receives real values.
      const result = await saveTableLayoutAction({ tableId, layout: JSON.parse(serialized) });
      if (!result.ok) console.error("Table layout was not saved:", result);
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [layout, tableId, persist]);

  const resetLayout = () => {
    setSorting(DEFAULT_TABLE_LAYOUT.sorting);
    setColumnFilters(DEFAULT_TABLE_LAYOUT.columnFilters);
    setColumnVisibility(DEFAULT_TABLE_LAYOUT.columnVisibility);
    setColumnOrder(DEFAULT_TABLE_LAYOUT.columnOrder);
    setDensity(DEFAULT_TABLE_LAYOUT.density);
    setShowFilters(DEFAULT_TABLE_LAYOUT.showFilters);
  };

  const rows = table.getRowModel().rows;
  const selectedRows = table.getSelectedRowModel().rows.map((row) => row.original);
  const clearSelection = useCallback(() => setRowSelection({}), []);
  const leafColumns = table.getAllLeafColumns().filter((column) => column.id !== SELECT_COLUMN_ID);

  /** The given rows as text, with the visible data columns in their current order (no action columns). */
  const grid = (gridRows: typeof rows): Grid => {
    const visible = table.getVisibleLeafColumns().filter((column) => column.accessorFn !== undefined);
    return {
      headers: visible.map((column) => {
        const meta = column.columnDef.meta as DataColumnMeta | undefined;
        return meta ? t(meta.label) : column.id;
      }),
      rows: gridRows.map((row) => visible.map((column) => valueText(row.getValue(column.id), column.columnDef.meta as DataColumnMeta | undefined))),
    };
  };

  /** The current view (visible columns, filters, search and sort) as a CSV file. */
  const downloadCsv = () => {
    const url = URL.createObjectURL(new Blob([toCsv(grid(rows))], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName(tableId, istanbulToday());
    link.click();
    URL.revokeObjectURL(url);
  };

  const editOf = (columnId: string) => (table.getColumn(columnId)?.columnDef.meta as DataColumnMeta | undefined)?.edit;

  /** Starts editing a cell, when its column allows it for this row. */
  const startEdit = (row: (typeof rows)[number], columnId: string) => {
    const edit = editOf(columnId);
    if (edit?.editable(row.original)) setEditing({ rowId: row.id, columnId, text: edit.text(row.original), saving: false });
  };

  const commitEdit = async (row: (typeof rows)[number]) => {
    if (!editing) return;
    const edit = editOf(editing.columnId)!;
    setEditing({ ...editing, saving: true });
    const result = await edit.save(row.original, editing.text);
    if (!result.ok) {
      const field = result.fieldErrors ? Object.values(result.fieldErrors)[0] : undefined;
      toast.error(t(field ?? result.error, result.params));
      setEditing({ ...editing, saving: false });
      return;
    }
    setEditing(null);
    toastWithUndo(t("table.edited"), result.data, () => router.refresh());
    router.refresh();
  };

  const copySelected = async () => {
    // In the order shown; selected rows a filter now hides come last.
    const shown = rows.filter((row) => row.getIsSelected());
    const hidden = table.getSelectedRowModel().rows.filter((row) => !shown.includes(row));
    await copyText(toTsv(grid([...shown, ...hidden])));
    toast.success(t("table.copiedRows", { count: selectedRows.length }));
  };

  const moveColumn = (columnId: string, delta: -1 | 1) => {
    const order = leafColumns.map((column) => column.id);
    const from = order.indexOf(columnId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    setColumnOrder(order);
  };

  const focusRow = (index: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, index));
    setActiveIndex(clamped);
    bodyRef.current?.children[clamped]?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (rows.length === 0) return;
    const active = rows[activeIndex];
    switch (event.key) {
      case "ArrowDown":
        focusRow(activeIndex + 1);
        break;
      case "ArrowUp":
        focusRow(activeIndex - 1);
        break;
      case "Home":
        focusRow(0);
        break;
      case "End":
        focusRow(rows.length - 1);
        break;
      case "Enter":
        if (active && onOpenRow) onOpenRow(active.original, rows.map((r) => r.original));
        break;
      case " ":
        if (active) active.toggleSelected();
        break;
      case "F2": {
        // Edits the first editable cell of the active row.
        const column = active && table.getVisibleLeafColumns().find((c) => editOf(c.id)?.editable(active.original));
        if (active && column) startEdit(active, column.id);
        break;
      }
      default: {
        const shortcut = shortcuts?.[event.key.toLowerCase()];
        if (!shortcut || event.ctrlKey || event.metaKey || event.altKey) return;
        shortcut(selectedRows.length > 0 ? selectedRows : active ? [active.original] : [], clearSelection);
      }
    }
    event.preventDefault();
  };

  const cellPadding = density === "compact" ? "px-2 py-1" : "px-3 py-2.5";
  const filteredOut = rows.length !== data.length;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={globalFilter}
          onChange={(event) => setGlobalFilter(event.target.value)}
          placeholder={t("table.search")}
          aria-label={t("table.search")}
          className="h-8 w-64"
        />
        <Button
          variant={showFilters ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setShowFilters((value) => !value)}
          aria-pressed={showFilters}
        >
          <Filter /> {t("table.filter")}
        </Button>
        {columnFilters.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setColumnFilters([])}>
            {t("table.clearFilters")}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              <Columns3 /> {t("table.columns")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>{t("table.columns")}</DropdownMenuLabel>
            {leafColumns.map((column, index) => {
              const meta = column.columnDef.meta as DataColumnMeta | undefined;
              return (
                <div key={column.id} className="flex items-center gap-1">
                  <DropdownMenuCheckboxItem
                    className="flex-1"
                    checked={column.getIsVisible()}
                    disabled={!column.getCanHide()}
                    onCheckedChange={(checked) => column.toggleVisibility(checked)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {meta ? t(meta.label) : column.id}
                  </DropdownMenuCheckboxItem>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label={t("table.moveLeft")}
                    disabled={index === 0}
                    onClick={() => moveColumn(column.id, -1)}
                  >
                    <ChevronLeft />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label={t("table.moveRight")}
                    disabled={index === leafColumns.length - 1}
                    onClick={() => moveColumn(column.id, 1)}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("table.density")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={density} onValueChange={(value) => setDensity(value as TableLayout["density"])}>
              <DropdownMenuRadioItem value="compact">{t("table.densityCompact")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="comfortable">{t("table.densityComfortable")}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={resetLayout}>
              <RotateCcw /> {t("table.resetLayout")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="sm" onClick={downloadCsv} disabled={rows.length === 0}>
          <Download /> {t("table.downloadCsv")}
        </Button>
        <div className="ml-auto flex items-center gap-2">{toolbar}</div>
      </div>

      {selectedRows.length > 0 && (
        <div className="bg-muted flex items-center gap-2 rounded-md px-3 py-1.5">
          <span className="font-medium">{t("table.selectedCount", { count: selectedRows.length })}</span>
          <Button variant="outline" size="sm" onClick={copySelected}>
            <Copy /> {t("common.copy")}
          </Button>
          {bulkActions?.(selectedRows, clearSelection)}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={clearSelection}>
            {t("table.clearSelection")}
          </Button>
        </div>
      )}

      <div
        className="focus-visible:ring-ring/50 min-h-0 overflow-auto rounded-md border outline-none focus-visible:ring-2"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() => activeIndex < 0 && rows.length > 0 && setActiveIndex(0)}
      >
        <table className="tabular w-full border-collapse">
          <thead className="bg-muted/60 sticky top-0 z-10">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const meta = header.column.columnDef.meta as DataColumnMeta | undefined;
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                      className={cn("border-b text-left font-medium whitespace-nowrap", cellPadding, meta?.align === "end" && "text-right")}
                    >
                      {header.column.id === SELECT_COLUMN_ID ? (
                        <Checkbox
                          aria-label={t("table.selectAll")}
                          checked={table.getIsAllRowsSelected() ? true : table.getIsSomeRowsSelected() ? "indeterminate" : false}
                          onCheckedChange={(checked) => table.toggleAllRowsSelected(checked === true)}
                        />
                      ) : header.column.getCanSort() ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 hover:underline"
                          onClick={header.column.getToggleSortingHandler()}
                          title={sorted === "asc" ? t("table.sortDescending") : t("table.sortAscending")}
                        >
                          {meta ? t(meta.label) : <table.FlexRender header={header} />}
                          {sorted === "asc" && <ArrowUp className="size-3.5" />}
                          {sorted === "desc" && <ArrowDown className="size-3.5" />}
                        </button>
                      ) : meta ? (
                        t(meta.label)
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
            {showFilters && (
              <tr>
                {table.getVisibleLeafColumns().map((column) => {
                  const meta = column.columnDef.meta as DataColumnMeta | undefined;
                  const value = (column.getFilterValue() as string | undefined) ?? "";
                  return (
                    <th key={column.id} className={cn("border-b font-normal", cellPadding)}>
                      {meta?.filter === "text" && (
                        <Input
                          value={value}
                          onChange={(event) => column.setFilterValue(event.target.value)}
                          placeholder={t("table.filterPlaceholder")}
                          aria-label={`${t(meta.label)} — ${t("table.filter")}`}
                          className="h-7"
                        />
                      )}
                      {meta?.filter && meta.filter !== "text" && (
                        <select
                          value={value}
                          onChange={(event) => column.setFilterValue(event.target.value || undefined)}
                          aria-label={`${t(meta.label)} — ${t("table.filter")}`}
                          className="border-input bg-background h-7 w-full rounded-md border px-1"
                        >
                          <option value="" />
                          {meta.filter.options.map((option) => (
                            <option key={option.value} value={option.value}>
                              {t(option.label)}
                            </option>
                          ))}
                        </select>
                      )}
                    </th>
                  );
                })}
              </tr>
            )}
          </thead>
          <tbody ref={bodyRef}>
            {rows.map((row, index) => (
              <tr
                key={row.id}
                aria-selected={row.getIsSelected()}
                data-active={index === activeIndex || undefined}
                onClick={() => {
                  setActiveIndex(index);
                  onOpenRow?.(row.original, rows.map((r) => r.original));
                }}
                className={cn(
                  "hover:bg-muted/50 border-b last:border-b-0",
                  onOpenRow && "cursor-pointer",
                  row.getIsSelected() && "bg-muted",
                  "data-[active]:outline-primary data-[active]:outline data-[active]:-outline-offset-1",
                  rowClassName?.(row.original),
                )}
              >
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta as DataColumnMeta | undefined;
                  return (
                    <td
                      key={cell.id}
                      className={cn("align-middle whitespace-nowrap", cellPadding, meta?.align === "end" && "text-right")}
                    >
                      {cell.column.id === SELECT_COLUMN_ID ? (
                        <Checkbox
                          aria-label={t("table.selectRow")}
                          checked={row.getIsSelected()}
                          onClick={(event) => {
                            event.stopPropagation();
                            row.getToggleSelectedHandler()(event);
                          }}
                        />
                      ) : editing && editing.rowId === row.id && editing.columnId === cell.column.id ? (
                        <Input
                          autoFocus
                          className="h-7 min-w-48"
                          aria-label={`${meta ? t(meta.label) : cell.column.id} — ${t("table.editCell")}`}
                          value={editing.text}
                          disabled={editing.saving}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Enter") void commitEdit(row);
                            if (event.key === "Escape") setEditing(null);
                          }}
                          onBlur={() => !editing.saving && setEditing(null)}
                        />
                      ) : meta?.edit?.editable(row.original) ? (
                        <span className="group/edit inline-flex items-center gap-1">
                          <table.FlexRender cell={cell} />
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-foreground opacity-0 group-hover/edit:opacity-100 focus-visible:opacity-100"
                            aria-label={`${t("table.editCell")}: ${t(meta.label)}`}
                            title={t("table.editHint")}
                            onClick={(event) => {
                              event.stopPropagation();
                              startEdit(row, cell.column.id);
                            }}
                          >
                            <Pencil className="size-3.5" />
                          </button>
                        </span>
                      ) : (
                        <table.FlexRender cell={cell} />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={table.getVisibleLeafColumns().length} className="text-muted-foreground px-3 py-6 text-center">
                  {t("table.noResults")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="text-muted-foreground text-xs">
        {filteredOut
          ? t("table.filteredRowCount", { count: rows.length, total: data.length })
          : t("table.rowCount", { count: data.length })}
      </div>
    </div>
  );
}

function selectionColumn<TData extends RowData>() {
  return dataTableColumns<TData>().display({
    id: SELECT_COLUMN_ID,
    enableHiding: false,
    enableSorting: false,
  });
}
