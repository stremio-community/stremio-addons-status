import { config } from "./config.js";
import { fetchAllAddons } from "./api.js";
import { buildEndpoints, writeConfig, pushResult, type EndpointDescriptor } from "./gatus.js";
import { probe } from "./probe.js";
import { resetCycle } from "./idsources.js";
import { mapLimit } from "./concurrency.js";
import { errMsg, nextSlotAfter, sleep } from "./utils.js";
import { logger } from "./logger.js";
import type { ProbeResult } from "./types.js";

let endpoints: EndpointDescriptor[] = [];

async function refreshList(): Promise<void> {
  const addons = await fetchAllAddons();
  endpoints = buildEndpoints(addons);
  await writeConfig(endpoints);
  logger.info(
    { addons: addons.length, endpoints: endpoints.length },
    "list refreshed; wrote endpoints config",
  );
}

async function runCycle(): Promise<void> {
  if (endpoints.length === 0) return;
  resetCycle(); // rotate/refresh cached ID-source content each cycle
  const started = Date.now();
  let up = 0;
  let down = 0;
  let pushErrors = 0;

  await mapLimit(endpoints, config.concurrency, async (ep) => {
    const log = logger.child({ addon: ep.addon.slug });
    let r: ProbeResult;
    try {
      r = await probe(ep.addon);
    } catch (e) {
      r = {
        success: false,
        durationMs: 0,
        message: `probe error: ${errMsg(e)}`,
        error: "probe",
        detail: {
          live: false,
          livenessError: `probe error: ${errMsg(e)}`,
          manifestDetails: [],
          mode: "content",
          perResource: [],
        },
      };
    }
    if (r.success) up++;
    else down++;

    // Per-addon verdict: the final UP/DOWN plus the resource breakdown behind it.
    log[r.success ? "info" : "warn"](
      {
        verdict: r.success ? "UP" : "DOWN",
        mode: r.detail.mode,
        durationMs: r.durationMs,
        error: r.error,
        streamCounts: r.detail.streamCounts,
        resources: r.detail.perResource.map((p) => `${p.resource}:${p.ok ? "ok" : "fail"}`),
        message: r.message,
      },
      `verdict ${r.success ? "UP" : "DOWN"} (${r.detail.mode})`,
    );

    try {
      const status = await pushResult(ep, r);
      if (status >= 400) {
        pushErrors++;
        log.error({ key: ep.key, status }, "push failed");
      } else {
        log.debug({ key: ep.key, status }, "pushed verdict to Gatus");
      }
    } catch (e) {
      pushErrors++;
      log.error({ key: ep.key, err: errMsg(e) }, "push error");
    }
  });

  logger.info(
    { checked: endpoints.length, up, down, pushErrors, durationMs: Date.now() - started },
    "cycle complete",
  );
}

async function probeLoop(): Promise<void> {
  let slot = nextSlotAfter(Date.now(), config.probeInterval);
  for (;;) {
    await sleep(Math.max(0, slot - Date.now()));
    try {
      await runCycle();
    } catch (e) {
      logger.error({ err: errMsg(e) }, "cycle error");
    }
    // From the slot, not the clock, so a timer firing a millisecond early can't run the same slot twice; a cycle that overran skips the slots it missed.
    slot = nextSlotAfter(Math.max(Date.now(), slot), config.probeInterval);
  }
}

async function listLoop(): Promise<void> {
  for (;;) {
    await sleep(config.listRefresh);
    try {
      await refreshList();
    } catch (e) {
      logger.error({ err: errMsg(e) }, "list refresh error");
    }
  }
}

async function main(): Promise<void> {
  if (!config.pushToken) {
    logger.fatal("PUSH_TOKEN is required");
    process.exit(1);
  }
  logger.info(
    {
      proxy: config.proxyUrl || "none",
      concurrency: config.concurrency,
      probeInterval: config.probeInterval,
      listRefresh: config.listRefresh,
    },
    "starting worker",
  );

  // Retry initial list load until the API is reachable.
  for (;;) {
    try {
      await refreshList();
      break;
    } catch (e) {
      logger.error({ err: errMsg(e) }, "initial list refresh failed, retrying in 30s");
      await sleep(30_000);
    }
  }

  void listLoop();
  await probeLoop();
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

main().catch((e) => {
  logger.fatal({ err: errMsg(e) }, "fatal");
  process.exit(1);
});
