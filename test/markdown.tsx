import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown } from "~/lib/assistant/markdown";

/** The assistant's text as the page renders it, without the classes. Its links ask for the router, so one is there. */
export const renderMarkdown = (text: string): string => {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory(),
  });

  return renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <Markdown text={text} />
    </RouterContextProvider>
  ).replaceAll(/ class="[^"]*"/gu, "");
};
