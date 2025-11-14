# vite-plugin-tauri-in-the-browser

Let any browser borrow Tauri powers. This dev-only Vite 7 plugin spins up a WebSocket switchboard that shares a single "leader" Tauri WebView with unlimited follower browsers so they can call `@tauri-apps/api` without native access.

```
Chrome / AI Browser (follower)
          |
          |  ws rpc (invoke, result)
          v
Vite dev server + tauri-leader-proxy
          |
          |  ws rpc
          v
Tauri WebView (leader) ──> __TAURI_INTERNALS__ ──> Rust commands
```

## Why?

- **Debug Tauri apps in Chrome** – use full Chrome DevTools, extensions, and AI tooling against the same code your desktop WebView runs.
- **Let MCP servers plug in** – point an MCP client (like the Chrome DevTools MCP server) at your Vite dev URL and script native calls remotely, perfect for automation/testing agents.

## Install & wire up

```bash
bun add -D vite-plugin-tauri-in-the-browser
```

```ts
// vite.config.ts
import tauriLeaderProxy from "vite-plugin-tauri-in-the-browser";

export default defineConfig(() => ({
  plugins: [
    react(),
    tauriLeaderProxy({
      path: "/__tauri-sync__", // optional (default)
      log: true, // optional console tracing
    }),
  ],
  server: { port: 1420, strictPort: true },
}));
```

Start your normal dev workflow (`bun dev` or `tauri dev`). The first WebView that exposes `__TAURI_INTERNALS__` becomes the **leader**; every other browser tab automatically receives a shimmed `__TAURI_INTERNALS__` that forwards `invoke` calls over WebSocket to the leader and resolves the responses locally.

## Chrome DevTools MCP example

1. Run your stack:
   ```bash
   bun dev
   ```
2. Launch the Chrome DevTools MCP server (e.g. via `chrome --remote-debugging-port=9222` or your favorite MCP host) and connect it to `http://localhost:1420/`.
3. Give your agent a prompt:
   ```
   Connect to the Chrome DevTools MCP server at http://localhost:1420/.
   In the open page, run `window.__TAURI_INTERNALS__.invoke("get_cwd")` and share the result.
   ```
4. The agent (or you, via DevTools) now has full access to `@tauri-apps/api` while the real native work still happens inside the Tauri window running on your machine.

## Notes

- Dev-only by design. Never expose the proxy outside localhost.
- Today the RPC covers `invoke`; event listening/emitting can be layered on with the same protocol.
- Need visibility? Inspect `window.__TAURI_SYNC_STATUS__` in any tab to see whether a leader is connected and which client ID you’re using.
