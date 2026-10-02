import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function randomBase64Url(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function constantTimeEqual(left: string, right: string): boolean {
  // Hashing first gives timingSafeEqual fixed-length inputs even when an
  // attacker deliberately supplies a value with a different length.
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function signature(value: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(value, "utf8").digest();
}

export function signValue(value: string, secret: string): string {
  return `${value}.${signature(value, secret).toString("base64url")}`;
}

export function verifySignedValue(
  signedValue: string,
  secret: string,
): string | null {
  const separator = signedValue.lastIndexOf(".");
  if (separator <= 0 || separator === signedValue.length - 1) {
    return null;
  }

  const value = signedValue.slice(0, separator);
  const encodedSignature = signedValue.slice(separator + 1);
  if (!BASE64URL_PATTERN.test(encodedSignature)) {
    return null;
  }

  const expected = signature(value, secret);
  let received: Buffer;
  try {
    received = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }

  // Node's base64url decoder accepts non-canonical aliases when the final
  // character differs only in unused padding bits. Reject those spellings so
  // a signed cookie has exactly one valid wire representation.
  if (!constantTimeEqual(received.toString("base64url"), encodedSignature)) {
    return null;
  }

  const comparable = received.length === expected.length
    ? received
    : Buffer.alloc(expected.length);
  const valid = timingSafeEqual(expected, comparable) &&
    received.length === expected.length;
  return valid ? value : null;
}

export function sealJson(value: unknown, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return signValue(payload, secret);
}

export function openSealedJson(
  signedPayload: string,
  secret: string,
): unknown | null {
  const payload = verifySignedValue(signedPayload, secret);
  if (payload === null || !BASE64URL_PATTERN.test(payload)) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}
