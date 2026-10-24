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
