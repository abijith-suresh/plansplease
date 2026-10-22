import { basename } from "node:path";

// Convex 1.46 does not forward the native backend's interface option. Keep
// this adaptation limited to the server invocation used by that CLI.
export function loopbackBackendArguments(command, args) {
  if (
    typeof command !== "string" ||
    basename(command) !==
      (process.platform === "win32" ? "convex-local-backend.exe" : "convex-local-backend")
  )
    return args;
  if (
    Array.isArray(args) &&
    (["keygen", "help"].includes(args[0]) ||
      args.some((arg) => ["--help", "-h", "--version", "-V"].includes(arg)))
  )
    return args;
  if (!Array.isArray(args) || args.includes("--"))
    throw new Error("Unsupported local Convex backend server invocation");
  for (const flag of ["--port", "--site-proxy-port"]) {
    const index = args.indexOf(flag);
    if (
      index < 0 ||
      args.lastIndexOf(flag) !== index ||
      !/^\d+$/.test(args[index + 1] ?? "") ||
      Number(args[index + 1]) > 65535
    )
      throw new Error("Unsupported local Convex backend server ports");
  }
  let hasInterface = false;
  for (let index = 0; index < args.length; index++) {
    const arg = String(args[index]);
    let value;
    if (arg === "--interface" || arg === "-i") value = args[++index];
    else if (arg.startsWith("--interface=")) value = arg.slice("--interface=".length);
    else if (arg.startsWith("-i")) value = arg.slice(2);
    else continue;
    if (value !== "127.0.0.1") throw new Error("Local Convex must bind to 127.0.0.1");
    hasInterface = true;
  }
  return hasInterface ? args : [...args, "--interface", "127.0.0.1"];
}

export function installLoopbackBackendSpawn(childProcess) {
  for (const method of ["spawn", "spawnSync"]) {
    const original = childProcess[method];
    childProcess[method] = function (...parameters) {
      const args = loopbackBackendArguments(parameters[0], parameters[1]);
      // Preserve optional-args signatures, options, receiver, and return values.
      if (args !== parameters[1]) parameters[1] = args;
      return Reflect.apply(original, this, parameters);
    };
  }
}
