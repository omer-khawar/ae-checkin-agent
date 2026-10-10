import { describe, expect, it, vi } from "vitest";

import {
  type ApiError,
  AUTH_STORAGE_KEY,
  buildQuery,
  createSession,
  describeError,
  fetchAllPages,
  getQueue,
  isApiError,
  NetworkError,
  pageInfo,
  pageParams,
  parseProblem,
} from "../lib/api";
import { installMockFetch } from "./mockFetch";

describe("api client", () => {
  it("turns problem+json into an ApiError with the problem fields", async () => {
    installMockFetch([
      {
        method: "POST",
        path: "/api/v1/sessions",
        handler: () => ({
          status: 404,
          json: {
            type: "https://interim.example/problems/participant-not-found",
            title: "Participant not found",
            status: 404,
            detail: "No participant with usubjid P-999",
            instance: "/api/v1/sessions",
          },
        }),
      },
    ]);
    const err = await createSession({ usubjid: "P-999", consent_camera: false }).catch(
      (e: unknown) => e,
    );
    expect(isApiError(err)).toBe(true);
    const api = err as ApiError;
    expect(api.status).toBe(404);
    expect(api.isNotFound).toBe(true);
    expect(api.problem.title).toBe("Participant not found");
    expect(api.problem.detail).toBe("No participant with usubjid P-999");
    expect(api.problem.type).toContain("participant-not-found");
    expect(api.message).toBe("Participant not found: No participant with usubjid P-999");
    expect(describeError(api)).toContain("Participant not found");
  });

  it("parseProblem copes with FastAPI {detail} and plain text bodies", async () => {
    const fastapi = {
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      text: async () =>
        JSON.stringify({ detail: [{ loc: ["body", "usubjid"], msg: "field required" }] }),
    } as unknown as Response;
    const p1 = await parseProblem(fastapi);
    expect(p1.status).toBe(422);
    expect(p1.title).toBe("Unprocessable Entity");
    expect(p1.detail).toContain("field required");

    const html = {
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: async () => "<html>nginx</html>",
    } as unknown as Response;
    const p2 = await parseProblem(html);
    expect(p2).toMatchObject({
      type: "about:blank",
      title: "Bad Gateway",
      status: 502,
      detail: "<html>nginx</html>",
    });

    const empty = {
      ok: false,
      status: 500,
      statusText: "",
      text: async () => "",
    } as unknown as Response;
    expect((await parseProblem(empty)).title).toBe("HTTP 500");
  });

  it("adds the bearer token from sessionStorage and parses JSON on success", async () => {
    sessionStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        token: "tok123",
        role: "coordinator",
        display_name: "C",
        expires_at: "2099-01-01T00:00:00.000Z",
      }),
    );
    const mock = installMockFetch([
      {
        method: "GET",
        path: "/api/v1/queue",
        handler: () => ({ json: { items: [], total: 0, limit: 25, offset: 0 } }),
      },
    ]);
    const page = await getQueue({ min_tier: 2, status: "open", usubjid: undefined });
    expect(page.total).toBe(0);
    const call = mock.calls[0];
    expect(call.headers.authorization).toBe("Bearer tok123");
    expect(mock.fn.mock.calls[0][0]).toBe("/api/v1/queue?min_tier=2&status=open");
  });

  it("sends no Authorization header when logged out (kiosk)", async () => {
    const mock = installMockFetch([
      {
        method: "GET",
        path: "/api/v1/queue",
        handler: () => ({ json: { items: [], total: 0, limit: 25, offset: 0 } }),
      },
    ]);
    await getQueue();
    expect(mock.calls[0].headers.authorization).toBeUndefined();
  });

  it("wraps fetch rejections in NetworkError", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const err = await getQueue().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(describeError(err)).toBe("Could not reach the Interim API");
  });

  it("buildQuery drops undefined/null and encodes values", () => {
    expect(buildQuery({ a: 1, b: "x y", c: undefined, d: null, e: false })).toBe(
      "?a=1&b=x+y&e=false",
    );
    expect(buildQuery({})).toBe("");
    expect(buildQuery()).toBe("");
  });

  it("pagination helpers", () => {
    expect(pageInfo({ total: 0, limit: 25, offset: 0 })).toEqual({
      page: 1,
      pages: 1,
      hasPrev: false,
      hasNext: false,
      from: 0,
      to: 0,
    });
    expect(pageInfo({ total: 60, limit: 25, offset: 25 })).toEqual({
      page: 2,
      pages: 3,
      hasPrev: true,
      hasNext: true,
      from: 26,
      to: 50,
    });
    expect(pageInfo({ total: 60, limit: 25, offset: 50 })).toMatchObject({
      page: 3,
      hasNext: false,
      to: 60,
    });
    expect(pageParams(1)).toEqual({ limit: 25, offset: 0 });
    expect(pageParams(3, 10)).toEqual({ limit: 10, offset: 20 });
    expect(pageParams(0)).toEqual({ limit: 25, offset: 0 });
  });

  it("fetchAllPages walks every page", async () => {
    const pages = [
      { items: [1, 2], total: 5, limit: 2, offset: 0 },
      { items: [3, 4], total: 5, limit: 2, offset: 2 },
      { items: [5], total: 5, limit: 2, offset: 4 },
    ];
    let i = 0;
    const all = await fetchAllPages(async () => pages[i++], 2);
    expect(all).toEqual([1, 2, 3, 4, 5]);
    expect(i).toBe(3);
  });
});
