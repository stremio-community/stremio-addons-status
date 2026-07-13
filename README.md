# Stremio Addons Status

A status page for Stremio addons that checks whether an addon **actually works**, not just whether it's online.

Most status checkers only ping the addon's `/manifest.json`. That hides the failure users actually run into: the addon responds, but returns **no streams**. This project probes each addon the same way Stremio does: it picks a real title, then asks the addon for streams, catalogs, or metadata and reports a real verdict.

It tracks **every approved addon** on [stremio-addons.net](https://stremio-addons.net) and tailors the check to each one: stream addons get the full stream check, while catalog or metadata-only addons are validated against what they advertise.

## How it works

We use [Kener](https://github.com/rajnandan1/kener) for the status page plus a small custom-built worker service. The worker fetches the addon list, keeps a Kener monitor per addon (keyed by the addon's stable slug), probes each addon, and pushes each verdict through Kener's API. Grafana reads Kener's database for analytics.

Requests go through a Cloudflare WARP proxy first, falling back to a direct connection when WARP is blocked so an addon is only DOWN when it's unreachable from _both_ routes, not because it happens to block one IP or the other.

In a nutshell:

```
stremio-addons.net API ──► worker ──► Kener (status page + alerts) ──► Postgres ──► Grafana
```

## Quick start

```sh
cp .env.example .env   # then fill in the secrets (see the comments in the file)
docker compose up -d
```

The `kener-seed` service runs on every startup and handles Kener's setup automatically: it creates the manage-UI admin (`KENER_ADMIN_EMAIL`/`KENER_ADMIN_PASSWORD`), registers `KENER_API_TOKEN` as the worker's API key, and seeds the static platform/debrid/infrastructure monitors (see `scripts/seed-kener.sql`) — the setup wizard never needs to be clicked through.

The only manual step left is cosmetic: configure site branding and alerting (Triggers, e.g. a Discord webhook) in the manage UI at http://localhost:3002/manage.

- **Status page**: http://localhost:3002. Addons first, then addon instances and the static platform checks; open a monitor to see its uptime history.
- **Badges**: `.../badge/{tag}/status` and `.../badge/{tag}/uptime`
- **Grafana**: http://localhost:3000. A read-only dashboard with uptime, per-category health, and response-time trends.

## Development

This is a pnpm workspace. Install once from the repo root, then use the worker's scripts with `-F worker`.

Docker Compose is the production setup. For local development, run the infrastructure in Docker but the worker on the host with hot reload:

```sh
pnpm install
cp worker/.env.example worker/.env.dev             # host-run overrides
pnpm start:dev                                     # brings up the Docker infra (incl. kener-seed), then runs the worker on the host
```

`start:dev` loads the repo-root `.env` first, then `worker/.env.dev` on top. The dev file only overrides what differs when the worker runs on the host instead of inside compose (Kener URL, proxy); see `worker/.env.example` for details.
