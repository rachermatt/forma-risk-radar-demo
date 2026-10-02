const BASE_HEADERS = Object.freeze({
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

export function contentSecurityPolicy(nonce: string, production: boolean): string {
  if (!/^[A-Za-z0-9+/=_-]+$/u.test(nonce)) {
    throw new TypeError("CSP nonce must be an encoded random value.");
  }
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${production ? "" : " 'unsafe-eval'"}`,
    "style-src 'self'",
    `style-src-elem 'self' 'nonce-${nonce}'`,
    // React-authored numeric layout styles drive bars and graph geometry. Keep
    // this exception on attributes only; script and <style> elements stay
    // nonce-controlled, and no upstream record supplies a style object.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(production ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function securityHeaders(
  nonce: string,
  production: boolean,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...BASE_HEADERS,
    "content-security-policy": contentSecurityPolicy(nonce, production),
    ...(production
      ? { "strict-transport-security": "max-age=63072000; includeSubDomains; preload" }
      : {}),
  });
}
