const AUTODESK_DEEP_LINK_HOSTS = new Set([
  "acc.autodesk.com",
  "construction.autodesk.com",
  "docs.b360.autodesk.com",
]);

/** Normalize a source deep link and fail closed before it reaches rendered HTML. */
export function normalizeAutodeskDeepLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !AUTODESK_DEEP_LINK_HOSTS.has(url.hostname.toLowerCase())) return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
