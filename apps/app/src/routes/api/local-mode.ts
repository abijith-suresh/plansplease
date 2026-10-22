import { isLocalDevelopment } from "../../../convex/localMode";

export const GET = () =>
  Response.json(
    {
      enabled: isLocalDevelopment(process.env),
      github: Boolean(process.env["GITHUB_CLIENT_ID"] && process.env["GITHUB_CLIENT_SECRET"]),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
