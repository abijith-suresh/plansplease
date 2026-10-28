# Manual candidate artifacts

Preparation only. Publication is disabled, including `publish=true`. No npm tag,
GitHub Release, source version/lock/Changeset or shared setting is changed.
The public package remains `@abijith-suresh/planview`, with the `plansplease` CLI.

Use repository-pinned Node 24.19.0 and npm 11.16.0. Preparation first needs the
locked build dependencies in npm's cache (`npm ci --ignore-scripts` can populate
it from the configured registry). Snapshot builds and candidate installation
then run offline with lifecycle scripts disabled. The CLI bundles private
workspaces and manager assets, but Effect 4.0.6 remains external. Its locked
registry tarball/integrity must already be cached on the destination; transferring
the CLI tarball alone is not an offline/self-contained installation. Node/npm and
Windows PowerShell 5.1 are runtime prerequisites; no WSL, compiler or dev server is
required on the laptop. Registry/cache access and corporate policies remain manual
checks. Do not copy npm credentials or a user's whole cache/config as a workaround.

The manual workflow accepts dev or alpha, requires trusted main, validates exact
source SHA and prepares one canonical Linux-built bundle. Windows downloads and
hash-checks those same bytes before installing/executing them; it does not rebuild.
Before this workflow is merged onto main, its dispatch path is unproven. Parent
review/merge and a later manual dry-run dispatch establish that acceptance.

Local preparation accepts an exact committed SHA, including a reviewed feature
commit for validation. Run through npm so it identifies the pinned npm entrypoint:

```sh
npm run prepare:prerelease -- --output /absolute/new-bundle --channel dev --source-sha FULL_SHA --date YYYYMMDD --run-id POSITIVE_NUMBER --attempt 1
npm run check:prerelease -- --bundle /absolute/new-bundle --expected-sha FULL_SHA
npm run install:prerelease -- /absolute/new-bundle /absolute/new-installation FULL_SHA
```

Use a new directory outside the checkout for output/install, with an existing
parent. Unicode and spaces are supported. Windows npm launcher paths containing
`&`, `%`, `^`, `!` or controls are refused because npm's `.cmd` shim cannot safely
represent them. The bundle's bounded manifest records candidate/source/channel
identity, exact runtime dependency resolution and SHA-256 for tarball and each
packaged file. SHA256SUMS covers the manifest and tarball. The installer generates an exact consumer lock from that verified metadata. Verify the expected source
SHA and compare the bundle's manifest hash against the trusted workflow receipt
before transfer. Hashes establish byte consistency, not publisher authentication.
An attacker replacing both data and checksums is not detected without that trusted
receipt. Verify all content before executing installed code. Installer uses a new
owned directory, `npm ci --offline --ignore-scripts` and installed per-file hashes.

Use the reported absolute launcher/bin path; it does not replace global installs.
`plansplease --version`, `build-info`, help and bundled skills remain offline.
The candidate CLI and daemon embed the same identity. Repeated starts reuse a
matching profile daemon. A different/legacy build is refused for automatic reuse;
inspect it and explicitly stop that owned profile before starting this build.
Stopping a profile closes its preview and manager and invalidates its older local
links. No profile is stopped automatically. Existing pin/quota/share/session and
local/cloud deletion semantics remain; no cloud synchronization is introduced.

Owner publication/auth/channel decisions, corporate laptop interaction and live
cloud acceptance are deferred. No secrets or dashboard changes are needed to build
or test candidates, and this phase implements no publisher or authorization flow.
