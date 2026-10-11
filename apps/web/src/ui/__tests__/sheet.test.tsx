import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Button } from "@/ui/button";
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/ui/sheet";

function NoteSheet({ side }: { side?: "right" | "bottom" }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button>New note</Button>
      </SheetTrigger>
      <SheetContent side={side}>
        <SheetHeader>
          <SheetTitle>New note</SheetTitle>
          <SheetDescription>Paste a synthetic chart note for P-003.</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <label htmlFor="note">Note text</label>
          <textarea id="note" />
        </SheetBody>
        <SheetFooter>
          <SheetClose asChild>
            <Button>Cancel</Button>
          </SheetClose>
          <Button variant="primary">Save note</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

describe("Sheet", () => {
  it("opens a named, described modal dialog on the right by default, as glass chrome", async () => {
    const user = userEvent.setup();
    render(<NoteSheet />);
    await user.click(screen.getByRole("button", { name: "New note" }));
    const dialog = await screen.findByRole("dialog", { name: "New note" });
    expect(dialog).toHaveAccessibleDescription("Paste a synthetic chart note for P-003.");
    expect(dialog).toHaveAttribute("data-side", "right");
    expect(dialog).toHaveClass("glass-strong", "rounded-sheet", "max-w-[480px]");
  });

  it("moves focus inside, traps Tab, and closes on Escape returning focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<NoteSheet />);
    const trigger = screen.getByRole("button", { name: "New note" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);

    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("closes from the labelled close button and from SheetClose", async () => {
    const user = userEvent.setup();
    render(<NoteSheet />);
    await user.click(screen.getByRole("button", { name: "New note" }));
    await user.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "New note" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("supports a bottom sheet without the side-sheet width cap", async () => {
    const user = userEvent.setup();
    render(<NoteSheet side="bottom" />);
    await user.click(screen.getByRole("button", { name: "New note" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("data-side", "bottom");
    expect(dialog).toHaveClass("bottom-2", "max-h-[85vh]");
    expect(dialog).not.toHaveClass("max-w-[480px]");
  });

  it("lets focus and clicks reach a toast without closing the sheet, then returns focus", async () => {
    const user = userEvent.setup();
    render(
      <>
        <NoteSheet />
        <section aria-live="polite" aria-label="Notifications">
          <ol data-sonner-toaster="">
            {/* index.css gives visible toasts pointer-events:auto; jsdom loads no CSS. */}
            <li data-sonner-toast="" style={{ pointerEvents: "auto" }}>
              <button type="button">Undo</button>
            </li>
          </ol>
        </section>
      </>,
    );
    await user.click(screen.getByRole("button", { name: "New note" }));
    const dialog = await screen.findByRole("dialog", { name: "New note" });
    const note = screen.getByLabelText("Note text");
    note.focus();

    // Keyboard (sonner's Alt+T moves focus to the toaster): the focus trap lets it stay.
    const undo = screen.getByRole("button", { name: "Undo", hidden: true });
    undo.focus();
    expect(undo).toHaveFocus();
    expect(dialog).toBeInTheDocument();

    // Escape on the toast goes back into the sheet instead of closing it.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "New note" })).toBeInTheDocument();
    expect(note).toHaveFocus();

    // A pointer press on the toast does not dismiss the sheet either.
    await user.pointer({ keys: "[MouseLeft]", target: undo });
    expect(screen.getByRole("dialog", { name: "New note" })).toBeInTheDocument();
    await waitFor(() => expect(document.body).not.toHaveFocus());
  });
});
