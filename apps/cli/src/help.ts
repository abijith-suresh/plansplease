export const COMMANDS = [
  "publish",
  "upload",
  "login",
  "logout",
  "get",
  "start",
  "status",
  "stop",
  "restart",
  "clean",
  "list",
  "usage",
  "delete",
  "help",
] as const;

export type Command = (typeof COMMANDS)[number];
export type HelpTopic = Command;

const ROOT_HELP = `Usage: plansplease [global-options] <command> [options]

Commands:
  publish <file|folder>  Publish a snapshot and print its URL
  upload <file|folder>   Upload an HTML page or artifact to your cloud workspace
  login                  Sign in to your cloud workspace
  logout                 Revoke and remove this computer's saved cloud sign-in
  get <id|url>           Write a stored snapshot to standard output
  start                  Start or reuse the daemon for the selected profile
  status                 Show daemon status without starting it
  stop                   Gracefully stop the local daemon
  restart                Restart the local daemon
  list                   List local snapshots in bounded pages
  usage                  Show logical storage usage and retention
  delete <id>            Delete one listed snapshot generation
  clean                  Remove expired snapshots and reconcile storage
  help [command]         Show help for a command

Global options:
  -h, --help             Show this help message
  -v, --version          Show the version
  --profile <name>       Use isolated state for this command (default: default)

Profile names use lowercase letters, numbers, hyphens, and underscores.
Use plansplease <command> --help for command options.

Install the bundled Agent Skills with the Vercel Skills CLI:
  npx skills add https://github.com/abijith-suresh/plansplease/tree/main/apps/cli/skills
  npx skills add ./apps/cli/skills              (from a local checkout)
Skills CLI installs to the project by default; add -g for optional user-wide installation.
`;

const COMMAND_HELP: Record<HelpTopic, string> = {
  publish: `Usage: plansplease publish [options] <file|folder>

Publish one immutable HTML snapshot and print its localhost URL.
The input may be an HTML file or a page folder containing index.html.
The selected profile owns its documents and local daemon.

Options:
  -h, --help             Show this help message
  --open                 Open the published URL in the default browser
  --json                 Print the snapshot id and URL as one JSON object
`,
  upload: `Usage: plansplease upload [options] <file.html|folder>

Upload an HTML file or artifact folder to your cloud workspace and print its link.
Run plansplease login first. Folders need index.html; the total cloud limit is 8 MiB.

Options:
  -h, --help             Show this help message
  --open                 Open the returned link in the default browser
  --json                 Print the document id and URL as one JSON object
`,
  login: `Usage: plansplease login [options]

Open the selected cloud app's account sign-in in your browser and authorize this
computer for uploads. Credentials are saved in the selected profile's private
data directory.

Options:
  -h, --help             Show this help message
  --cloud-url <url>      Sign in to a specific cloud app origin

Set PLANVIEW_CLOUD_URL or use --cloud-url to select an app origin. Use the local
workspace URL when testing locally.
`,
  logout: `Usage: plansplease logout

Revoke the saved cloud sign-in on the app, then remove it from the selected
profile on this computer. Revocation requires a connection.
`,
  get: `Usage: plansplease get [options] <id|url>

Write the stored snapshot's exact bytes to standard output.
The reference may be a document id or an exact local preview URL.
The URL must use the selected profile's current port.

Options:
  -h, --help             Show this help message
`,
  start: `Usage: plansplease start [options]

Start the selected profile's daemon, or reuse its authenticated daemon.
If the preferred port is occupied, plansplease uses the next available port.

Options:
  -h, --help             Show this help message
  --json                 Print the daemon status as one JSON object
`,
  status: `Usage: plansplease status [options]

Show daemon status without starting a daemon.

Options:
  -h, --help             Show this help message
  --json                 Print the daemon status as one JSON object
`,
  stop: `Usage: plansplease stop [options]

Gracefully stop the local daemon.

Options:
  -h, --help             Show this help message
  --json                 Print the stopped state as one JSON object
`,
  restart: `Usage: plansplease restart [options]

Restart the local daemon.

Options:
  -h, --help             Show this help message
  --json                 Print the daemon status as one JSON object
`,
  clean: `Usage: plansplease clean [options]

Remove expired snapshots and reconcile incomplete storage operations.

Options:
  -h, --help             Show this help message
  --json                 Print the cleanup result as one JSON object
`,
  list: `Usage: plansplease list [options]

List local snapshots in id order without refreshing retention.
Starts or reuses the selected profile's daemon, including startup cleanup.

Options:
  -h, --help             Show this help message
  --json                 Print snapshots and optional nextAfter as one JSON object
  --limit <1..100>        Maximum snapshots in the page (default: 50)
  --after <id>           Continue after the last id of the previous page
`,
  usage: `Usage: plansplease usage [options]

Show committed document bytes plus 4 KiB metadata per snapshot, the 1 GiB quota,
and 30-day last-access retention. This is logical usage, not physical disk use.
Starts or reuses the selected profile's daemon, including startup cleanup.

Options:
  -h, --help             Show this help message
  --json                 Print usage as one JSON object
`,
  delete: `Usage: plansplease delete [options] <id> --generation <generation>

Delete one local immutable snapshot selected from list. Cloud copies are independent.
Active reads retain the snapshot. Stale selections never delete a replacement.
Partial file removal reports recovery=clean; run plansplease clean for reconciliation.
Exit 1 means stale, retained, or partial. A missing snapshot returns exit 0.

Options:
  -h, --help             Show this help message
  --generation <value>   Immutable generation printed by list (required)
  --json                 Print status, removal flags, file state and recovery
`,
  help: `Usage: plansplease help [command]

Show help for the whole CLI or for one command.
`,
};

export const HELP = ROOT_HELP;

export const formatHelp = (topic?: HelpTopic) =>
  topic === undefined ? ROOT_HELP : COMMAND_HELP[topic];
