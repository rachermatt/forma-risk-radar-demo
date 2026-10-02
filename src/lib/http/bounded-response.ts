export type BoundedResponseFailure =
  | "invalid-content-length"
  | "body-too-large"
  | "body-unreadable";

export class BoundedResponseError extends Error {
  readonly failure: BoundedResponseFailure;

  constructor(failure: BoundedResponseFailure) {
    super("Remote response exceeded or violated its configured body bounds.");
    this.name = "BoundedResponseError";
    this.failure = failure;
  }
}

/** Reads a response incrementally and enforces a byte limit before allocation. */
export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("maximumBytes must be a positive safe integer.");
  }
  const contentLengthValue = response.headers.get("content-length");
  if (contentLengthValue !== null) {
    const contentLength = Number(contentLengthValue);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new BoundedResponseError("invalid-content-length");
    }
    if (contentLength > maximumBytes) {
      throw new BoundedResponseError("body-too-large");
    }
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BoundedResponseError("body-too-large");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof BoundedResponseError) throw error;
    throw new BoundedResponseError("body-unreadable");
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const bytes = await readBoundedResponseBytes(response, maximumBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BoundedResponseError("body-unreadable");
  }
}
