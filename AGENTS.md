This file provides guidance to agents when working with code in this repository.

A status page for Stremio addons that checks whether an addon **actually works** (returns real streams/catalogs/meta), not just whether `/manifest.json` responds.
The TypeScript `worker/` probes addons and pushes verdicts to Gatus, which renders the page and sends Discord alerts.

## Gatus fork

We run our fork `Stremio-Community/gatus`, not upstream.
The worker relies on fork-only patches to external endpoints that upstream docs won't mention; the fork's README documents them.
Read the fork's source to check Gatus behaviour: it's usually checked out at `../gatus`; if not, search the local filesystem for it before falling back to GitHub.
The running Gatus only reflects `../gatus` edits when built from it via `compose.override.yaml` and rebuilt with `docker compose up -d --build gatus` (see README).

## Cross-repo contracts

- Endpoint keys are the addon `uuid`. Gatus stores history in Postgres under that key, so changing the key source orphans all history: a one-time cutover, not a refactor.
- `stremio-addons-hub` (`uptime.ts`) queries Gatus by that uuid for uptime stats, so treat the key as an API.
  In production it does so through the Service `stremio-addons-status` on port 80 (`deploy/service.yaml`), so keep that name and port.
- Condition strings from `buildConditions` show in the status page tooltip and in Discord alerts, so keep them terse; the request-level detail belongs in their detail rows, which the fork's details dialog renders.
  Discord alerts also show the rows whose label is in `detail-labels` (`gatus/config.d/00-base.yaml`), so renaming one of those labels in `probe.ts` silently drops it from alerts.
- Everything pushed to Gatus is public, and a configured addon's base URL can carry its config or API key: never push it, only paths relative to it (`buildConditions` strips it as a backstop).
  The manifest logo, pushed for the Discord alert thumbnail, is dropped whenever it holds any segment of the base URL's path (`logoOf`).
  Subtitle file URLs can carry the same config, so detail rows name only their host.
- `worker/src/overrides.ts` holds curated per-addon probe settings keyed by uuid: needs-config pins, fixed test IDs and secret-free test configs.
  The file is public like everything else in the repo, so it holds no secret, user config or configured base URL; a test config is only requested, never pushed (`buildConditions` strips the probed base URL too).
- Group order is encoded as leading spaces on group names (`GROUP_ORDER` in `gatus.ts`); the static groups in `gatus/config.d/00-base.yaml` hardcode matching counts.
  Gatus stores an endpoint's group only when it first sees the key, so changing a count also needs a one-time `UPDATE endpoints SET endpoint_group = ...` in Postgres, or existing endpoints keep the old prefix and new ones split into a duplicate group.

## Verdict invariants

The point of the worker is to avoid false DOWNs. Preserve these when editing `probe.ts` / `http.ts`:

- Only the primary resource (`stream` > `catalog` > `meta` > `addon_catalog` > `subtitles`) decides UP/DOWN; secondary resources only annotate.
- An addon is unreachable only when both the WARP proxy and the direct route fail.
- A missing test ID (e.g. an external ID-source outage) degrades to liveness-only or an annotation, never to DOWN.
  The exception is an addon whose own catalogs are its only ID source (no external source covers its stream prefixes): when every catalog tried fails or is empty, it is DOWN on its catalogs, since that is what its users browse.
  When they list titles that all play under IDs outside its stream scope (handed to the user's other addons), it is judged on those catalogs too.
- A placeholder (a configure plea, a notice, a stream identical for unrelated titles) never counts as content; an addon answering only pleas to configure is needs-config, not DOWN.
- A stream URL fails its target only when it is dead on every route (missing host, refused, 404/410, a page saying the file is gone, an expired signed link, a text body where media is expected); URLs that all open web pages make the target a link, as for an informational addon; geo blocks (also when a CDN header such as Kaltura's says so), WAF and captcha pages, rate limits, 5xx and timeouts are unverifiable and never count (`urlcheck.ts`).
  Only an addon that answers a nonexistent ID with stream URLs (the negative control) needs a checked URL to play.
- The worker never requests debrid services or a configured addon's resolve and playback routes, which add torrents to its user's account (`isProtectedUrl`).
- A subtitles-only addon answering no subtitles for every title tried stays UP with a `0 found` annotation, since niche providers lack most titles; it is DOWN only when it has none for the titles its override's `testIds` name (`subtitles.ts`).
  A listed file that isn't a subtitle in its language, or that the addon's own host fails to serve on every route, fails its title; a third-party file host that fails doesn't.
  A file translated or generated on request (its entry or the addon says so, or the override's `translatesSubtitles`) is never fetched unless it says it is ready, since that can start paid work on the operator's or the lister's key; skipping it never makes the addon DOWN.
- A configurable addon is needs-config, not DOWN, when its manifest declares required configuration or its primary content routes are missing without a config (`unconfigured.ts`); an empty answer alone never makes it needs-config, and an override's `needsConfig` pin wins over any content verdict.
  A required setting without the `configurationRequired` flag still lets Stremio install the addon unconfigured, so when its own catalogs are its only ID source and all fail or are empty, it is DOWN on its catalogs like any other addon.

## Production

- Runs on the `sleeyax/k8s-self-managed` cluster from `deploy/`, which Flux applies on every push to `main`; the cluster repo registers the app, its namespace and its Postgres role and database.
- One `replicas: 1` pod runs Gatus and the worker; never add a replica, which would double every probe and Discord alert.
- Flux owns the worker's tag line in `deploy/kustomization.yaml` (the `$imagepolicy` marker): it commits each new image's tag to `main`. Never write `[skip ci]` in a commit message of your own.
- The cluster's ConfigMap is generated from `gatus/config.d/00-base.yaml`, outside `deploy/`. Render with `kubectl kustomize --load-restrictor LoadRestrictionsNone deploy`, which matches Flux.
- Secrets live only in `deploy/secret.sops.yaml`, encrypted to the cluster key per `.sops.yaml`; never commit a plaintext secret or a real Discord webhook.
- Containers run as UID 1000 with a read-only root filesystem: anything that writes files needs a volume, like the shared `/config` emptyDir.

## Conventions

- Conventional commits without scopes: `feat: ...`, not `feat(worker): ...`.
- Log through pino (`logger.ts`).
- `gatus/config.d/00-base.yaml` is shared by Compose and production, so environment-specific values such as the Postgres host and SSL mode (`POSTGRES_HOST`, `POSTGRES_SSLMODE`) come from Gatus's environment, never hardcoded.
- stremio-addons.net API docs: https://docs.stremio-addons.net/developers/api
- When a change alters anything above, update this file in the same change.
