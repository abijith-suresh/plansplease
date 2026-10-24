import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readPublicUrls } from "../src/lib/public-urls.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const files = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
const publicFragmentIds = [
  ["guides/cli/index.html", "cloud-artifact-folders-on-main"],
  ["guides/cloud/index.html", "what-is-available-in-staging"],
  ["guides/mcp/index.html", "add-the-remote-server"],
  ["reference/planned-features/index.html", "current-staging-workflows"],
  ["reference/planned-features/index.html", "merged-changes"],
  ["reference/planned-features/index.html", "open-implementations"],
  ["reference/planned-features/index.html", "proposals-only"],
];

test("public URL configuration keeps docs prefixes and rejects unsafe deployment URLs", () => {
  const urls = readPublicUrls({
    PUBLIC_DOCS_URL: "https://docs.example.com/manual/",
    PUBLIC_APP_URL: "http://localhost:3000",
    PUBLIC_SITE_URL: "https://example.com",
  });
  assert.equal(urls.docsBasePath, "/manual/");
  assert.equal(urls.appUrl, "http://localhost:3000/");
  for (const value of [
    "javascript:alert(1)",
    "http://example.com",
    "https://u:p@example.com",
    "https://example.com/?x=1",
    "https://example.com/#x",
    "https://example.com/a//b",
    "https://example.com/%2f",
  ]) {
    assert.throws(() => readPublicUrls({ PUBLIC_DOCS_URL: value }), undefined, value);
  }
  assert.throws(() => readPublicUrls({ PUBLIC_APP_URL: "https://example.com/app/" }));
});

test("production root and prefixed builds contain complete navigation, search, and working links", () => {
  for (const base of ["/", "/manual/"]) {
    const output = resolve(root, `.build-test-${base === "/" ? "root" : "prefix"}`);
    try {
      const docsUrl = `https://docs.example.com${base}`;
      execFileSync(npm, ["run", "build", "--", "--outDir", output], {
        cwd: root,
        env: {
          ...process.env,
          PUBLIC_DOCS_URL: docsUrl,
          PUBLIC_APP_URL: "https://workspace.example.com",
          PUBLIC_SITE_URL: "https://product.example.com",
        },
        stdio: "pipe",
      });
      assert.ok(existsSync(join(output, "pagefind", "pagefind.js")), "build emits search runtime");
      assert.ok(
        files(join(output, "pagefind")).some((file) => file.endsWith(".pf_fragment")),
        "search index contains document fragments"
      );
      assert.equal(
        JSON.parse(readFileSync(join(output, "docs-runtime.json"), "utf8")).basePath,
        base
      );
      for (const file of files(output).filter((path) => path.endsWith(".html"))) {
        const route = relative(output, file)
          .replace(/\\/g, "/")
          .replace(/index\.html$/, "");
        const html = readFileSync(file, "utf8");
        assert.match(html, /plansplease docs/);
        const socialImage = `${docsUrl}social-preview.png?v=2`;
        assert.ok(html.includes(`property="og:image" content="${socialImage}"`));
        assert.ok(html.includes(`name="twitter:image" content="${socialImage}"`));
        assert.equal((html.match(/property="og:image"/g) ?? []).length, 1);
        assert.ok(html.includes(`href="${base}favicon.svg?v=2"`));
        assert.ok(html.includes(`href="${base}apple-touch-icon.png?v=2"`));
        assert.ok(html.includes("<site-search"), `search UI on ${route}`);
        assert.ok(
          html.includes('dataset["theme"] = "dark"'),
          `dark theme before paint on ${route}`
        );
        assert.ok(!html.includes("<starlight-theme-select"), `no theme picker on ${route}`);
        assert.ok(!html.includes("<starlight-toc"), `no permanent contents column on ${route}`);
        if (!file.endsWith("404.html"))
          assert.ok(html.includes(`href="${docsUrl}${route}"`), `canonical ${route}`);
        const current = new URL(route, docsUrl);
        for (const [, target] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
          const url = new URL(target.replace(/&amp;/g, "&"), current);
          if (url.origin !== new URL(docsUrl).origin || !url.pathname.startsWith(base)) continue;
          // Astro emits the error page as 404.html but Starlight canonicals use /404/.
          if (file.endsWith("404.html") && url.pathname === `${base}404/`) continue;
          const path = resolve(output, decodeURIComponent(url.pathname.slice(base.length)));
          assert.ok(
            existsSync(path) || existsSync(join(path, "index.html")),
            `missing build link ${target} on ${route}`
          );
          if (url.hash) {
            const page = path.endsWith(".html") ? path : join(path, "index.html");
            if (existsSync(page)) {
              const destination = readFileSync(page, "utf8");
              const fragment = decodeURIComponent(url.hash.slice(1));
              assert.ok(
                destination.includes(`id="${fragment}"`),
                `missing section ${target} on ${route}`
              );
            }
          }
        }
      }
      for (const [page, id] of publicFragmentIds) {
        const html = readFileSync(join(output, page), "utf8");
        assert.ok(html.includes(`id="${id}"`), `public fragment #${id} in ${page} at ${base}`);
      }
      const mcp = readFileSync(join(output, "guides", "mcp", "index.html"), "utf8");
      assert.ok(mcp.includes("http://127.0.0.1:3000/mcp"));
      const source = readFileSync(resolve(root, "../app/src/lib/hosted-mcp-server.ts"), "utf8");
      const tools = [...source.matchAll(/registerTool\(\s*"([^"]+)"/g)];
      assert.ok(tools.length > 0, "hosted MCP server registers tools");
      for (const [, tool] of tools) assert.ok(mcp.includes(tool), `documented main tool ${tool}`);
      const guide = readFileSync(join(output, "guides", "install-cli", "index.html"), "utf8");
      assert.ok(guide.includes("not published to npm"));
      assert.ok(guide.includes("pack-destination"));
      assert.ok(guide.includes("http://127.0.0.1:3000"));
      const cliPackage = JSON.parse(readFileSync(resolve(root, "../cli/package.json"), "utf8"));
      const installSource = readFileSync(
        resolve(root, "src/content/docs/guides/install-cli.mdx"),
        "utf8"
      );
      assert.ok(
        installSource.includes(`npm pack --workspace ${cliPackage.name} --pack-destination .`),
        "installation packs the existing CLI workspace"
      );
      const [command] = Object.keys(cliPackage.bin);
      assert.ok(command, "CLI exposes a command");
      assert.ok(installSource.includes(`${command} --version`), "installation uses the actual bin");
      const home = readFileSync(join(output, "index.html"), "utf8");
      assert.ok(!home.includes("https://workspace.example.com"));
      assert.ok(!home.includes("https://product.example.com"));
      assert.ok(home.includes(`href="${base}reference/planned-features/"`));
      assert.ok(home.includes(`href="${base}reference/development/#full-local-workspace"`));
      for (const route of ["install-cli", "mcp", "self-hosting"])
        assert.ok(home.includes(`href="${base}guides/${route}/"`), `setup route ${route}`);
    } finally {
      rmSync(output, { force: true, recursive: true });
    }
  }
});
