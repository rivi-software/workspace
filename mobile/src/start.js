// The app's start page. It asks the app which workspace to open (src-tauri/src/endpoint.rs), asks the
// person for its address when the app has none, and sends the web view on to it. When the workspace
// cannot be reached the web view stays on this page, which then says so, tries again when the phone
// is back online, and offers to try now or to name another workspace. On Android the web view leaves
// the page for its own error page instead, so the app brings it back with the address that failed,
// `?unreachable=` (Unreachable.kt in src-tauri/gen/android), and the page says so at once. A
// workspace's sign-in page links here with `?change` to name another workspace.
//
// This page is the only one that may call the app (src-tauri/capabilities/start-page.json). It
// reaches the app through `__TAURI_INTERNALS__`, which Tauri gives every page whether or not
// `withGlobalTauri` adds its API, since there is no build step to bundle `@tauri-apps/api`. Nothing
// in the address bar ever sets the workspace: only what the person types into the form.

/** How long the workspace may take to answer before the page says it cannot reach it. */
const PATIENCE_MS = 15_000;

/**
 * Calls one of the app's commands.
 * @param {string} command The command's name in src-tauri/src/endpoint.rs.
 * @param {Record<string, string>} [args] Its arguments.
 * @returns {Promise<string | null>} What it answers; it rejects with the app's reason.
 */
const invoke = (command, args) => {
  const internals = window.__TAURI_INTERNALS__;

  if (!internals) {
    return Promise.reject(new Error("This page runs outside the app."));
  }

  return internals.invoke(command, args);
};

const search = new URLSearchParams(location.search);

/** The address that failed to load when the Android app brought the web view back here. */
const failed = search.get("unreachable");

/** Whether a workspace's sign-in page sent the person here to name another workspace. */
const changing = search.has("change");

/**
 * Where to go: the workspace's page that failed to load, or else the workspace's start. Any other
 * site that failed (a sign-in on the way) starts again at the workspace, which sends it there.
 * @param {string} start The workspace's start page.
 * @returns {string} The address to open.
 */
const destinationFrom = (start) => {
  if (failed === null) {
    return start;
  }

  // Not URL.canParse: an Android System WebView before Chrome 120 lacks it.
  try {
    const page = new URL(failed);

    return page.origin === new URL(start).origin ? page.href : start;
  } catch {
    return start;
  }
};

/**
 * The element with `id`, of the kind the page expects; throws when the page has lost it.
 * @template {HTMLElement} T
 * @param {string} id The element's id.
 * @param {new () => T} kind Its class.
 * @returns {T} The element.
 */
const element = (id, kind) => {
  const found = document.querySelector(`#${id}`);

  if (!(found instanceof kind)) {
    throw new TypeError(`The start page has lost its #${id}`);
  }

  return found;
};

const heading = element("status", HTMLElement);
const detail = element("detail", HTMLElement);
const retry = element("retry", HTMLButtonElement);
const change = element("change", HTMLButtonElement);
const choose = element("choose", HTMLFormElement);
const address = element("address", HTMLInputElement);
const problem = element("problem", HTMLElement);
const openButton = element("open", HTMLButtonElement);
const cancel = element("cancel", HTMLButtonElement);

/** The workspace the app opens, once the app has answered; `null` while it has none. */
/** @type {string | null} */
let workspace = null;

/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;

/**
 * The address as the person would type it: the host alone over HTTPS, which the app assumes, and the whole origin
 * otherwise (a development workspace over plain HTTP), so the form takes it back as it was.
 * @param {string} start The workspace's start page.
 * @returns {string} The address for the form.
 */
const editable = (start) => {
  const url = new URL(start);

  return url.protocol === "https:" ? url.host : url.origin;
};

/** Shows the address form, with the address the app opens now, if any, to edit. */
const askForAddress = () => {
  clearTimeout(timer);
  heading.textContent = workspace
    ? "Use another workspace"
    : "Open your workspace";
  detail.hidden = true;
  retry.hidden = true;
  change.hidden = true;
  choose.hidden = false;
  cancel.hidden = workspace === null;
  problem.hidden = true;
  openButton.disabled = false;
  address.value = workspace ? editable(workspace) : "";
  address.focus();
};

const unreachable = () => {
  clearTimeout(timer);
  heading.textContent = "Can’t reach your workspace";
  choose.hidden = true;
  detail.hidden = false;
  retry.hidden = false;
  retry.disabled = false;
  change.hidden = false;
};

/**
 * Sends the web view to `destination`, and says the workspace cannot be reached if it has not
 * answered in time.
 * @param {string} destination A page of the workspace.
 */
const go = (destination) => {
  clearTimeout(timer);
  heading.textContent = "Opening your workspace…";
  choose.hidden = true;
  detail.hidden = true;
  retry.disabled = true;

  if (!navigator.onLine) {
    unreachable();

    return;
  }

  location.replace(destination);
  timer = setTimeout(unreachable, PATIENCE_MS);
};

const openWorkspace = () => {
  if (workspace === null) {
    askForAddress();

    return;
  }

  go(destinationFrom(workspace));
};

/** How long the check of a typed address may take. */
const CHECK_MS = 10_000;

/**
 * Whether a workspace answers at `start`: its `/api/health`, which every workspace lets any origin
 * read (app/routes/api/health.ts), answers `ok`. A typo that names another site would otherwise be
 * kept, and the app would open that site on every launch with no way back to this page. A
 * development workspace over plain HTTP is not checked: WebKit keeps this page's origin from it.
 * @param {string} start The workspace's start page.
 * @returns {Promise<string | null>} Why it is no workspace, in words for the person, or null.
 */
const checkWorkspace = async (start) => {
  const url = new URL(start);

  if (url.protocol !== "https:") {
    return null;
  }

  const { host } = url;
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), CHECK_MS);

  try {
    const response = await fetch(new URL("/api/health", url), {
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });

    /** @type {unknown} */
    const body = response.ok ? await response.json() : null;

    if (body instanceof Object && "ok" in body && body.ok === true) {
      return null;
    }

    return `${host} doesn’t answer as a workspace. Check the address.`;
  } catch {
    return navigator.onLine
      ? `Couldn’t find a workspace at ${host}. Check the address.`
      : "You’re offline. Connect to the internet and try again.";
  } finally {
    clearTimeout(abort);
  }
};

/** @param {string} reason Why the address was not kept, in words for the person. */
const refuse = (reason) => {
  problem.textContent = reason;
  problem.hidden = false;
  openButton.disabled = false;
  openButton.textContent = "Open";
  address.focus();
};

/** Checks the address typed, keeps it, and opens the workspace; or says why not. */
const submit = async () => {
  openButton.disabled = true;
  openButton.textContent = "Checking…";
  problem.hidden = true;

  try {
    const start = await invoke("parse_workspace_address", {
      address: address.value,
    });

    if (start === null) {
      throw new TypeError("The app answered no address.");
    }

    const reason = await checkWorkspace(start);

    if (reason) {
      refuse(reason);

      return;
    }

    await invoke("set_workspace_address", { address: start });
    openButton.textContent = "Open";
    workspace = start;
    go(start);
  } catch (error) {
    // The app's reasons are in words for the person (`Workspace::from_input`).
    refuse(String(error));
  }
};

choose.addEventListener("submit", (event) => {
  event.preventDefault();
  void submit();
});

cancel.addEventListener("click", openWorkspace);

retry.addEventListener("click", openWorkspace);

change.addEventListener("click", askForAddress);

window.addEventListener("online", () => {
  if (choose.hidden) {
    openWorkspace();
  }
});

const start = async () => {
  try {
    workspace = await invoke("workspace_address");
  } catch {
    workspace = null;
  }

  if (workspace === null || changing) {
    askForAddress();
  } else if (failed === null) {
    openWorkspace();
  } else {
    unreachable();
  }
};

void start();
