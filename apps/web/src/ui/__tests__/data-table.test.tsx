/**
 * DataTable: sorting (aria-sort, client and server/manual), whole-row activation, the
 * j/k/Enter keyboard model, row selection with the bulk-action bar, and the
 * loading / empty / error states.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ColumnDef } from "@tanstack/react-table";
import { describe, expect, it, vi } from "vitest";

import { DataTable, type DataTableColumnMeta } from "@/ui/data-table";

interface Row {
  id: string;
  participant: string;
  tier: number;
}

const DATA: Row[] = [
  { id: "a", participant: "P-003", tier: 1 },
  { id: "b", participant: "P-001", tier: 3 },
  { id: "c", participant: "P-002", tier: 0 },
];

const COLUMNS: ColumnDef<Row, unknown>[] = [
  {
    accessorKey: "participant",
    header: "Participant",
    meta: { rowHeader: true } satisfies DataTableColumnMeta,
  },
  {
    accessorKey: "tier",
    header: "Tier",
    sortDescFirst: true,
    meta: { numeric: true } satisfies DataTableColumnMeta,
  },
];

function bodyOrder(): string[] {
  const rows = screen.getAllByRole("row").slice(1); // drop the header row
  return rows.map((r) => within(r).getAllByRole("rowheader")[0]?.textContent ?? "");
}

describe("DataTable", () => {
  it("renders a captioned table with rows in the given (server) order and tabular cells", () => {
    render(
      <DataTable data={DATA} columns={COLUMNS} getRowId={(r) => r.id} caption="Check-in queue" />,
    );
    const table = screen.getByRole("table", { name: "Check-in queue" });
    expect(table).toHaveClass("text-table");
    // Tabular figures only on numeric columns: the id keeps proportional hyphens.
    expect(table).not.toHaveClass("tabular");
    expect(screen.getByRole("rowheader", { name: "P-003" })).not.toHaveClass("tabular");
    expect(within(screen.getAllByRole("row")[1]!).getByRole("cell")).toHaveClass("tabular");
    expect(bodyOrder()).toEqual(["P-003", "P-001", "P-002"]);
    expect(screen.getByRole("status")).toHaveTextContent("3 rows");
  });

  it("sorts on header click and reports aria-sort", async () => {
    const user = userEvent.setup();
    render(<DataTable data={DATA} columns={COLUMNS} getRowId={(r) => r.id} caption="Queue" />);
    const header = screen.getByRole("columnheader", { name: /tier/i });
    expect(header).toHaveAttribute("aria-sort", "none");

    await user.click(within(header).getByRole("button", { name: /tier/i }));
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(bodyOrder()).toEqual(["P-001", "P-003", "P-002"]);

    await user.click(within(header).getByRole("button", { name: /tier/i }));
    expect(header).toHaveAttribute("aria-sort", "ascending");
    expect(bodyOrder()).toEqual(["P-002", "P-003", "P-001"]);
  });

  it("with manualSorting only requests a sort and never reorders the rows itself", async () => {
    const user = userEvent.setup();
    const onSortingChange = vi.fn();
    render(
      <DataTable
        data={DATA}
        columns={COLUMNS}
        getRowId={(r) => r.id}
        caption="Queue"
        manualSorting
        sorting={[]}
        onSortingChange={onSortingChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: /participant/i }));
    expect(onSortingChange).toHaveBeenCalledWith([{ id: "participant", desc: false }]);
    expect(bodyOrder()).toEqual(["P-003", "P-001", "P-002"]);
  });

  it("activates a whole row on click, but not when a control inside it is clicked", async () => {
    const user = userEvent.setup();
    const onRowActivate = vi.fn();
    const onInner = vi.fn();
    const columns: ColumnDef<Row, unknown>[] = [
      ...COLUMNS,
      {
        id: "brief",
        header: "Brief",
        cell: () => (
          <button type="button" onClick={onInner}>
            Brief
          </button>
        ),
      },
    ];
    render(
      <DataTable
        data={DATA}
        columns={columns}
        getRowId={(r) => r.id}
        caption="Queue"
        onRowActivate={onRowActivate}
      />,
    );
    expect(screen.getByRole("grid", { name: "Queue" })).toBeInTheDocument();

    await user.click(screen.getByText("P-001"));
    expect(onRowActivate).toHaveBeenCalledWith(DATA[1]);

    await user.click(screen.getAllByRole("button", { name: "Brief" })[0]!);
    expect(onInner).toHaveBeenCalledTimes(1);
    expect(onRowActivate).toHaveBeenCalledTimes(1);
  });

  it("supports one Tab stop, j/k movement and Enter to open", async () => {
    const user = userEvent.setup();
    const onRowActivate = vi.fn();
    render(
      <DataTable
        data={DATA}
        columns={COLUMNS}
        getRowId={(r) => r.id}
        caption="Queue"
        onRowActivate={onRowActivate}
      />,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);

    await user.tab(); // first sortable header button
    await user.tab();
    await user.tab();
    expect(rows[0]).toHaveFocus();

    await user.keyboard("j");
    expect(rows[1]).toHaveFocus();
    await user.keyboard("j");
    expect(rows[2]).toHaveFocus();
    await user.keyboard("j"); // clamps at the end
    expect(rows[2]).toHaveFocus();
    await user.keyboard("k");
    expect(rows[1]).toHaveFocus();
    expect(rows[1]).toHaveAttribute("tabindex", "0");

    await user.keyboard("{Enter}");
    expect(onRowActivate).toHaveBeenCalledWith(DATA[1]);
  });

  it("selects rows, shows the bulk bar with the caller's actions, and clears", async () => {
    const user = userEvent.setup();
    const confirm = vi.fn();
    render(
      <DataTable
        data={DATA}
        columns={COLUMNS}
        getRowId={(r) => r.id}
        getRowLabel={(r) => r.participant}
        caption="Queue"
        selectable
        canSelectRow={(r) => r.tier < 2}
        bulkActions={({ ids }) => (
          <button type="button" onClick={() => confirm(ids)}>
            Confirm drafts
          </button>
        )}
      />,
    );
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    // A row that cannot be bulk-selected shows a lock with the reason, not a ghost checkbox.
    expect(screen.queryByRole("checkbox", { name: /p-001/i })).not.toBeInTheDocument();
    const lock = screen.getByRole("img", { name: /^P-001: Not available for bulk selection/ });
    expect(lock).toHaveAttribute("title", expect.stringMatching(/review this row on its own/));

    await user.click(screen.getByRole("checkbox", { name: "Select P-003" }));
    const bar = screen.getByRole("toolbar", { name: "Actions for selected rows" });
    expect(bar).toHaveTextContent("1 selected");
    expect(screen.getByRole("status")).toHaveTextContent("3 rows, 1 selected");

    // Select-all only takes the selectable rows (T2/T3 stay out).
    await user.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(bar).toHaveTextContent("2 selected");
    await user.click(within(bar).getByRole("button", { name: "Confirm drafts" }));
    expect(confirm).toHaveBeenCalledWith(["a", "c"]);

    await user.click(within(bar).getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("toggles selection with Space on a focused row and clears with Escape", async () => {
    const user = userEvent.setup();
    render(
      <DataTable data={DATA} columns={COLUMNS} getRowId={(r) => r.id} caption="Queue" selectable />,
    );
    const rows = screen.getAllByRole("row").slice(1);
    rows[0]!.focus();
    await user.keyboard(" ");
    expect(rows[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Escape}");
    expect(rows[0]).toHaveAttribute("aria-selected", "false");
  });

  it("shows skeleton rows and aria-busy while loading", () => {
    render(
      <DataTable
        data={[]}
        columns={COLUMNS}
        getRowId={(r) => r.id}
        caption="Queue"
        loading
        skeletonRows={4}
      />,
    );
    expect(screen.getByRole("table", { hidden: true })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Loading rows");
    expect(screen.getAllByRole("row", { hidden: true })).toHaveLength(5);
  });

  it("shows the empty state", () => {
    render(
      <DataTable
        data={[]}
        columns={COLUMNS}
        getRowId={(r) => r.id}
        caption="Queue"
        emptyState="Nothing needs action."
      />,
    );
    expect(screen.getByText("Nothing needs action.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("0 rows");
  });

  it("shows an error alert with Retry", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <DataTable
        data={DATA}
        columns={COLUMNS}
        getRowId={(r) => r.id}
        caption="Queue"
        error="The queue could not be loaded."
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("The queue could not be loaded.");
    expect(screen.queryByText("P-001")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
