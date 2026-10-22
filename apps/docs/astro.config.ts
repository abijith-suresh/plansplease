import { writeFile } from "node:fs/promises";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { loadEnv } from "vite";
import { readPublicUrls } from "./src/lib/public-urls.ts";

const urls = readPublicUrls({
  // biome-ignore lint/complexity/useLiteralKeys: Node environment declarations use an index signature.
  ...loadEnv(
    process.env["NODE_ENV"] ?? "production",
    process.env["PLANVIEW_ENV_DIR"] ?? process.cwd(),
    "PUBLIC_"
  ),
  ...process.env,
});

export default defineConfig({
  output: "static",
  site: urls.docsOrigin,
  base: urls.docsBasePath,
  trailingSlash: "always",
  vite: {
    envDir: process.env["PLANVIEW_ENV_DIR"] ?? process.cwd(),
    define: {
      "import.meta.env.PUBLIC_APP_URL": JSON.stringify(urls.appUrl),
      "import.meta.env.PUBLIC_SITE_URL": JSON.stringify(urls.siteUrl),
      "import.meta.env.PUBLIC_DOCS_URL": JSON.stringify(urls.docsUrl),
    },
  },
  integrations: [
    starlight({
      title: "plansplease docs",
      description: "Guides for local previews, cloud documents, and MCP agents.",
      favicon: "/favicon.svg?v=2",
      customCss: ["./src/styles/docs.css"],
      tableOfContents: false,
      expressiveCode: {
        themes: ["starlight-dark"],
        useDarkModeMediaQuery: false,
        styleOverrides: {
          borderColor: "rgba(255, 255, 255, 0.08)",
          frames: {
            editorBackground: "#121214",
            terminalBackground: "#121214",
            inlineButtonForeground: "#d9d9dc",
            frameBoxShadowCssValue: "none",
          },
        },
      },
      head: [
        { tag: "meta", attrs: { name: "theme-color", content: "#0c0c0e" } },
        {
          tag: "link",
          attrs: {
            rel: "icon",
            href: `${urls.docsBasePath}favicon.ico?v=2`,
            sizes: "16x16 32x32 48x48",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "apple-touch-icon",
            href: `${urls.docsBasePath}apple-touch-icon.png?v=2`,
            sizes: "180x180",
          },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: new URL("social-preview.png?v=2", urls.docsUrl).href,
          },
        },
        { tag: "meta", attrs: { property: "og:image:type", content: "image/png" } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        {
          tag: "meta",
          attrs: { property: "og:image:alt", content: "plansplease. Start with plansplease." },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:image",
            content: new URL("social-preview.png?v=2", urls.docsUrl).href,
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:image:alt",
            content: "plansplease. Start with plansplease.",
          },
        },
      ],
      components: {
        Header: "./src/components/Header.astro",
        ThemeProvider: "./src/components/DarkTheme.astro",
        ThemeSelect: "./src/components/Empty.astro",
        MobileMenuFooter: "./src/components/Empty.astro",
      },
      editLink: { baseUrl: "https://github.com/abijith-suresh/planview/edit/main/apps/docs/" },
      sidebar: [
        { label: "Get started", slug: "index" },
        {
          label: "Setup",
          items: [
            { label: "Install the CLI", slug: "guides/install-cli" },
            { label: "Connect MCP", slug: "guides/mcp" },
            { label: "Self-hosting", slug: "guides/self-hosting" },
          ],
        },
        {
          label: "Guides",
          collapsed: true,
          items: [{ slug: "guides/cli" }, { slug: "guides/cloud" }, { slug: "guides/agents" }],
        },
        {
          label: "Reference",
          collapsed: true,
          items: [
            { slug: "reference/troubleshooting" },
            { slug: "reference/privacy-and-limits" },
            { slug: "reference/architecture" },
            { slug: "reference/development" },
            { slug: "reference/planned-features" },
          ],
        },
      ],
    }),
    {
      name: "plansplease-docs-runtime",
      hooks: {
        "astro:build:done": async ({ dir }) => {
          await writeFile(
            new URL("docs-runtime.json", dir),
            JSON.stringify({ basePath: urls.docsBasePath })
          );
        },
      },
    },
  ],
});
