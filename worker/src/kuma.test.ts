import { describe, expect, it } from "vitest";
import { config } from "./config.js";
import type { KumaMonitor } from "./kuma-client.js";
import {
  addonMonitorDrift,
  buildMonitorPlan,
  desiredGroups,
  staticMonitorDrift,
  STATIC_MONITORS,
  type Binding,
} from "./kuma.js";
import type { NormalizedAddon } from "./types.js";

function addon(overrides: Partial<NormalizedAddon>): NormalizedAddon {
  return {
    uuid: "uuid-1",
    slug: "my-addon",
    name: "My Addon",
    manifestUrl: "https://example.com/manifest.json",
    baseUrl: "https://example.com",
    stars: 0,
    categories: ["Movies"],
    ...overrides,
  };
}

function monitor(overrides: Partial<KumaMonitor>): KumaMonitor {
  return {
    id: 1,
    name: "My Addon",
    type: "push",
    active: true,
    interval: config.pushWatchdog,
    retryInterval: config.pushWatchdog,
    maxretries: 0,
    accepted_statuscodes: ["200-299"],
    tags: [],
    ...overrides,
  };
}

describe("buildMonitorPlan", () => {
  it("keys by slug, falling back to uuid, and groups instances separately", () => {
    const plan = buildMonitorPlan([
      addon({ slug: "a", name: "A" }),
      addon({ uuid: "u2", slug: "", name: "B" }),
      addon({ uuid: "u3", slug: "c", name: "C", instanceOf: "A" }),
    ]);
    expect(plan.map((p) => [p.slug, p.group])).toEqual([
      ["a", "Addons"],
      ["u2", "Addons"],
      ["c", "Addon Instances"],
    ]);
  });

  it("suffixes every sharer of a colliding name, case-insensitively, within the same group", () => {
    const plan = buildMonitorPlan([
      addon({ uuid: "u1", slug: "sub-a", name: "BGsubs" }),
      addon({ uuid: "u2", slug: "sub-b", name: "bgSubs" }),
      addon({ uuid: "u3", slug: "sub-c", name: "bgsubs", instanceOf: "BGsubs" }),
    ]);
    // Both sharers in "Addons" get the suffix; the instance lives in another group and keeps its name.
    expect(plan.map((p) => p.name)).toEqual(["BGsubs (sub-a)", "bgSubs (sub-b)", "bgsubs"]);
  });

  it("drops later addons with a duplicate slug so two addons never contend for one monitor", () => {
    const plan = buildMonitorPlan([
      addon({ uuid: "u1", slug: "same", name: "First" }),
      addon({ uuid: "u2", slug: "same", name: "Second" }),
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.name).toBe("First");
  });
});

describe("addonMonitorDrift", () => {
  const plan = buildMonitorPlan([addon({ slug: "a", name: "My Addon" })])[0]!;

  it("returns null when nothing the worker owns changed", () => {
    expect(addonMonitorDrift(monitor({}), plan)).toBeNull();
  });

  it("patches a rename without touching anything else", () => {
    expect(addonMonitorDrift(monitor({ name: "Old Name" }), plan)).toEqual({ name: "My Addon" });
  });

  it("patches watchdog interval and maxretries drift", () => {
    expect(addonMonitorDrift(monitor({ interval: 60, maxretries: 3 }), plan)).toEqual({
      interval: config.pushWatchdog,
      maxretries: 0,
    });
  });
});

describe("staticMonitorDrift", () => {
  const def = STATIC_MONITORS.find((d) => d.name === "Premiumize API")!;
  const existing = monitor({
    type: "http",
    name: def.name,
    url: def.url,
    method: "GET",
    accepted_statuscodes: ["200", "401"],
    proxyId: 7,
  });

  it("returns null when the monitor matches its definition", () => {
    expect(staticMonitorDrift(existing, def, 7)).toBeNull();
  });

  it("patches accepted status codes and proxy drift", () => {
    expect(
      staticMonitorDrift({ ...existing, accepted_statuscodes: ["200"], proxyId: null }, def, 7),
    ).toEqual({ accepted_statuscodes: ["200", "401"], proxyId: 7 });
  });
});

describe("desiredGroups", () => {
  it("renders the five groups in fixed order with addons sorted by display name", () => {
    const addons = [
      addon({ uuid: "u1", slug: "zeta", name: "Zeta" }),
      addon({ uuid: "u2", slug: "alpha", name: "Alpha" }),
      addon({ uuid: "u3", slug: "inst", name: "Instance", instanceOf: "Zeta" }),
    ];
    const plan = buildMonitorPlan(addons);
    const bindings: Binding[] = plan.map((p, i) => ({
      addon: p.addon,
      monitorID: 100 + i,
      pushToken: "t",
      name: p.name,
    }));
    const staticIds = new Map(STATIC_MONITORS.map((d, i) => [d.name, 200 + i]));

    const groups = desiredGroups(bindings, plan, staticIds);
    expect(groups.map((g) => g.name)).toEqual([
      "Addons",
      "Addon Instances",
      "Stremio Platform",
      "Debrid Services",
      "Infrastructure",
    ]);
    // Zeta (id 100) sorts after Alpha (id 101).
    expect(groups[0]!.monitorIds).toEqual([101, 100]);
    expect(groups[1]!.monitorIds).toEqual([102]);
    const staticCount =
      groups[2]!.monitorIds.length + groups[3]!.monitorIds.length + groups[4]!.monitorIds.length;
    expect(staticCount).toBe(STATIC_MONITORS.length);
  });

  it("omits static monitors that failed to provision instead of emitting undefined ids", () => {
    const groups = desiredGroups([], [], new Map([["Cinemeta", 42]]));
    expect(groups[2]!.monitorIds).toEqual([42]);
    expect(groups[4]!.monitorIds).toEqual([]);
  });
});
