/**
 * In-app routes that more than one page links to. Kept here so a page never
 * hand-builds another page's URL.
 */

/** The report packet page (R3.3). */
export function packetPath(packetId: string): string {
  return `/dashboard/packets/${encodeURIComponent(packetId)}`;
}

/** The visit-prep brief page for one participant (R3.3). */
export function briefPath(usubjid: string): string {
  return `/dashboard/participants/${encodeURIComponent(usubjid)}/brief`;
}
