import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { installPostgresPoolErrorHandler } from "../src/lib/db/pool-errors";

test("idle Postgres pool errors are contained and reported without raw details", () => {
  const pool = new EventEmitter();
  const messages: string[] = [];
  installPostgresPoolErrorHandler(pool, (message) => messages.push(message));
  assert.doesNotThrow(() => pool.emit("error", new Error("postgres://secret@example.invalid/private")));
  assert.deepEqual(messages, ["Postgres pool idle client error; readiness and subsequent queries may fail."]);
  assert.doesNotMatch(messages[0]!, /secret|example\.invalid|private/u);
});
