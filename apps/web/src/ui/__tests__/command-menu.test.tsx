/**
 * CommandMenu + useCommandMenu: Ctrl/Cmd+K toggles, "/" opens (not while typing), items are
 * grouped in the caller's order with kbd hints, search filters by label/id/keywords, Enter
 * runs the highlighted item and closes, Escape closes.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileText, ListChecks } from "lucide-react";
import * as React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { CommandMenu, type CommandMenuItem } from "@/ui/command-menu";
import { useCommandMenu, type UseCommandMenuOptions } from "@/ui/use-command-menu";

beforeAll(() => {
  // jsdom lacks these; cmdk scrolls the active item into view and measures the list.
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function makeItems(spy: (id: string) => void): CommandMenuItem[] {
  return [
    {
      id: "p-007",
      label: "P-007",
      group: "Participants",
      hint: "Tier 2 · last check-in 14:02",
      onSelect: () => spy("p-007"),
    },
    {
      id: "go-queue",
      label: "Queue",
      group: "Go to",
      icon: <ListChecks />,
      shortcut: "G Q",
      onSelect: () => spy("go-queue"),
    },
    {
      id: "go-audit",
      label: "Audit log",
      group: "Go to",
      icon: <FileText />,
      shortcut: { keys: ["Ctrl", "A"], kind: "combo" },
      keywords: ["hash chain", "verify"],
      onSelect: () => spy("go-audit"),
    },
  ];
}

function Harness({ spy, options }: { spy: (id: string) => void; options?: UseCommandMenuOptions }) {
  const menu = useCommandMenu(options);
  return (
    <>
      <input aria-label="Notes" />
      <CommandMenu
        open={menu.open}
        onOpenChange={menu.setOpen}
        items={makeItems(spy)}
        groups={["Go to", "Participants"]}
      />
    </>
  );
}

describe("useCommandMenu + CommandMenu", () => {
  it("toggles with Ctrl+K and Meta+K", async () => {
    const user = userEvent.setup();
    render(<Harness spy={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog", { name: "Command menu" })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveFocus();

    await user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens with '/' only when enabled and not while typing in a field", async () => {
    const user = userEvent.setup();
    render(<Harness spy={vi.fn()} options={{ slash: true }} />);
    await user.click(screen.getByRole("textbox", { name: "Notes" }));
    await user.keyboard("/");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue("/");

    act(() => (document.activeElement as HTMLElement).blur());
    await user.keyboard("/");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not register shortcuts when disabled", async () => {
    const user = userEvent.setup();
    render(<Harness spy={vi.fn()} options={{ enabled: false }} />);
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders groups in the caller's order with kbd hints hidden from the item name", async () => {
    const user = userEvent.setup();
    render(<Harness spy={vi.fn()} />);
    await user.keyboard("{Control>}k{/Control}");

    const groups = screen.getAllByRole("group");
    const names = groups.map(
      (g) => document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent,
    );
    expect(names).toEqual(["Go to", "Participants"]);

    const queue = screen.getByRole("option", { name: /queue/i });
    // Sequence "G Q": two caps; the hint is hidden so the option's name stays "Queue".
    expect([...queue.querySelectorAll("kbd kbd")].map((k) => k.textContent)).toEqual(["G", "Q"]);
    expect(queue.querySelector("[data-slot='kbd-sequence']")!.parentElement).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(queue).toHaveAccessibleName("Queue");
    const audit = screen.getByRole("option", { name: /audit log/i });
    expect([...audit.querySelectorAll("kbd kbd")].map((k) => k.textContent)).toEqual(["Ctrl", "A"]);
    expect(audit.querySelector("[data-slot='kbd-combo']")).toBeInTheDocument();
  });

  it("filters by label, id and keywords; shows the empty text", async () => {
    const user = userEvent.setup();
    render(<Harness spy={vi.fn()} />);
    await user.keyboard("{Control>}k{/Control}");
    const input = screen.getByRole("combobox");

    await user.type(input, "hash chain");
    expect(screen.getByRole("option", { name: /audit log/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /queue/i })).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "zzzz-nothing");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matches.")).toBeInTheDocument();
  });

  it("runs the highlighted item on Enter and closes", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("combobox"), "P-007");
    await user.keyboard("{Enter}");
    expect(spy).toHaveBeenCalledWith("p-007");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("runs an item on click and closes with Escape", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    await user.keyboard("{Control>}k{/Control}");
    await user.click(screen.getByRole("option", { name: /queue/i }));
    expect(spy).toHaveBeenCalledWith("go-queue");

    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("returns focus to the element that opened it when it closes (no Radix Trigger)", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Opener</button>
        <Harness spy={vi.fn()} />
      </>,
    );
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("falls back to the header trigger when the opener is gone", async () => {
    const user = userEvent.setup();
    let hide: () => void = () => {};
    function Removable() {
      const [show, setShow] = React.useState(true);
      hide = () => setShow(false);
      return (
        <>
          <button type="button" data-command-menu-trigger="">
            Jump to…
          </button>
          {show ? (
            <button type="button" onClick={() => setShow(false)}>
              Temporary
            </button>
          ) : null}
          <Harness spy={vi.fn()} />
        </>
      );
    }
    render(<Removable />);
    const temp = screen.getByRole("button", { name: "Temporary" });
    temp.focus();
    await user.keyboard("{Control>}k{/Control}");
    // Simulate the opener disappearing while the menu is open.
    act(() => hide());
    expect(temp).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Jump to…" })).toHaveFocus());
  });

  it("uses glass chrome for the panel and an opaque pill for the highlighted item", async () => {
    const user = userEvent.setup();
    render(<Harness spy={vi.fn()} />);
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog")).toHaveClass("glass-strong", "rounded-sheet");
    const first = screen.getAllByRole("option")[0]!;
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(first.className).toContain("data-[selected=true]:bg-accent");
  });
});
