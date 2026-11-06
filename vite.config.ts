import { cloudflare } from "@cloudflare/vite-plugin";
import { deployWatch } from "@rivi-software/deploy-watch/vite";
import { posthogSourcemaps } from "@rivi-software/posthog-tanstack-start/vite";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    // The inspector on 9230, so another Worker's dev server can keep the default 9229 beside it.
    cloudflare({ viteEnvironment: { name: "ssr" }, inspectorPort: 9230 }),
    // The app lives in ./app (routes in ./app/routes, router in ./app/router.tsx).
    tanstackStart({ srcDirectory: "app" }),
    viteReact(),
    // Source maps for PostHog error tracking, uploaded on main by `Build workspace` (`@rivi-software/posthog-tanstack-start/vite`).
    ...posthogSourcemaps({ releaseName: "workspace" }),
    // The build's commit for open tabs (CORE-1169, `@rivi-software/deploy-watch`): the root document writes it
    // into every page and dist/client/build.json carries it, so a tab learns when a deploy replaced it.
    deployWatch(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  // 5174, so another Vite dev server can keep 5173 beside it.
  server: { port: 5174 },
});
