# Stremio Addons Status

A status page for Stremio addons that checks whether an addon **actually works**, not just whether it's online.

Most status checkers only ping the addon's `/manifest.json`. That hides the failure users actually run into: the addon responds, but returns **no streams**. This project probes each addon the same way Stremio does: it picks a real title, then asks the addon for streams, catalogs, or metadata and reports a real verdict.

It tracks **every approved addon** on [stremio-addons.net](https://stremio-addons.net) and tailors the check to each one: stream addons get the full stream check, while catalog or metadata-only addons are validated against what they advertise.

## How it works

We use stock [Kuvasz](https://github.com/kuvasz-uptime/kuvasz) for the uptime dashboard plus a small custom-built worker service. The worker fetches the addon list, manages one Kuvasz push monitor per addon through the REST API, probes each addon, and pushes each verdict as a heartbeat (UP) or an explicit failure (DOWN). Grafana reads Kuvasz's database for analytics.

Requests go through a Cloudflare WARP proxy first, falling back to a direct connection when WARP is blocked so an addon is only DOWN when it's unreachable from _both_ routes, not because it happens to block one IP or the other.

In a nutshell:

```
stremio-addons.net API ──► worker ──► Kuvasz (status page + Discord notifications) ──► Postgres ──► Grafana
```

## Quick start

```sh
cp .env.example .env
docker compose up -d
```

- **Status page**: http://localhost:8080/status (public). The admin UI at http://localhost:8080 and the REST API stay behind the credentials from `.env`.
- **Badge**: `.../badge/{monitorId}/uptime/30d`
- **Grafana**: http://localhost:3000. A read-only dashboard with fleet uptime, current outages, and static-check response times.

Point `DISCORD_WEBHOOK_URL` at a channel in your Discord server to receive down and recovery alerts. See `.env.example` for the full configuration details.

## Development

This is a pnpm workspace. Install once from the repo root, then use the worker's scripts with `-F worker`.

Docker Compose is the production setup. For local development, run the infrastructure in Docker but the worker on the host with hot reload:

```sh
pnpm install
cp worker/.env.example worker/.env.dev             # host-run overrides
pnpm -F worker start:dev                           # worker on the host, watches src/
```

`start:dev` loads the repo-root `.env` first, then `worker/.env.dev` on top. The dev file only overrides what differs when the worker runs on the host instead of inside compose (Kuvasz URL, proxy); see `worker/.env.example` for details.
