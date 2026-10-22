import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { installLoopbackBackendSpawn } from "./local-convex-loopback.mjs";

// Loaded through explicit --import on runner-owned Convex CLI processes only.
// Do not use NODE_OPTIONS: app servers and other Node children need no hook.
installLoopbackBackendSpawn(childProcess);
syncBuiltinESMExports();
