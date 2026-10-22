import { createNitro } from "nitro/builder";
import { nitro } from "nitro/vite";

import { isLocalDevelopment } from "./convex/localMode.ts";

export async function appNitroPlugin(rootDir: string, command: "serve" | "build") {
  if (!isLocalDevelopment(process.env) || !process.env["PLANVIEW_ENV_DIR"]) return nitro();

  // This Nitro version loads source dotenv files independently of Vite envDir.
  // Its typed preinitialized-instance hook lets the local runner disable that
  // loader through createNitro's public API, before it can populate process.env.
  const instance = await createNitro(
    { rootDir, dev: command === "serve", builder: "vite" },
    { dotenv: false }
  );
  return nitro({ _nitro: instance });
}
