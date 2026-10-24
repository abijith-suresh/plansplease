# @planview/storage

Private daemon-owned SQLite metadata and immutable document-file storage. It is
not a published API. The daemon and publication coordinator combine these
boundaries; physical file methods are not a document-serving API.

## Ownership and publication

The file store owns absolute documents and staging directories. It stages regular
`.html` or `.htm` files up to 10 MiB, then publishes with an atomic no-replace
hard link on supported local filesystems. It does not fall back to copying or
overwriting a destination. The publication coordinator inserts immutable SQLite
metadata only after the file is finalized. Published reads require a metadata
row, so an orphan file is not visible as a document.

Filesystem and SQLite operations do not share an atomic transaction. A crash can
leave a staged file, a finalized file without metadata, or duplicate staging
after metadata commits. Reconciliation handles known states; ambiguous files,
rows, and locks are retained and reported for recovery rather than removed by
guessing. Compensation uses the identity capability captured at finalization,
not a document-ID pathname. Callers must preserve targets when the typed
finalization result says recovery policy is `retain`.

On POSIX, the store syncs file data and syncs target and staging directories when
the filesystem and Node support directory `fsync`. A target-directory sync
failure removes the unpublished target; after that sync succeeds, a later
staging cleanup sync failure retains the target. Windows has no Node directory
sync API, so file sync and hard-link behavior remain but directory-entry crash
durability is not promised. There is no cross-platform guarantee against a
malicious same-user process racing filesystem paths; Node also cannot inspect
Windows ACLs or classify all reparse points. Windows deployments must provision
an account-owned app-data directory that other users cannot write.

The fixed local quota is 1 GiB of logical committed storage. Admission charges
published HTML bytes plus 4 KiB per document for metadata. It does not bound
physical disk use, staging, or orphan files. Cleanup applies the fixed 30-day
last-access retention policy; the quota is not user-configurable.
