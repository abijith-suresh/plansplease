import { isLocalDevelopment } from "../../../convex/localMode";

export const GET = ({ request }: { request: Request }) => {
  const query = new URL(request.url).search;
  return new Response(null, {
    status: 302,
    headers: { Location: `${isLocalDevelopment(process.env) ? "/" : "/auth/github"}${query}` },
  });
};
