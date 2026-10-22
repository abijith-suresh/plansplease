export const GET = ({ request }: { request: Request }) => {
  const query = new URL(request.url).search.slice(1);
  if (!query || query.length > 4096) return new Response("Invalid OAuth request", { status: 400 });
  return new Response(null, {
    status: 302,
    headers: { Location: `/auth/login?oauth_query=${encodeURIComponent(query)}` },
  });
};
