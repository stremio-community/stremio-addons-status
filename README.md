# Stremio Addons Status

A status page for Stremio addons that checks whether an addon **actually works**, not just whether it's online.

Most status checkers only ping the addon's `/manifest.json`. That hides the failure users actually run into: the addon responds, but returns **no streams**. This project probes each addon the same way Stremio does: it picks a real title, then asks the addon for streams, catalogs, or metadata and reports a real verdict.

It tracks **every approved addon** on [stremio-addons.net](https://stremio-addons.net) and tailors the check to each one: stream addons get the full stream check, while catalog or metadata-only addons are validated against what they advertise.

## How it works

We use [our fork of Gatus](https://github.com/Stremio-Community/gatus) for the uptime dashboard plus a small custom-built worker service. The fork is stock [Gatus](https://github.com/TwiN/gatus) with a few patches to its external-endpoint push API (stable endpoint keys and per-probe results) that aren't upstream yet. The worker fetches the addon list, probes each addon, and reports each verdict to Gatus. Grafana reads Gatus's database for analytics.

Requests go through a Cloudflare WARP proxy first, falling back to a direct connection when WARP is blocked so an addon is only DOWN when it's unreachable from _both_ routes, not because it happens to block one IP or the other.

In a nutshell:

```
stremio-addons.net API ──► worker ──► Gatus (status page + Discord notifications) ──► Postgres ──► Grafana
```

## Quick start

```sh
cp .env.example .env
docker compose up -d
```

- **Status page**: http://localhost:8080. Addons are grouped by category; open one to see its uptime history.
- **Badge**: `.../api/v1/endpoints/{key}/uptimes/7d/badge.svg`
- **Grafana**: http://localhost:3000. A read-only dashboard with uptime, per-category health, and response-time trends.

Point `DISCORD_WEBHOOK_URL` at a channel in your Discord server to receive down and recovery alerts. See `.env.example` for the full configuration details.

## Development

Requirements: Node.js (version in `.nvmrc`), pnpm and Docker.

```sh
pnpm install
cp .env.example .env
cp worker/.env.example worker/.env.dev
pnpm start:dev
```

`pnpm start:dev` starts Postgres, Gatus, Grafana and the WARP proxy in Docker, then runs the worker on your host with hot reload. `worker/.env.dev` only overrides what differs when the worker runs outside Docker. See `package.json` for the exact commands.
