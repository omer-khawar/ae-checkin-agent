/**
 * Route-table `fetch` mock. Records every call (method, path, parsed JSON body,
 * headers) so tests can assert the exact request bodies the kiosk sends.
 */
import { vi } from "vitest";

export interface MockResult {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export interface RouteContext {
  url: URL;
  body: unknown;
  params: string[];
  headers: Record<string, string>;
}

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string | RegExp;
  handler: (ctx: RouteContext) => MockResult | Promise<MockResult>;
}

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

function makeResponse(r: MockResult): Response {
  const status = r.status ?? 200;
  const isJson = r.json !== undefined;
  const body = isJson ? JSON.stringify(r.json) : (r.text ?? "");
  const headers: Record<string, string> = {
    "Content-Type": isJson
      ? status >= 400
        ? "application/problem+json"
        : "application/json"
      : "text/plain",
    ...r.headers,
  };
  // A tiny Response-compatible object; avoids depending on undici in jsdom.
  const res = {
    ok: status >= 200 && status < 300,
    status,
    statusText:
      status === 404
        ? "Not Found"
        : status === 422
          ? "Unprocessable Entity"
          : status >= 500
            ? "Server Error"
            : "OK",
    headers: new Headers(headers),
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
    blob: async () => new Blob([body], { type: headers["Content-Type"] }),
  };
  return res as unknown as Response;
}

function normaliseHeaders(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v;
  } else {
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  }
  return out;
}

export function installMockFetch(routes: Route[]) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = normaliseHeaders(init?.headers);
    const body =
      typeof init?.body === "string" && init.body ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: url.pathname, body, headers });

    for (const r of routes) {
      if (r.method !== method) continue;
      let params: string[] | null = null;
      if (typeof r.path === "string") {
        if (url.pathname === r.path) params = [];
      } else {
        const m = url.pathname.match(r.path);
        if (m) params = m.slice(1);
      }
      if (!params) continue;
      return makeResponse(await r.handler({ url, body, params, headers }));
    }
    return makeResponse({
      status: 404,
      json: {
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: `no mock route for ${method} ${url.pathname}`,
      },
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return {
    fn,
    calls,
    /** Calls matching a method and path (string equality or regex). */
    find(method: string, path: string | RegExp): RecordedCall[] {
      return calls.filter(
        (c) =>
          c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path)),
      );
    },
  };
}
