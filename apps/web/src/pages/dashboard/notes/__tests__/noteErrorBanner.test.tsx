import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { ApiError } from "../../../../lib/api";
import { duplicateNoteOf } from "../duplicateNote";
import { NoteErrorBanner } from "../NoteErrorBanner";

const NOTE_ID = "01JNOTE0000000000000000001";
const dup = new ApiError("/api/v1/notes", {
  type: "about:blank",
  title: "Duplicate note",
  status: 409,
  detail:
    `This note (same participant, note date 2026-10-10 and text) was already ingested at ` +
    `2026-10-10T22:15:00Z as note ${NOTE_ID}; open it instead of ingesting it again`,
  existing_note_id: NOTE_ID,
  existing_note_url: `/dashboard/notes/${NOTE_ID}`,
});

describe("NoteErrorBanner", () => {
  it("reads the existing note and ingest time from a 409 duplicate problem", () => {
    expect(duplicateNoteOf(dup)).toEqual({
      url: `/dashboard/notes/${NOTE_ID}`,
      ingestedAt: "2026-10-10T22:15:00Z",
    });
    expect(duplicateNoteOf(new Error("x"))).toBeNull();
    expect(
      duplicateNoteOf(new ApiError("/x", { type: "t", title: "Conflict", status: 409 })),
    ).toBeNull();
  });

  it("says it in plain words and links to the existing record, with no raw id", () => {
    render(
      <MemoryRouter>
        <NoteErrorBanner error={dup} message="The call was not logged" />
      </MemoryRouter>,
    );
    const banner = screen.getByTestId("duplicate-note");
    expect(banner).toHaveTextContent("This was already recorded");
    expect(banner).not.toHaveTextContent(NOTE_ID);
    expect(banner).not.toHaveTextContent("HTTP 409");
    expect(screen.getByRole("link", { name: "Open the existing record" })).toHaveAttribute(
      "href",
      `/dashboard/notes/${NOTE_ID}`,
    );
  });

  it("falls back to the shared banner for any other error", () => {
    render(
      <MemoryRouter>
        <NoteErrorBanner
          error={new ApiError("/x", { type: "t", title: "Bad", status: 422, detail: "nope" })}
          message="The request was not accepted"
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("The request was not accepted");
    expect(screen.queryByTestId("duplicate-note")).toBeNull();
  });
});
