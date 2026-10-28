import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installPrepared } from "./prerelease.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5)
      throw new Error(
        "Usage: npm run install:prerelease -- /absolute/bundle /absolute/new-install FULL_SHA"
      );
    const installation = installPrepared(process.argv[2], process.argv[3], process.argv[4]);
    process.stdout.write(`${JSON.stringify(installation)}\n`);
  } catch {
    process.stderr.write(
      "Cannot install this candidate. Verify the approved source/checksums, pinned runtime, offline npm cache and new absolute destination.\n"
    );
    process.exitCode = 1;
  }
}
