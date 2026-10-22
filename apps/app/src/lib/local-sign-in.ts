export function localSignInReturnTo(search: string): string {
  const query = new URLSearchParams(search);
  const oauth = query.get("oauth_query");
  if (oauth && oauth.length <= 4096) return `/mcp/consent?${oauth}`;
  const returnTo = query.get("returnTo");
  if (
    !returnTo ||
    !returnTo.startsWith("/") ||
    returnTo.startsWith("//") ||
    returnTo.includes("\\") ||
    [...returnTo].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127
    )
  )
    return "/documents";
  const url = new URL(returnTo, "http://local.invalid");
  return url.origin === "http://local.invalid"
    ? `${url.pathname}${url.search}${url.hash}`
    : "/documents";
}
