import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inventoryFromPayload,
  usageFromPayload,
  deletionFromPayload,
} from "../dist/snapshot-response.js";

const selection = { id: "a".repeat(21), generation: "12345678-1234-1234-1234-123456789012" };
const row = { ...selection, createdAt: 1, lastAccessedAt: 2, expiresAt: 3, size: 4 };
test("daemon snapshot clients validate bounded responses before exposing them", () => {
  assert.deepEqual(inventoryFromPayload({ snapshots: [row] }), { snapshots: [row] });
  for (const payload of [
    null,
    {},
    { snapshots: Array(101).fill(row) },
    { snapshots: [{ ...row, generation: "bad" }] },
    { snapshots: [{ ...row, lastAccessedAt: 0 }] },
    { snapshots: [{ ...row, size: -1 }] },
    { snapshots: [], nextAfter: "bad" },
  ]) {
    assert.throws(() => inventoryFromPayload(payload));
  }
  assert.throws(() => usageFromPayload({ bytes: Infinity }));
  assert.throws(() => usageFromPayload({ bytes: -1 }));
  const deleted = {
    ...selection,
    status: "deleted",
    removedMetadata: true,
    removedFile: true,
    fileState: "absent",
    recovery: "none",
  };
  assert.deepEqual(deletionFromPayload(deleted), deleted);
  for (const payload of [
    { ...deleted, status: "ok" },
    { ...deleted, removedFile: 1 },
    { ...deleted, fileState: "maybe" },
    { ...deleted, recovery: "retry" },
    { ...deleted, message: { secret: "not rendered" } },
  ])
    assert.throws(() => deletionFromPayload(payload));
});
