import { config } from "./config.js";
import { fetchAllAddons } from "./api.js";
import { buildEndpoints, writeConfig, pushResult, type EndpointDescriptor } from "./gatus.js";
import { probe } from "./probe.js";
import { resetCycle } from "./idsources.js";
import { mapLimit } from "./concurrency.js";
import { errMsg, sleep } from "./utils.js";
import type { ProbeResult } from "./types.js";

// TODO: add proper logging library
function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

let endpoints: EndpointDescriptor[] = [];

async function refreshList(): Promise<void> {
  const addons = await fetchAllAddons();
  endpoints = buildEndpoints(addons);
  await writeConfig(endpoints);
  log(
    `list refresh: fetched ${addons.length} addons; wrote ${endpoints.length} endpoints to config`,
  );
}

async function runCycle(): Promise<void> {
  if (endpoints.length === 0) return;
  resetCycle(); // rotate/refresh cached ID-source content each cycle
  let up = 0;
  let down = 0;
  let pushErrors = 0;

  await mapLimit(endpoints, config.concurrency, async (ep) => {
    let r: ProbeResult;
    try {
      r = await probe(ep.addon);
    } catch (e) {
      r = {
        success: false,
        durationMs: 0,
        message: `probe error: ${errMsg(e)}`,
        error: "probe",
        detail: { live: false, mode: "content", perResource: [] },
      };
    }
    if (r.success) up++;
    else down++;
    try {
      const status = await pushResult(ep, r);
      if (status >= 400) {
        pushErrors++;
        log(`push failed for ${ep.key}: HTTP ${status}`);
      }
    } catch (e) {
      pushErrors++;
      log(`push error for ${ep.key}: ${errMsg(e)}`);
    }
  });

  log(`cycle: checked ${endpoints.length} · up ${up} · down ${down} · pushErrors ${pushErrors}`);
}

async function probeLoop(): Promise<void> {
  for (;;) {
    const started = Date.now();
    try {
      await runCycle();
    } catch (e) {
      log(`cycle error: ${errMsg(e)}`);
    }
    await sleep(Math.max(0, config.probeInterval - (Date.now() - started)));
  }
}

async function listLoop(): Promise<void> {
  for (;;) {
    await sleep(config.listRefresh);
    try {
      await refreshList();
    } catch (e) {
      log(`list refresh error: ${errMsg(e)}`);
    }
  }
}

async function main(): Promise<void> {
  if (!config.pushToken) {
    log("FATAL: PUSH_TOKEN is required");
    process.exit(1);
  }
  log(
    `starting: proxy=${config.proxyUrl || "none"} concurrency=${config.concurrency} ` +
      `probeInterval=${config.probeInterval}ms listRefresh=${config.listRefresh}ms`,
  );

  // Retry initial list load until the API is reachable.
  for (;;) {
    try {
      await refreshList();
      break;
    } catch (e) {
      log(`initial list refresh failed, retrying in 30s: ${errMsg(e)}`);
      await sleep(30_000);
    }
  }

  void listLoop();
  await probeLoop();
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

main().catch((e) => {
  log(`fatal: ${errMsg(e)}`);
  process.exit(1);
});
