import type { WorkerBundleCheckOptions } from "@rivi-software/workers-bundle-check";

/**
 * What the production build must not carry (`pnpm run build:check`, after `pnpm run build`): a source map the assets
 * would serve, a value shaped like a secret in the Worker or the assets, and the markers below. The rules are markers,
 * not modules: Rolldown writes no source map for the chunks of virtual modules (Start's manifest, its server function
 * resolver, its own runtime), and a module rule fails every file it cannot see into.
 */
export default {
  serverDir: "dist/server",
  assetsDir: "dist/client",
  forbidden: [
    {
      // The worker's URL is what `loadPdfJs` imports beside pdf.js; without its `import.meta.env.SSR` guard the
      // server build carries both.
      marker: "pdf.worker.min",
      reason:
        "pdf.js draws pages in the browser only (loadPdfJs, app/components/drive/pdf-pages.tsx)",
    },
  ],
} satisfies WorkerBundleCheckOptions;
