/**
 * DataTable: the one dense, opaque table for the coordinator console
 * (queue/worklist, escalations, audit, exports). Built on TanStack Table v8.
 *
 * Adapted from two 21st.dev components:
 * - "Data Table" by arihantcodes (https://21st.dev/community/components/arihantcodes/data-table,
 *   21st.dev demo 27049). Kept: sortable `<th>` with `aria-sort`, one Tab stop into the rows
 *   with arrow-key movement, Enter to open, Space to select, Escape to clear the selection,
 *   an sr-only caption, a polite live region that announces row/selection counts, skeleton
 *   rows while loading, an empty state. Removed: every spring/motion effect (row reorder,
 *   sweep-out deletion, rolling totals, flip digits, icon blur swaps, press scale), the
 *   column resize handles, quick-filter pills, search box, clipboard copy, totals footer,
 *   disclosure rows and pagination (pages own those; the server owns the order).
 * - "Data Table Row Selection" by felipemenezes098
 *   (https://21st.dev/community/components/felipemenezes098/table-row-selection, demo 22168).
 *   Kept: the TanStack `rowSelection` state, a select-all checkbox with an indeterminate
 *   state, and a bulk-action bar that shows "N selected" with Clear. Changed: native
 *   checkboxes instead of a Radix checkbox (no extra dependency), and the destructive
 *   "Delete" demo action is gone: bulk actions are supplied by the caller.
 *
 * Interim rules this component enforces (docs/ui-audit/UI_AUDIT.md, Q-01..Q-07):
 * - Opaque data surface: `bg-surface` + hairline `border-border`; no glass, no shadow on the
 *   panel. Sticky header uses `shadow-elev-1` (a 1px line), never a drop shadow.
 * - 36px rows (`h-row`), 13px cells (`text-table`), 6x10 cell padding; tabular figures only
 *   on columns marked `numeric` or `tabular` (applying them to every cell widens Inter's
 *   hyphens: "Check - in", "P - 007"). Headers are 12px caption, uppercase, +0.04em.
 *   "comfortable" density = 44px.
 * - The focused (j/k) row gets the `bg-surface-selected` fill plus the teal outline, and rows
 *   carry a scroll margin equal to the sticky header so the focused row never hides under it.
 * - Rows that cannot be bulk-selected show a small lock with the reason as a tooltip
 *   (`selectDisabledReason`) instead of a ghost checkbox.
 * - No page-level horizontal scroll: columns can opt out below a breakpoint with
 *   `hideBelow: "lg" | "xl"` (low-priority columns), and `scrollX` scrolls inside the panel.
 * - Whole-row link (Q-01): click anywhere on a row (outside a control) or press Enter on the
 *   focused row to call `onRowActivate`. Ctrl/Cmd/middle click opens `getRowHref(row)` in a
 *   new tab. Clicks on links, buttons, inputs and labels inside the row are left alone.
 * - Keyboard: one Tab stop (roving tabindex on rows). `j` / ArrowDown next row, `k` / ArrowUp
 *   previous, Home / End, Enter open, Space or `x` toggle selection, Escape clear selection.
 *   Keys are ignored while typing in a field and when a modifier key is held.
 * - Sorting never hides the server's order (audit "What not to do"): pass `manualSorting` and
 *   a controlled `sorting` / `onSortingChange` to drive a server sort param and the URL. With
 *   no sort state the rows render in the order given.
 * - No animated reordering, no motion at all beyond the global 150ms colour transition.
 *
 * ARIA: when rows are interactive (`onRowActivate` or `selectable`) the table is a
 * `role="grid"` (read-only) whose rows take focus and carry `aria-selected`; otherwise it is a
 * plain `<table>`. Sortable headers are `<th aria-sort>` containing a `<button>`.
 */
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type Row,
  type RowSelectionState,
  type SortingState,
  type Updater,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown, CircleX, Inbox, Lock, X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";
import { isTypingTarget } from "@/ui/keyboard";

/* ------------------------------------------------------------------ types -- */

/**
 * Per-column presentation hints. Put them on a column's `meta`
 * (`meta: { numeric: true } satisfies DataTableColumnMeta`).
 */
export interface DataTableColumnMeta {
  /** End-align the column (numbers, durations, counts) and use tabular figures. */
  numeric?: boolean;
  /** Tabular figures without end alignment (times, countdowns, vitals). */
  tabular?: boolean;
  /** Hide this (low-priority) column below the breakpoint so narrow screens never scroll sideways. */
  hideBelow?: "md" | "lg" | "xl";
  align?: "start" | "center" | "end";
  /** Render this column's cells as `<th scope="row">`, the row's name for screen readers. */
  rowHeader?: boolean;
  /** CSS width for the column, e.g. `"8rem"` or `120`. */
  width?: number | string;
  headerClassName?: string;
  cellClassName?: string;
  /** Accessible name for a header whose visible content is an icon or empty. */
  headerLabel?: string;
}

export interface DataTableBulkContext<TData> {
  rows: TData[];
  ids: string[];
  clear: () => void;
}

export type DataTableDensity = "compact" | "comfortable";

export interface DataTableProps<TData> {
  data: readonly TData[];
  // TanStack's ColumnDef needs `any` for the value type to accept mixed accessor columns.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<TData, any>[];
  /** Stable identity per row (selection, focus and React keys use it). */
  getRowId: (row: TData) => string;
  /** One sentence describing the table for screen readers. Not painted. */
  caption: string;
  /** A short name for a row, used in checkbox labels ("Select P-007"). Defaults to its id. */
  getRowLabel?: (row: TData) => string;

  /* Sorting */
  sorting?: SortingState;
  defaultSorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  /** The caller (server) sorts `data`; headers only report and request the sort. */
  manualSorting?: boolean;

  /* Selection */
  selectable?: boolean;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: (selection: RowSelectionState) => void;
  /** Rows that may not be selected (e.g. T2/T3, running clocks) show a lock, not a checkbox. */
  canSelectRow?: (row: TData) => boolean;
  /** Why a row cannot be selected; shown as the lock's tooltip and accessible name. */
  selectDisabledReason?: string | ((row: TData) => string);
  /** Actions for the bar shown while rows are selected. */
  bulkActions?: (context: DataTableBulkContext<TData>) => React.ReactNode;

  /* Row link */
  onRowActivate?: (row: TData) => void;
  /** Destination for Ctrl/Cmd/middle click (opens a new tab). */
  getRowHref?: (row: TData) => string;
  getRowClassName?: (row: TData) => string | undefined;

  /* States */
  loading?: boolean;
  skeletonRows?: number;
  /** When set, the body shows this message as an alert instead of rows. */
  error?: React.ReactNode;
  onRetry?: () => void;
  emptyState?: React.ReactNode;

  /* Layout */
  density?: DataTableDensity;
  stickyHeader?: boolean;
  /** CSS `top` for the sticky header, e.g. `"var(--appbar-h)"` under the app bar. */
  stickyTop?: string;
  /** Caps the height and scrolls inside the table (header sticks inside it). */
  maxHeight?: number | string;
  /** Allow horizontal scrolling inside the panel (sticky header then needs `maxHeight`). */
  scrollX?: boolean;
  /** Content above the table (filters, "Sorted by: priority (server)"). */
  toolbar?: React.ReactNode;
  className?: string;
}

/* ---------------------------------------------------------------- helpers -- */

const SELECT_COLUMN_ID = "__select";

function metaOf(meta: unknown): DataTableColumnMeta {
  return (meta ?? {}) as DataTableColumnMeta;
}

function resolve<T>(updater: Updater<T>, previous: T): T {
  return typeof updater === "function" ? (updater as (old: T) => T)(previous) : updater;
}

/** Controlled-or-uncontrolled state, the TanStack way. */
function useControllable<T>(
  controlled: T | undefined,
  initial: T,
  onChange: ((value: T) => void) | undefined,
): [T, OnChangeFn<T>] {
  const [inner, setInner] = React.useState<T>(initial);
  const value = controlled !== undefined ? controlled : inner;
  const set: OnChangeFn<T> = (updater) => {
    const next = resolve(updater, value);
    if (controlled === undefined) setInner(next);
    onChange?.(next);
  };
  return [value, set];
}

const INTERACTIVE =
  "a,button,input,select,textarea,label,summary,[role='button'],[role='link'],[contenteditable='true']";

function isInsideControl(target: EventTarget | null, row: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const hit = target.closest(INTERACTIVE);
  return hit !== null && hit !== row && row.contains(hit);
}

const ALIGN: Record<NonNullable<DataTableColumnMeta["align"]>, string> = {
  start: "text-left",
  center: "text-center",
  end: "text-right",
};

function alignOf(meta: DataTableColumnMeta): string {
  return ALIGN[meta.align ?? (meta.numeric ? "end" : "start")];
}

function widthStyle(meta: DataTableColumnMeta): React.CSSProperties | undefined {
  return meta.width !== undefined ? { width: meta.width } : undefined;
}

/** Literal classes (Tailwind's scanner needs them spelled out). */
const HIDE_BELOW: Record<NonNullable<DataTableColumnMeta["hideBelow"]>, string> = {
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
};

function columnClasses(meta: DataTableColumnMeta): string {
  return cn(
    alignOf(meta),
    (meta.numeric || meta.tabular) && "tabular",
    meta.hideBelow && HIDE_BELOW[meta.hideBelow],
  );
}

/* --------------------------------------------------------------- checkbox -- */

interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  indeterminate?: boolean;
}

/** Native checkbox with an indeterminate state; 16px box, 3:1 border, teal when checked. */
function Checkbox({ indeterminate = false, className, ...props }: CheckboxProps) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className={cn(
        "focus-ring size-4 cursor-pointer accent-primary align-middle",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

/* ------------------------------------------------------------------ table -- */

export function DataTable<TData>({
  data,
  columns,
  getRowId,
  caption,
  getRowLabel,
  sorting: sortingProp,
  defaultSorting = [],
  onSortingChange,
  manualSorting = false,
  selectable = false,
  rowSelection: rowSelectionProp,
  onRowSelectionChange,
  canSelectRow,
  selectDisabledReason = "Not available for bulk selection; review this row on its own.",
  bulkActions,
  onRowActivate,
  getRowHref,
  getRowClassName,
  loading = false,
  skeletonRows = 8,
  error,
  onRetry,
  emptyState,
  density = "compact",
  stickyHeader = true,
  stickyTop = "0px",
  maxHeight,
  scrollX = false,
  toolbar,
  className,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useControllable(sortingProp, defaultSorting, onSortingChange);
  const [rowSelection, setRowSelection] = useControllable<RowSelectionState>(
    rowSelectionProp,
    {},
    onRowSelectionChange,
  );

  const labelOf = React.useCallback(
    (row: TData) => (getRowLabel ? getRowLabel(row) : getRowId(row)),
    [getRowLabel, getRowId],
  );

  const allColumns = React.useMemo(() => {
    if (!selectable) return columns;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const select: ColumnDef<TData, any> = {
      id: SELECT_COLUMN_ID,
      enableSorting: false,
      meta: { width: "2.5rem", headerLabel: "Select" } satisfies DataTableColumnMeta,
      header: ({ table }) => (
        <Checkbox
          aria-label="Select all rows"
          checked={table.getIsAllRowsSelected()}
          indeterminate={table.getIsSomeRowsSelected()}
          onChange={table.getToggleAllRowsSelectedHandler()}
        />
      ),
      cell: ({ row }) => {
        const label = labelOf(row.original);
        if (!row.getCanSelect()) {
          const reason =
            typeof selectDisabledReason === "function"
              ? selectDisabledReason(row.original)
              : selectDisabledReason;
          return (
            <span
              role="img"
              aria-label={`${label}: ${reason}`}
              title={reason}
              data-slot="select-locked"
              className="inline-flex size-4 items-center justify-center align-middle text-subtle-foreground"
            >
              <Lock aria-hidden="true" className="size-3.5" />
            </span>
          );
        }
        return (
          <Checkbox
            aria-label={`Select ${label}`}
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
          />
        );
      },
    };
    return [select, ...columns];
  }, [columns, selectable, labelOf, selectDisabledReason]);

  const table = useReactTable<TData>({
    data: data as TData[],
    columns: allColumns,
    getRowId: (row) => getRowId(row),
    state: { sorting, rowSelection },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: selectable
      ? (row: Row<TData>) => (canSelectRow ? canSelectRow(row.original) : true)
      : false,
    manualSorting,
    getCoreRowModel: getCoreRowModel(),
    ...(manualSorting ? {} : { getSortedRowModel: getSortedRowModel() }),
  });

  const rows = table.getRowModel().rows;
  const selectedRows = table.getSelectedRowModel().rows;
  const columnCount = table.getVisibleLeafColumns().length;
  const interactive = Boolean(onRowActivate) || selectable;
  const showRows = !loading && error == null;

  /* ---- roving focus over rows ---- */
  const [activeIndex, setActiveIndex] = React.useState(0);
  const rowRefs = React.useRef<(HTMLTableRowElement | null)[]>([]);
  const safeActive = Math.min(activeIndex, Math.max(rows.length - 1, 0));

  const focusRow = (index: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, index));
    setActiveIndex(clamped);
    const node = rowRefs.current[clamped];
    node?.focus();
    node?.scrollIntoView?.({ block: "nearest" });
  };

  const clearSelection = () => table.resetRowSelection();

  const onRowKeyDown = (
    event: React.KeyboardEvent<HTMLTableRowElement>,
    row: Row<TData>,
    index: number,
  ) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (isTypingTarget(event.target)) return;
    const onRow = event.target === event.currentTarget;
    switch (event.key) {
      case "j":
      case "ArrowDown":
        event.preventDefault();
        focusRow(index + 1);
        return;
      case "k":
      case "ArrowUp":
        event.preventDefault();
        focusRow(index - 1);
        return;
      case "Home":
        if (!onRow) return;
        event.preventDefault();
        focusRow(0);
        return;
      case "End":
        if (!onRow) return;
        event.preventDefault();
        focusRow(rows.length - 1);
        return;
      case "Enter":
        if (!onRow || !onRowActivate) return;
        event.preventDefault();
        onRowActivate(row.original);
        return;
      case " ":
      case "x":
        if (!onRow || !selectable || !row.getCanSelect()) return;
        event.preventDefault();
        row.toggleSelected();
        return;
      case "Escape":
        if (selectedRows.length === 0) return;
        event.preventDefault();
        clearSelection();
        return;
      default:
        return;
    }
  };

  const onRowClick = (event: React.MouseEvent<HTMLTableRowElement>, row: Row<TData>) => {
    if (isInsideControl(event.target, event.currentTarget)) return;
    const href = getRowHref?.(row.original);
    if (href && (event.ctrlKey || event.metaKey)) {
      window.open(href, "_blank", "noopener");
      return;
    }
    onRowActivate?.(row.original);
  };

  const onRowAuxClick = (event: React.MouseEvent<HTMLTableRowElement>, row: Row<TData>) => {
    if (event.button !== 1 || isInsideControl(event.target, event.currentTarget)) return;
    const href = getRowHref?.(row.original);
    if (href) window.open(href, "_blank", "noopener");
  };

  /* ---- live status (one region, always rendered) ---- */
  const status = loading
    ? "Loading rows"
    : error != null
      ? "Rows could not be loaded"
      : `${rows.length} ${rows.length === 1 ? "row" : "rows"}${
          selectedRows.length > 0 ? `, ${selectedRows.length} selected` : ""
        }`;

  const rowHeight = density === "compact" ? "h-row" : "h-row-comfy";
  // scrollIntoView / focus stop below the sticky header (and the app bar above it).
  const rowScrollMargin: React.CSSProperties | undefined = stickyHeader
    ? { scrollMarginTop: `calc(${stickyTop} + var(--row-h, 36px))` }
    : undefined;
  const cellPad = "px-2.5 py-1.5";

  return (
    <div className={cn("flex w-full flex-col gap-2", className)}>
      {toolbar}

      {selectable && selectedRows.length > 0 ? (
        <div
          role="toolbar"
          aria-label="Actions for selected rows"
          className="flex min-h-row flex-wrap items-center gap-2 rounded-panel border border-border bg-surface-selected px-2.5 py-1 text-body"
        >
          <span className="tabular font-medium text-foreground">
            {selectedRows.length} selected
          </span>
          <span aria-hidden="true" className="h-4 w-px bg-border-strong" />
          {bulkActions?.({
            rows: selectedRows.map((r) => r.original),
            ids: selectedRows.map((r) => r.id),
            clear: clearSelection,
          })}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            leadingIcon={<X />}
            onClick={clearSelection}
          >
            Clear selection
          </Button>
        </div>
      ) : null}

      <div
        className={cn(
          "relative w-full rounded-panel border border-border bg-surface",
          maxHeight !== undefined
            ? "overflow-auto overscroll-contain"
            : scrollX
              ? "overflow-x-auto"
              : "",
        )}
        style={maxHeight !== undefined ? { maxHeight } : undefined}
      >
        <table
          role={interactive ? "grid" : undefined}
          aria-readonly={interactive ? true : undefined}
          aria-multiselectable={interactive && selectable ? true : undefined}
          aria-busy={loading || undefined}
          aria-rowcount={showRows ? rows.length + 1 : undefined}
          className="w-full border-separate border-spacing-0 text-table text-foreground"
        >
          <caption className="sr-only">{caption}</caption>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const meta = metaOf(header.column.columnDef.meta);
                  const canSort = header.column.getCanSort();
                  const dir = header.column.getIsSorted();
                  const content = header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext());
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={
                        canSort
                          ? dir === "asc"
                            ? "ascending"
                            : dir === "desc"
                              ? "descending"
                              : "none"
                          : undefined
                      }
                      aria-label={meta.headerLabel}
                      style={{ ...widthStyle(meta), ...(stickyHeader ? { top: stickyTop } : {}) }}
                      className={cn(
                        "h-row border-b border-border bg-surface-subtle align-middle",
                        "text-caption font-medium uppercase tracking-[0.04em] text-muted-foreground",
                        "first:rounded-tl-panel last:rounded-tr-panel",
                        cellPad,
                        columnClasses(meta),
                        stickyHeader && "sticky z-10 shadow-elev-1",
                        meta.headerClassName,
                      )}
                    >
                      {canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            "focus-ring transition-calm -mx-1 inline-flex items-center gap-1 rounded-control px-1 py-0.5",
                            "uppercase tracking-[0.04em] hover:bg-surface hover:text-foreground",
                            meta.numeric && "flex-row-reverse",
                            dir && "text-foreground",
                          )}
                        >
                          <span>{content}</span>
                          <span aria-hidden="true" className="inline-flex [&_svg]:size-3.5">
                            {dir === "asc" ? (
                              <ArrowUp />
                            ) : dir === "desc" ? (
                              <ArrowDown />
                            ) : (
                              <ChevronsUpDown className="text-subtle-foreground" />
                            )}
                          </span>
                        </button>
                      ) : (
                        content
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>

          <tbody>
            {loading
              ? Array.from({ length: skeletonRows }, (_, i) => (
                  <tr key={`skeleton-${i}`} aria-hidden="true" className={rowHeight}>
                    {Array.from({ length: columnCount }, (__, c) => (
                      <td key={c} className={cn(cellPad, "border-b border-border")}>
                        <span className="block h-3 w-3/4 rounded-control bg-surface-subtle" />
                      </td>
                    ))}
                  </tr>
                ))
              : null}

            {!loading && error != null ? (
              <tr>
                <td colSpan={columnCount} className="px-4 py-8">
                  <div
                    role="alert"
                    className="flex flex-wrap items-center justify-center gap-3 text-body text-foreground"
                  >
                    <CircleX aria-hidden="true" className="size-4 text-destructive" />
                    <span>{error}</span>
                    {onRetry ? (
                      <Button size="sm" variant="secondary" onClick={onRetry}>
                        Retry
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ) : null}

            {showRows && rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columnCount}
                  className="px-4 py-8 text-center text-body text-muted-foreground"
                >
                  {emptyState ?? (
                    <span className="inline-flex items-center gap-2">
                      <Inbox aria-hidden="true" className="size-4" />
                      No rows to show.
                    </span>
                  )}
                </td>
              </tr>
            ) : null}

            {showRows
              ? rows.map((row, index) => {
                  const selected = row.getIsSelected();
                  return (
                    <tr
                      key={row.id}
                      ref={(node) => {
                        rowRefs.current[index] = node;
                      }}
                      data-row-id={row.id}
                      data-state={selected ? "selected" : undefined}
                      aria-rowindex={index + 2}
                      aria-selected={interactive && selectable ? selected : undefined}
                      data-current={interactive && index === safeActive ? "" : undefined}
                      tabIndex={interactive ? (index === safeActive ? 0 : -1) : undefined}
                      onFocus={interactive ? () => setActiveIndex(index) : undefined}
                      onKeyDown={
                        interactive ? (event) => onRowKeyDown(event, row, index) : undefined
                      }
                      onClick={
                        onRowActivate || getRowHref ? (event) => onRowClick(event, row) : undefined
                      }
                      onAuxClick={getRowHref ? (event) => onRowAuxClick(event, row) : undefined}
                      style={rowScrollMargin}
                      className={cn(
                        rowHeight,
                        "transition-calm",
                        interactive && "focus-visible:[outline-offset:calc(var(--focus-width)*-1)]",
                        onRowActivate && "cursor-pointer",
                        selected ? "bg-surface-selected" : "hover:bg-surface-subtle",
                        // The focused (j/k) row: fill + outline, so it is easy to spot.
                        interactive && "focus-visible:bg-surface-selected",
                        getRowClassName?.(row.original),
                      )}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const meta = metaOf(cell.column.columnDef.meta);
                        const Cell = meta.rowHeader ? "th" : "td";
                        return (
                          <Cell
                            key={cell.id}
                            scope={meta.rowHeader ? "row" : undefined}
                            style={widthStyle(meta)}
                            className={cn(
                              cellPad,
                              "border-b border-border align-middle font-normal",
                              columnClasses(meta),
                              meta.cellClassName,
                            )}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </Cell>
                        );
                      })}
                    </tr>
                  );
                })
              : null}
          </tbody>
        </table>
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {status}
      </div>
    </div>
  );
}
