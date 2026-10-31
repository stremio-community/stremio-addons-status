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
- Condition strings from `buildConditions` show in the status page tooltip and in Discord alerts, so keep them terse; the request-level detail belongs in their detail rows, which only the fork's details dialog renders.
- Everything pushed to Gatus is public, and a configured addon's base URL can carry its config or API key: never push it, only paths relative to it (`buildConditions` strips it as a backstop).
- Group order is encoded as leading spaces on group names (`GROUP_ORDER` in `gatus.ts`); the static groups in `gatus/config.d/00-base.yaml` hardcode matching counts.

## Verdict invariants

The point of the worker is to avoid false DOWNs. Preserve these when editing `probe.ts` / `http.ts`:

- Only the primary resource (`stream` > `catalog` > `meta`) decides UP/DOWN; secondary resources only annotate.
- An addon is unreachable only when both the WARP proxy and the direct route fail.
- A missing test ID (e.g. an external ID-source outage) degrades to liveness-only or an annotation, never to DOWN.

## Conventions

- Conventional commits without scopes: `feat: ...`, not `feat(worker): ...`.
- Log through pino (`logger.ts`).
- stremio-addons.net API docs: https://docs.stremio-addons.net/developers/api
- When a change alters anything above, update this file in the same change.
