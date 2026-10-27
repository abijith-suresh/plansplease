# plansplease — agent brief

plansplease is a TypeScript ESM monorepo for turning HTML files and artifact folders into durable previews: the `plansplease` CLI serves immutable snapshots from a local daemon and can upload the same artifacts to an account-based alpha cloud workspace. It carries the CLI, the authenticated cloud app and MCP endpoint, a marketing site, a docs site, and the shared packages behind them.

## The Project
Core promise: one command turns an HTML file or folder into a durable, immutable URL, and the same artifact can be shared through the cloud workspace.
Non-goals: a production cloud domain, public npm publishing before the owner enables it, and any filesystem, network, or cloud I/O in Core. `@planview/core` resolves paths and holds shared document policy; adapters (`local`, `daemon`, `storage`, `app`) own all I/O.
Local snapshot inventory and logical storage usage belong to the daemon. The local application and CLI may list bounded metadata pages and delete a selected immutable generation through the existing storage locks and recovery operations. Listing does not refresh retention. Explicit generation-bound pins protect selected snapshots from automatic cleanup within the finite 1 GiB quota. Unpin restores the original access-based expiry; manual selected deletion remains allowed. Pins are not backups and publication fails when quota cannot be reclaimed. Local management never uploads or deletes cloud documents.
The optional local manager serves bundled static assets on a separate loopback origin in the same daemon process. Browser sessions are independent of the native daemon secret. Manager start and browser opening are explicit; stopping the daemon stops both listeners. Bounded offline profile discovery and native creation preserve default/named paths. Selection applies only to an invocation; manager selection prepares validated CLI instructions without launching or mutating another profile. Each profile keeps its own process, origins, browser sessions and storage; selection never stops another profile.
Cloud upload idempotency is opt-in and account/origin scoped. Durable server receipts bind an operation key to exact content and metadata; replay never starts a second upload. Unknown outcomes stay explicit. Legacy upload and local publish behavior remain unchanged; explicit share LOCAL_ID uploads daemon-owned immutable bytes and records scoped attempts before remote admission. Pending attempts recover by receipt lookup only; local and cloud deletion stay independent. Sharing does not pin snapshots or promise permanent offline retention.
Status: live, alpha.

## Sources of Truth
| Fact | Where |
|---|---|
| Product intent | § The Project (this file) |
| Runtime behavior | code + tests |
| Commands & deps | package.json |
| How to work here | `CONTRIBUTING.md` |
| Release policy | `CONTRIBUTING.md` + scripts/release-policy.mjs |
| Package intent | `apps/cli/AGENTS.md` |

Code and tests are the authority; this file never overrides executable truth.
