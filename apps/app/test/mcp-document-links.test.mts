import assert from "node:assert/strict";
import { test } from "node:test";

import { presentMcpUpload } from "../src/lib/mcp-document-links.ts";

test("document IDs cannot inject path segments or query parameters", () => {
  assert.deepEqual(presentMcpUpload("id/with?query#fragment", "https://plans.example"), {
    id: "id/with?query#fragment",
    url: "https://plans.example/api/documents/id%2Fwith%3Fquery%23fragment",
  });
});
