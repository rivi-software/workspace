// What Tauri gives the start page (src/start.js): the IPC its own API calls into. Each command of
// src-tauri/src/endpoint.rs answers an address or null, and rejects with its reason as a string.
interface Window {
  __TAURI_INTERNALS__?: {
    invoke: (
      command: string,
      args?: Record<string, string>
    ) => Promise<string | null>;
  };
}
