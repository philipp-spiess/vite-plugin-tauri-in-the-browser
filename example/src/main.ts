import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";

type CpuUsagePayload = {
  usage: number;
  timestamp_ms: number;
};

const rpcStatusEl = document.querySelector<HTMLElement>("#rpc-status");
const eventStatusEl = document.querySelector<HTMLElement>("#event-status");
const filesOutputEl = document.querySelector<HTMLElement>("#files-output");
const cpuPanelEl = document.querySelector<HTMLElement>("#cpu-panel");
const listFilesBtn = document.querySelector<HTMLButtonElement>("#list-files");

const eventHistory: string[] = [];

renderFileList([]);
renderCpuPanel(null);
setRpcStatus("idle");
setEventStatus("connecting…");
wireEventStream();
listFilesBtn?.addEventListener("click", () => {
  void fetchHomeFiles();
});

async function fetchHomeFiles() {
  if (!listFilesBtn) {
    return;
  }
  listFilesBtn.disabled = true;
  setRpcStatus("invoke list_home_files …");
  try {
    const files = await invoke<string[]>("list_home_files");
    renderFileList(files);
    setRpcStatus(`ok · ${files.length} items`);
  } catch (error) {
    renderFileList([]);
    setRpcStatus(`error · ${formatError(error)}`);
  } finally {
    listFilesBtn.disabled = false;
  }
}

function renderFileList(files: string[]) {
  if (!filesOutputEl) {
    return;
  }
  const border = "+---------------- FILES ----------------+";
  const lines = files.length
    ? files.map(
        (name, idx) => `| ${String(idx + 1).padStart(2, "0")} | ${name}`
      )
    : ["| waiting for command …"];
  filesOutputEl.textContent = [border, ...lines, border].join("\n");
}

function renderCpuPanel(payload: CpuUsagePayload | null) {
  if (!cpuPanelEl) {
    return;
  }
  if (!payload) {
    cpuPanelEl.textContent = [
      "+---------------- CPU STREAM ----------------+",
      "| awaiting event frames …",
      "+-------------------------------------------+",
    ].join("\n");
    return;
  }
  const meter = asciiMeter(payload.usage);
  const usageLine = `| usage ${payload.usage
    .toFixed(1)
    .padStart(6, " ")}% ${meter}`;
  const timeLine = `| tick  ${formatClock(payload.timestamp_ms)}`;
  cpuPanelEl.textContent = [
    "+---------------- CPU STREAM ----------------+",
    usageLine,
    timeLine,
    "+-------------------------------------------+",
  ].join("\n");
}

function pushEvent(payload: CpuUsagePayload) {
  eventHistory.unshift(
    `[${formatClock(payload.timestamp_ms)}] ${payload.usage
      .toFixed(1)
      .padStart(6, " ")}% ${asciiMeter(payload.usage)}`
  );
  eventHistory.splice(8);
  renderCpuPanel(payload);
}

function asciiMeter(value: number) {
  const width = 28;
  const normalized = Math.max(0, Math.min(100, value));
  const filled = Math.round((normalized / 100) * width);
  const bars = "#".repeat(filled).padEnd(width, ".");
  return `[${bars}]`;
}

function setRpcStatus(message: string) {
  if (rpcStatusEl) {
    rpcStatusEl.textContent = message;
  }
}

function setEventStatus(message: string) {
  if (eventStatusEl) {
    eventStatusEl.textContent = message;
  }
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatClock(timestamp: number) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

async function wireEventStream() {
  try {
    const unlisten = await listen<CpuUsagePayload>("cpu-usage", (event) => {
      if (event.payload) {
        pushEvent(event.payload);
      }
    });
    setEventStatus("listening");
    window.addEventListener("beforeunload", () => {
      void unlisten();
    });
  } catch (error) {
    setEventStatus(`failed · ${formatError(error)}`);
  }
}
