import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudBundleMaxBytes } from "../dist/cloud-bundle.js";
import {
  cloudDocumentMaxBytes,
  cloudDocumentTitleMaxLength,
  cloudDocumentTitleMinLength,
} from "../dist/cloud-policy.js";

test("cloud upload limits are shared with encoded bundle policy", () => {
  assert.equal(cloudDocumentMaxBytes, 8 * 1024 * 1024);
  assert.equal(cloudBundleMaxBytes, cloudDocumentMaxBytes);
  assert.equal(cloudDocumentTitleMinLength, 1);
  assert.equal(cloudDocumentTitleMaxLength, 200);
});
