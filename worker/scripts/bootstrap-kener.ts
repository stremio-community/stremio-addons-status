/**
 * One-time (idempotent, safe to re-run) bootstrap of the static Kener monitors:
 * the Stremio Platform / Debrid Services / Infrastructure checks.
 * Kener probes these itself (API monitors on a 5m cron); the worker never touches them beyond preserving their home-page positions.
 *
 * These probe directly (no WARP proxy: Kener has no per-monitor SOCKS support).
 * If one starts flapping from datacenter-IP blocking, move that check into the worker's push path instead.
 *
 * Usage: pnpm -F worker bootstrap:kener  (needs KENER_URL + KENER_API_TOKEN, see .env.example)
 */

const KENER_URL = (process.env.KENER_URL || "http://localhost:3002").replace(/\/$/, "");
const KENER_API_TOKEN = process.env.KENER_API_TOKEN || "";

interface StaticMonitor {
  tag: string;
  name: string;
  category: string;
  url: string;
  method?: string;
  eval?: string;
}

/** Eval body: UP when the HTTP status is one of the allowed codes. */
function statusEval(allowed: number[]): string {
  return `async function (statusCode, responseTime) {
  return { status: [${allowed.join(", ")}].includes(statusCode) ? "UP" : "DOWN", latency: responseTime };
}`;
}

// Order here is the home-page display order of the static block (after the worker's Addons / Addon Instances).
const STATIC_MONITORS: StaticMonitor[] = [
  {
    tag: "stremio-api",
    name: "Stremio API",
    category: "Stremio Platform",
    url: "https://api.strem.io/api/v1",
    method: "POST",
    // The bare API root rejects the empty call, but any of these means the service is up.
    eval: statusEval([200, 400, 405]),
  },
  {
    tag: "cinemeta",
    name: "Cinemeta",
    category: "Stremio Platform",
    url: "https://v3-cinemeta.strem.io/manifest.json",
    eval: `async function (statusCode, responseTime, responseRaw) {
  let manifest = responseRaw;
  if (typeof manifest === "string") {
    try { manifest = JSON.parse(manifest); } catch { manifest = null; }
  }
  const ok = statusCode === 200 && !!manifest && !!manifest.id;
  return { status: ok ? "UP" : "DOWN", latency: responseTime };
}`,
  },
  {
    tag: "stremio-web-player",
    name: "Stremio Web Player",
    category: "Stremio Platform",
    url: "https://web.stremio.com/",
  },
  {
    tag: "stremio-website",
    name: "Stremio Website",
    category: "Stremio Platform",
    url: "https://www.stremio.com/",
  },
  {
    tag: "real-debrid-api",
    name: "Real-Debrid API",
    category: "Debrid Services",
    url: "https://api.real-debrid.com/rest/1.0/time",
  },
  {
    tag: "alldebrid-api",
    name: "AllDebrid API",
    category: "Debrid Services",
    url: "https://api.alldebrid.com/v4/ping",
  },
  {
    tag: "premiumize-api",
    name: "Premiumize API",
    category: "Debrid Services",
    url: "https://www.premiumize.me/api/account/info",
    // 401 = up but unauthenticated, which is all a keyless probe can expect.
    eval: statusEval([200, 401]),
  },
  {
    tag: "torbox-api",
    name: "TorBox API",
    category: "Debrid Services",
    url: "https://api.torbox.app/v1/api/stats",
    eval: statusEval([200, 401]),
  },
  {
    tag: "stremio-addons-net",
    name: "stremio-addons.net",
    category: "Infrastructure",
    url: "https://stremio-addons.net/health",
    eval: `async function (statusCode, responseTime, responseRaw) {
  const ok = statusCode === 200 && String(responseRaw).trim() === "OK";
  return { status: ok ? "UP" : "DOWN", latency: responseTime };
}`,
  },
];

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${KENER_URL}/api/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KENER_API_TOKEN}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`kener ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

function monitorBody(m: StaticMonitor) {
  return {
    name: m.name,
    category_name: m.category,
    monitor_type: "API",
    cron: "*/5 * * * *",
    is_hidden: "NO",
    type_data: {
      url: m.url,
      method: m.method || "GET",
      timeout: 10_000,
      ...(m.eval ? { eval: m.eval } : {}),
    },
  };
}

async function main(): Promise<void> {
  if (!KENER_API_TOKEN) {
    console.error("KENER_API_TOKEN is required");
    process.exit(1);
  }

  const existing = (await api("GET", "/monitors")) as { monitors: Array<{ tag: string }> };
  const existingTags = new Set(existing.monitors.map((m) => m.tag));

  for (const m of STATIC_MONITORS) {
    if (existingTags.has(m.tag)) {
      await api("PATCH", `/monitors/${m.tag}`, monitorBody(m));
      console.log(`updated ${m.tag}`);
    } else {
      await api("POST", "/monitors", { tag: m.tag, ...monitorBody(m) });
      console.log(`created ${m.tag}`);
    }
  }

  // Append missing static tags to the home page, in STATIC_MONITORS order.
  // The worker's reconcile preserves this block (in its relative order) after the dynamic addon categories.
  const page = (await api("GET", "/pages/~home")) as {
    page: { monitors: Array<{ monitor_tag: string; position: number }> };
  };
  const current = page.page.monitors.sort((a, b) => a.position - b.position).map((m) => m.monitor_tag);
  const missing = STATIC_MONITORS.map((m) => m.tag).filter((tag) => !current.includes(tag));
  if (missing.length > 0) {
    await api("PATCH", "/pages/~home", { monitors: [...current, ...missing] });
    console.log(`added to home page: ${missing.join(", ")}`);
  } else {
    console.log("home page already contains all static monitors");
  }

  console.log("done");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
