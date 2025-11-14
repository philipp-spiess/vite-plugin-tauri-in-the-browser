# vite-plugin-tauri-in-the-browser

Let any browser borrow Tauri powers. This dev-only Vite plugin spins up a WebSocket switchboard that shares a single "leader" Tauri WebView with unlimited follower browsers so they can call `@tauri-apps/api` without native access.

```
   ┌────────────────────────────────┐
   │                                │
   │ Chrome / AI Browser (follower) │
   │                                │
   └────────────────────────────────┘
                   │
                   │  ws rpc (invoke, result)
                   │
                   ▼
┌──────────────────────────────────────┐
│                                      │
│ Vite dev server + tauri-leader-proxy │
│                                      │
└──────────────────────────────────────┘
                   │
                   │  ws rpc
                   │
                   ▼
       ┌────────────────────────┐     ┌─────────────────────┐     ┌──────────────┐
       │                        │     │                     │     │              │
       │ Tauri WebView (leader) ├────▶│ __TAURI_INTERNALS__ ├────▶│ Rust backend │
       │                        │     │                     │     │              │
       └────────────────────────┘     └─────────────────────┘     └──────────────┘
```

## Why?

- **Debug Tauri apps in Chrome** – use full Chrome DevTools, extensions, and AI tooling against the same code your desktop WebView runs.
- **Let MCP servers plug in** – point an MCP client (like the Chrome DevTools MCP server) at your Vite dev URL and script native calls remotely, perfect for automation/testing agents.

## Install & wire up

```bash
npm add -D vite-plugin-tauri-in-the-browser
```

```ts
// vite.config.ts
import tauriBrowserProxy from "vite-plugin-tauri-in-the-browser";

export default defineConfig(() => ({
  plugins: [react(), tauriBrowserProxy()],
  server: { port: 1420, strictPort: true },
}));
```

Start your normal dev workflow (`npm run tauri dev`). Once your app starts, you can open the frontend in the browser of your choice: [`http://localhost:1420/`](http://localhost:1420/).

## Chrome DevTools MCP example

One use case this enables is that it gives your coding agents a way to _see_ your frontend code while working on your Tauri app. To do this:

1. Set up the [Chrome DevTools MCP server](https://github.com/ChromeDevTools/chrome-devtools-mcp) in your coding agent.
2. Give your agent a prompt like this (either put it in `AGENTS.md` or copy past as needed):
   ```
   You can connect to the frontend via Chrome DevTools MCP server at http://localhost:1420/. To do this, first start the Tauri dev app in the background via `npm run tauri dev`. Once the app is running, you can connect to the frontend via the MCP server.
   ```
