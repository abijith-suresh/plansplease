# Optional document revisions

Status: proposal for review. This PR changes no upload, preview, or deletion behavior.

## Decision to make

Keep today's default: an upload creates a separate document and URL. Add an explicit
option to publish a revision of a document the user already knows. Never infer that
two uploads are revisions because their titles or contents look similar.

The distinction is useful for a plan reviewed repeatedly. The agent can save the next
revision without losing the original review or making the user track new links. A
separate upload remains useful for an alternative approach, experiment, or fork.

## Links and identity

- A document has one stable identity and a URL that opens its latest committed revision.
- Every revision is an immutable snapshot with its own URL. A review refers to that
  exact revision even after the agent publishes another one.
- Keep `/api/documents/<documentId>` as the account preview. A proposed pinned route is
  `/api/documents/<documentId>/revisions/<revisionId>`.
- Existing document URLs keep working. Before any revision is added, they show the
  same bytes as today. Existing local `planview publish` URLs remain immutable and
  independent of the cloud revision system.
- Both cloud routes require the owning account. This proposal adds no anonymous
  sharing and makes no change to public direct storage URLs during alpha.

Example: an agent uploads an authentication migration plan as document A, revision 1.
You review revision 1 and request a staged rollout. The agent explicitly uploads
revision 2 to A. A's stable URL now opens revision 2; revision 1's pinned link still
opens the original. A competing rollout strategy can be uploaded as document B.

## Agent contract

Start with hosted MCP. An upload with no document ID retains today's create behavior.
An optional revision upload must supply the document ID and the revision it was based
on. Prefer an explicit `upload_revision` tool so the agent cannot confuse creation
with replacement. A later CLI flag can use the same server contract.

A successful revision upload returns the document ID, revision ID, latest URL, and
pinned revision URL. The agent tells the user which document it revised. It does not
delete the previous upload, match on filename, or guess a document ID.

Use optimistic concurrency: if the current revision has changed since the agent read
it, return a conflict. The agent reads the new revision and asks how to reconcile the
changes rather than silently replacing another session's work. Bind an idempotency
key to the caller, document, base revision, and content so retries do not create
multiple revisions. Check for a committed replay before the stale-base check and
return the original success. Reusing a key for a different operation fails.

## Storage and authorization

Keep documents as the parent records and add a revisions table for immutable storage
locators, byte sizes, creation times, and optional change summaries. Each document
points to its latest revision. Convert old documents to revision 1 during a separate,
reviewed migration with a dry run and restartable batches.

Store new bytes first, then atomically insert the revision and conditionally advance
the latest pointer in Convex. Reject known authorization and stale-base failures before
uploading when possible, then recheck atomically at commit.

Add durable cleanup jobs for uncommitted upload locators, independent of a document ID.
Today's upload compensation only attempts deletion and logs failures; the existing
delete retry worker requires a persisted document and cannot clean orphan uploads.
Reuse its scheduling and backoff conventions, but distinguish orphan cleanup from
revision and parent deletion. On an ambiguous timeout, consult the idempotency receipt
before deleting any bytes. If publication may have committed, retain the file until
reconciliation proves that no revision references it. Extend mutation proofs to bind
the parent, base revision, and new content locator. An agent cannot
append to or read another account's document even if it knows both IDs.

History is paginated. Account storage use must count every retained revision rather
than only the latest. Deleting a document hides the parent and all revision previews
immediately, then queues deletion of every stored revision with retries. Existing
public storage URLs can remain readable until that cleanup completes, as they can
today.

## Small first release

Implement explicit MCP revision upload, latest and pinned preview routes, and a
compact history selector. An entry shows its date and optional short change summary.
Reviewing a pinned revision clearly identifies the version and offers a link to the
latest. Keep feedback outside the generated HTML if we add it later.

Defer HTML visual diffs, branches, automatic revision matching, live editing, and
collaborative comments. Restore can eventually create a new revision from old bytes;
it should not rewrite historical snapshots.

## Acceptance checks

- Existing uploads and URLs continue to work; a default upload creates a new document.
- Explicit revisions preserve every pinned snapshot and atomically advance the latest URL.
- Two concurrent revisions based on the same version yield one commit and one conflict.
- Retries produce one revision; cross-account requests fail before publication.
- Failed publication and document deletion clean up all relevant storage with retries.
- History and document lists work beyond one cursor page, including legacy records.
- Latest and pinned views have clear labels and keyboard-accessible history controls.

## Why this is worth testing

Claude now documents a live artifact URL that updates as a Claude Code session
continues. Its documentation also describes iterating on artifacts. That supports
stable identity as a familiar pattern, but does not establish that its public link
or revision semantics should be copied here. Our choice is to retain exact snapshots
and let the agent explicitly connect them.

Sources checked October 1, 2026:

- [Claude artifacts, including live Claude Code URLs](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them)
- Current Planview local immutability contract in `apps/cli/README.md`
- Current cloud ownership and storage schema in `apps/app/convex/schema.ts`

Review before implementation: whether explicit revisions should be enabled in the
first product release, whether history is unlimited or capped, and whether restoring
older content belongs in that first release. No choice here changes runtime behavior
until a separately reviewed implementation PR.
