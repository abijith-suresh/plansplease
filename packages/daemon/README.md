# @planview/daemon

Private local daemon bundled into the public CLI. It owns the loopback HTTP
server, authenticated lifecycle operations, snapshot delivery, and cleanup. The
public listener prefers `127.0.0.1:4777`, then tries the next 50 ports. Named
profiles keep separate databases, files, and runtime state under
`planview/profiles/<name>`.

The daemon reconciles interrupted publications at startup and removes snapshots
whose last access is older than 30 days at startup and every 24 hours. Storage
coordination and its recovery limits are documented in the
[@planview/storage README](../storage/README.md).

On POSIX, app-data and runtime directories are owner-checked and restricted with
`0700`; sensitive files use `0600`. The loopback management API also requires a
random secret. Windows privacy is not enforced by Node mode bits: users must
provision an account-owned app-data directory that other users cannot write.
Planview claims loopback binding and authenticated lifecycle requests, not
Windows ACL enforcement against a hostile local user.


Authenticated snapshot inventory, logical usage and selected-generation deletion
use the same storage owner as publication and cleanup. Inventory does not extend
retention. Selected deletion enters the shared mutation gate and preserves active
read leases. CLI clients use bounded HTTP results and never open SQLite to query
inventory or estimate timeouts. These internal endpoints use the native daemon secret. No local MCP endpoint is
provided.


## Optional browser management

`ui` requests an on-demand second listener bound to `127.0.0.1` on an OS-assigned
port. The same daemon process owns both listeners and the one open metadata/file
store. No manager listener starts for ordinary publish/help/version/status calls.
Both listeners participate in request draining, cancellation and bounded shutdown.
The application operations shared with native routes serialize publication,
selected deletion and cleanup through the existing gate and target locks.

The manager loads only the compiled, installed `dist/manager` asset map. Snapshot
bytes never enter that map or its origin. HTML import accepts at most 10 MiB of
raw bytes and a validated filename, uses an owned temporary file and the shared
publication operation, then removes its temporary source. There are at most two
concurrent imports and 16 active manager handlers; body reads have a 15-second
deadline. Folder import is excluded.

Management requests require an exact literal Host, reject absolute-form and
query-string targets, and reject foreign or null Origins. Every API operation is
a POST requiring the exact manager Origin. There is no CORS permission. CSP
allows only the compiled same-origin scripts/styles, denies framing and inline
scripts, and never permits artifact execution. Responses are non-cacheable and
omit referrers. Data APIs accept only browser bearer sessions, never native
secrets or cookies. A one-use, one-minute fragment launch code exchanges for an
in-memory eight-hour session. Code/session maps each cap at eight entries and
expire without sliding renewal. Sign-out revokes the selected session; daemon
shutdown revokes all codes and sessions. Reconnection requires a fresh link.

The shell is public but contains no profile data or credentials. These controls
assume a trusted OS account and installed assets, not isolation from arbitrary
malicious code already running as that account. Windows retains the existing
account-owned-directory requirements; Node mode bits do not establish NTFS ACLs.
