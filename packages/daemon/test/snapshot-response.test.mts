import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inventoryFromPayload,
  usageFromPayload,
  deletionFromPayload,
  pinFromPayload,
  retentionFromPayload,
} from "../dist/snapshot-response.js";

const selection = { id: "a".repeat(21), generation: "12345678-1234-1234-1234-123456789012" };
const row = {
  ...selection,
  createdAt: 1,
  lastAccessedAt: 2,
  expiresAt: 3,
  unpinnedExpiresAt: 3,
  pinned: false,
  size: 4,
};
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

test("effective retention is explicit and incompatible old or contradictory payloads fail closed", () => {
  const pinned = { pinned: true, expiresAt: null, unpinnedExpiresAt: 3 };
  assert.deepEqual(retentionFromPayload(pinned), pinned);
  for (const retention of [
    { expiresAt: 3 },
    { ...pinned, expiresAt: 3 },
    { ...pinned, pinned: false },
    { ...pinned, unpinnedExpiresAt: -1 },
  ])
    assert.throws(() => retentionFromPayload(retention));
  assert.deepEqual(pinFromPayload({ ...selection, status: "updated", retention: pinned }), {
    ...selection,
    status: "updated",
    retention: pinned,
  });
  assert.throws(() => pinFromPayload({ ...selection, status: "updated" }));
  for (const status of [["updated"], ["stale"], null, 1, {}])
    assert.throws(() => pinFromPayload({ ...selection, status }));
});
