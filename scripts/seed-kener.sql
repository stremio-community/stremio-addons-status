-- Kener seed data, applied by scripts/seed-kener.sh on every stack startup (idempotent).
-- Runs with psql variables: :'tok' = KENER_API_TOKEN, :'sec' = KENER_SECRET_KEY.
--
-- This writes Kener's own tables directly instead of going through its v4 API, which couples us
-- to Kener's internal schema; the image is pinned in compose.yaml, so verify this file when upgrading.

-- Worker API key. Kener stores hmac_sha256(KENER_SECRET_KEY, token), which is deterministic,
-- so the token configured in .env is always valid.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO api_keys (name, hashed_key, masked_key)
VALUES ('worker', encode(hmac(:'tok', :'sec', 'sha256'), 'hex'), left(:'tok', 6) || '****' || right(:'tok', 4))
ON CONFLICT (name) DO UPDATE
  SET hashed_key = EXCLUDED.hashed_key, masked_key = EXCLUDED.masked_key, updated_at = now();

-- Static monitors: the platform/debrid/infrastructure checks that Kener probes itself on a 5m cron.
-- These probe directly (Kener has no per-monitor SOCKS proxy); if one flaps from datacenter-IP
-- blocking, move that check into the worker's push path instead.
-- Without an eval, Kener's default API eval treats 2xx/3xx/429 as UP.
INSERT INTO monitors (tag, name, category_name, monitor_type, cron, status, default_status, type_data)
VALUES
  ('stremio-api', 'Stremio API', 'Stremio Platform', 'API', '*/5 * * * *', 'ACTIVE', 'UP',
   jsonb_build_object(
     'url', 'https://api.strem.io/api/v1',
     'method', 'POST',
     'timeout', 10000,
     -- The bare API root rejects the empty call, but any of these means the service is up.
     'eval', $ev$async function (statusCode, responseTime) {
  return { status: [200, 400, 405].includes(statusCode) ? "UP" : "DOWN", latency: responseTime };
}$ev$
   )::text),
  ('cinemeta', 'Cinemeta', 'Stremio Platform', 'API', '*/5 * * * *', 'ACTIVE', 'UP',
   jsonb_build_object(
     'url', 'https://v3-cinemeta.strem.io/manifest.json',
     'method', 'GET',
     'timeout', 10000,
     'eval', $ev$async function (statusCode, responseTime, responseRaw) {
  let manifest = responseRaw;
  if (typeof manifest === "string") {
    try { manifest = JSON.parse(manifest); } catch { manifest = null; }
  }
  const ok = statusCode === 200 && !!manifest && !!manifest.id;
  return { status: ok ? "UP" : "DOWN", latency: responseTime };
}$ev$
   )::text),
  ('stremio-web-player', 'Stremio Web Player', 'Stremio Platform', 'API', '*/5 * * * *', 'ACTIVE', 'UP',
   jsonb_build_object('url', 'https://web.stremio.com/', 'method', 'GET', 'timeout', 10000)::text),
  ('stremio-website', 'Stremio Website', 'Stremio Platform', 'API', '*/5 * * * *', 'ACTIVE', 'UP',
   jsonb_build_object('url', 'https://www.stremio.com/', 'method', 'GET', 'timeout', 10000)::text),
  ('real-debrid-api', 'Real-Debrid API', 'Debrid Services', 'API', '*/5 * * * *', 'ACTIVE', 'UP',
   jsonb_build_object('url', 'https://api.real-debrid.com/rest/1.0/time', 'method', 'GET', 'timeout', 10000)::text),
  ('alldebrid-api', 'AllDebrid API', 'Debrid Services', 'API', '*/5 * * * *', 'ACTIVE', 'UP',
   jsonb_build_object('url', 'https://api.alldebrid.com/v4/ping', 'method', 'GET', 'timeout', 10000)::text),
  ('premiumize-api', 'Premiumize API', 'Debrid Services', 'API', '*/5 * * * *', 'ACTIVE', 'UP',
   jsonb_build_object(
     'url', 'https://www.premiumize.me/api/account/info',
     'method', 'GET',
     'timeout', 10000,
     -- 401 = up but unauthenticated, which is all a keyless probe can expect.
     'eval', $ev$async function (statusCode, responseTime) {
  return { status: [200, 401].includes(statusCode) ? "UP" : "DOWN", latency: responseTime };
}$ev$
   )::text),
  ('torbox-api', 'TorBox API', 'Debrid Services', 'API', '*/5 * * * *', 'ACTIVE', 'UP',
   jsonb_build_object(
     'url', 'https://api.torbox.app/v1/api/stats',
     'method', 'GET',
     'timeout', 10000,
     'eval', $ev$async function (statusCode, responseTime) {
  return { status: [200, 401].includes(statusCode) ? "UP" : "DOWN", latency: responseTime };
}$ev$
   )::text),
  ('stremio-addons-net', 'stremio-addons.net', 'Infrastructure', 'API', '*/5 * * * *', 'ACTIVE', 'UP',
   jsonb_build_object(
     'url', 'https://stremio-addons.net/health',
     'method', 'GET',
     'timeout', 10000,
     'eval', $ev$async function (statusCode, responseTime, responseRaw) {
  const ok = statusCode === 200 && String(responseRaw).trim() === "OK";
  return { status: ok ? "UP" : "DOWN", latency: responseTime };
}$ev$
   )::text)
ON CONFLICT (tag) DO UPDATE SET
  name = EXCLUDED.name,
  category_name = EXCLUDED.category_name,
  monitor_type = EXCLUDED.monitor_type,
  cron = EXCLUDED.cron,
  type_data = EXCLUDED.type_data,
  updated_at = now();

-- Drop the demo monitors Kener seeds into an empty database; the category guard avoids
-- touching a real monitor that happens to reuse one of the demo tags.
DELETE FROM monitors WHERE tag IN ('kener', 'earth') AND category_name = 'Home';

-- Append any static monitor missing from the home page, after everything already there.
-- The worker's reconcile keeps this block (in relative order) after its dynamic addon categories.
WITH home AS (
  SELECT id FROM pages WHERE page_path = ''
), maxpos AS (
  SELECT COALESCE(MAX(position), -1) AS p FROM pages_monitors WHERE page_id = (SELECT id FROM home)
)
INSERT INTO pages_monitors (page_id, monitor_tag, position)
SELECT home.id, t.tag, maxpos.p + t.ord
FROM home, maxpos, (VALUES
  ('stremio-api', 1),
  ('cinemeta', 2),
  ('stremio-web-player', 3),
  ('stremio-website', 4),
  ('real-debrid-api', 5),
  ('alldebrid-api', 6),
  ('premiumize-api', 7),
  ('torbox-api', 8),
  ('stremio-addons-net', 9)
) AS t(tag, ord)
ON CONFLICT (page_id, monitor_tag) DO NOTHING;
