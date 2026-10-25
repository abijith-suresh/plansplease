import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readSiteOrigin } from "../src/lib/public-site-url.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const withBuild = ({ outputDirectory, basePath }, check) => {
  const output = resolve(root, outputDirectory);
  rmSync(output, { force: true, recursive: true });

  const environment = { ...process.env };
  // These builds verify the repository default, independent of shell overrides.
  delete environment.PUBLIC_APP_URL;
  delete environment.PUBLIC_DOCS_URL;
  delete environment.PUBLIC_SITE_URL;
  if (basePath === undefined) {
    delete environment.BASE_PATH;
  } else {
    environment.BASE_PATH = basePath;
  }

  try {
    execFileSync(npm, ["run", "build", "--", "--outDir", outputDirectory], {
      cwd: root,
      env: environment,
      stdio: "ignore",
    });
    check(output);
  } finally {
    rmSync(output, { force: true, recursive: true });
  }
};

const assertSiteBasics = (html) => {
  assert.match(html, /<header\b/);
  assert.ok(
    /<nav[^>]*aria-label="Main navigation"/.test(html),
    "the main navigation should have its accessible label"
  );
  assert.ok(
    html.includes('<main id="main-content" tabindex="-1"'),
    "the skip-link target should be programmatically focusable"
  );
  assert.match(html, /<footer\b/);
  const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)];
  assert.equal(headings.length, 1, "each page has one primary heading");
  assert.ok(headings[0][1].replace(/<[^>]*>/g, "").trim(), "the heading has text");

  const skipLinkStart = '<a class="skip-link" href="#main-content"';
  const skipLinkEnd = ">Skip to main content</a>";
  const skipLinkPosition = html.indexOf(skipLinkStart);
  assert.ok(skipLinkPosition >= 0, "the skip link should target main-content");
  assert.equal(html.indexOf(skipLinkStart), html.lastIndexOf(skipLinkStart));
  assert.ok(
    html.indexOf(skipLinkEnd, skipLinkPosition) > skipLinkPosition,
    "the skip link should have its expected accessible name"
  );
  assert.equal(html.includes("astro-island"), false, "the static site should not emit islands");
};

const assertCloudStorageCopy = (html) => {
  assert.ok(
    html.includes("Cloud files have public URLs during alpha"),
    "the site should disclose public direct cloud file access"
  );
  assert.doesNotMatch(
    html,
    /private (?:cloud|workspace|copy|artifacts)|encrypted and private|private by default|securely archives/i,
    "the site must not promise private cloud file storage during alpha"
  );
};

const assertStylesheetAndInternalLinks = (html, output, expectedBase) => {
  const origin = readSiteOrigin();
  const socialImage = `${origin}${expectedBase}/social-preview.png?v=2`;
  assert.ok(html.includes(`property="og:image" content="${socialImage}"`));
  assert.ok(html.includes(`name="twitter:image" content="${socialImage}"`));
  assert.ok(html.includes(`rel="canonical" href="${origin}${expectedBase}/"`));
  for (const filename of ["favicon.svg", "favicon.ico", "apple-touch-icon.png"]) {
    assert.ok(html.includes(`href="${expectedBase}/${filename}?v=2"`));
    assert.ok(existsSync(resolve(output, filename)));
  }
  assert.ok(existsSync(resolve(output, "social-preview.png")));
  const stylesheetHrefs = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(
    ([, href]) => href
  );
  assert.ok(stylesheetHrefs.length > 0, "the homepage should link its stylesheet");

  const assetDirectory = resolve(output, "_astro");
  const cssFiles = readdirSync(assetDirectory).filter((file) => file.endsWith(".css"));
  assert.ok(cssFiles.length > 0, "the build should emit stylesheet assets");
  const expectedStylesheetPrefix = `${expectedBase}/_astro/`;
  for (const href of stylesheetHrefs) {
    assert.ok(
      href.startsWith(expectedStylesheetPrefix),
      "the stylesheet should not lose its deployment prefix"
    );
    assert.ok(
      existsSync(resolve(assetDirectory, href.slice(expectedStylesheetPrefix.length))),
      "the stylesheet linked by the homepage should exist"
    );
  }

  const expectedHomeHref = expectedBase || "/";
  const wordmarkMarker = `<a class="brand" href="${expectedHomeHref}" aria-label="plansplease home"`;
  assert.ok(
    html.includes(wordmarkMarker),
    "the home link should exactly use the configured deployment prefix"
  );
};

const assertMarketingPages = (output) => {
  const pages = [
    ["features", "Features"],
    ["cli", "CLI"],
    ["about", "About"],
    ["docs", "Docs"],
    ["mcp", "MCP"],
    ["pricing", "Pricing"],
    ["faq", "FAQ"],
    ["privacy", "Privacy"],
  ];

  for (const [directory, title] of pages) {
    const page = resolve(output, directory, "index.html");
    assert.ok(existsSync(page), `${directory}/index.html should exist after a build`);

    const html = readFileSync(page, "utf8");
    assert.ok(
      html.includes(`<title>${title} | plansplease</title>`),
      `${directory} should have its page title`
    );
    assertSiteBasics(html);
    assertCloudStorageCopy(html);
  }
};

const assertHomepage = (output, expectedBase) => {
  const homepage = resolve(output, "index.html");
  assert.ok(existsSync(homepage), `${output}/index.html should exist after a build`);

  const html = readFileSync(homepage, "utf8");
  assert.ok(html.includes("plansplease"));
  assertCloudStorageCopy(html);
  assert.ok(html.includes("Continue with GitHub"));
  assert.ok(html.includes('href="https://plansplease-docs-staging.up.railway.app/"'));
  assert.ok(html.includes("plansplease publish ./auth-migration-spec.html"));
  assert.ok(html.includes("plansplease.app/p/auth-migration-spec"));
  assert.ok(html.includes("http://localhost:4777/auth-migration-spec"));
  assert.ok(html.includes("plansplease upload ./auth-migration-spec.html"));
  assert.ok(html.includes('href="https://plansplease-app-staging.up.railway.app/"'));
  for (const route of ["pricing", "docs", "faq"]) {
    assert.ok(html.includes(`href="${expectedBase}/${route}/"`), `navigation to ${route}`);
  }
  assertSiteBasics(html);
  assertStylesheetAndInternalLinks(html, output, expectedBase);
  assertMarketingPages(output);
};

test("root static build is hermetic and emits the project homepage", () => {
  withBuild({ outputDirectory: "dist", basePath: "" }, (output) => assertHomepage(output, ""));
});

test("base-path normalization prefixes exact internal asset and home-link output", () => {
  withBuild(
    {
      outputDirectory: "dist-base",
      basePath: "//planview///",
    },
    (output) => assertHomepage(output, "/planview")
  );
});

test("site canonical origin supports custom deployments and rejects unsafe metadata URLs", () => {
  assert.equal(readSiteOrigin("https://product.example.com/"), "https://product.example.com");
  assert.equal(readSiteOrigin("http://127.0.0.1:4321"), "http://127.0.0.1:4321");
  for (const value of [
    "javascript:alert(1)",
    "http://product.example.com",
    "https://user:secret@product.example.com",
    "https://product.example.com/private",
    "https://product.example.com/?x=1",
    "https://product.example.com/#x",
  ])
    assert.throws(() => readSiteOrigin(value), undefined, value);
});
