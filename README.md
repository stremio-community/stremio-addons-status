# Stremio Addons Status

A status page for Stremio addons that checks whether an addon **actually works**, not just whether it's online.

Most status checkers only ping the addon's `/manifest.json`. That hides the failure users actually run into: the addon responds, but returns **no streams**. This project probes each addon the same way Stremio does: it picks a real title, then asks the addon for streams, catalogs, or metadata and reports a real verdict.

It tracks **every approved addon** on [stremio-addons.net](https://stremio-addons.net) and tailors the check to each one: stream addons get the full stream check, while catalog or metadata-only addons are validated against what they advertise.

## How it works

We use [our fork of Gatus](https://github.com/Stremio-Community/gatus) for the uptime dashboard plus a small custom-built worker service. The fork is stock [Gatus](https://github.com/TwiN/gatus) with a few patches to its external-endpoint push API (stable endpoint keys and per-probe results) that aren't upstream yet. The worker fetches the addon list, probes each addon, and reports each verdict to Gatus.

Requests go through a Cloudflare WARP proxy first, falling back to a direct connection when WARP is blocked so an addon is only DOWN when it's unreachable from _both_ routes, not because it happens to block one IP or the other.
The requests that decide the verdict also go direct when WARP answers with nothing usable in them (a soft block), and get one more try after a short pause when neither route answered; a rate limit's short `Retry-After` is waited out before trying again.

In a nutshell:

```
stremio-addons.net API ──► worker ──► Gatus (status page + Discord notifications)
```

## Self-hosting

The whole stack runs with Docker Compose: Postgres, the Gatus fork, the worker (built from this repo) and a Cloudflare WARP proxy.

Requirements: Docker with the Compose plugin, and a host that allows the `NET_ADMIN` capability for the WARP container (see [Without WARP](#without-warp) if it doesn't).

```sh
git clone https://github.com/Stremio-Community/stremio-addons-status.git
cd stremio-addons-status
cp .env.example .env
```

Edit `.env` and replace at least `POSTGRES_PASSWORD` and `PUSH_TOKEN` with random values, e.g. from `openssl rand -hex 32`.
Then start everything:

```sh
docker compose up -d
```

The status page is at http://localhost:8080.
The worker fetches the addon list on start, so addons appear after its first probe cycle; follow it with `docker compose logs -f worker`.

### Configuration

All settings live in `.env`; `.env.example` documents each one.

| Variable                                            | Default                             | Purpose                                                                                               |
| --------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GATUS_PORT`                                        | `8080`                              | Host port of the status page. Set `127.0.0.1:8080` to keep it off the network behind a reverse proxy. |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` |                                     | Credentials of the bundled Postgres, which holds the uptime history.                                  |
| `POSTGRES_PORT`                                     | `5432`                              | Host port of Postgres, bound to localhost only.                                                       |
| `POSTGRES_HOST`, `POSTGRES_SSLMODE`                 | `postgres`, `disable`               | Where Gatus reaches Postgres.                                                                         |
| `PUSH_TOKEN`                                        |                                     | Shared secret the worker uses to push verdicts to Gatus.                                              |
| `API_BASE`                                          | `https://stremio-addons.net/api/v0` | The addon list to track.                                                                              |
| `PROXY_URL`                                         | `socks5://warp:1080`                | Proxy the worker tries first. Empty probes directly.                                                  |
| `PROBE_INTERVAL`                                    | `5m`                                | Time between probe cycles, aligned to whole multiples in UTC.                                         |
| `LIST_REFRESH`                                      | `1h`                                | How often the addon list is refetched.                                                                |
| `CONCURRENCY`                                       | `8`                                 | Addons probed in parallel.                                                                            |
| `DISCORD_WEBHOOK_URL`                               |                                     | Channel webhook for down and recovery alerts. Empty disables alerts.                                  |

After changing `.env`, apply it with `docker compose up -d`.

### Customizing the page

Gatus loads every `*.yaml` file in `gatus/config.d`:

- `00-base.yaml` holds the page title, header buttons, the Discord alert settings and the static checks of Stremio, debrid and other services.
  Edit it to change the branding, and set `alerting.discord.status-page-url` to your own URL so alerts link to your page.
- `10-endpoints.yaml` is generated by the worker; don't edit it.
- To add checks of your own, put them in a new file such as `20-local.yaml` so updates don't conflict with them.
  Gatus appends the `endpoints` lists of all files, but refuses to start when two files set the same single value, such as `ui.title`, so change those in `00-base.yaml` instead.

Gatus reloads its configuration when a file changes; see the [Gatus documentation](https://github.com/TwiN/gatus#configuration) for every option.

### Running it permanently

`compose.yaml` is set up for development: no container restarts on its own.
For a long-running install, add a `compose.override.yaml` next to it, which Compose picks up automatically and git ignores:

```yaml
services:
  warp:
    restart: unless-stopped
  postgres:
    restart: unless-stopped
  gatus:
    restart: unless-stopped
  worker:
    restart: unless-stopped
```

To serve the page on a domain, set `GATUS_PORT=127.0.0.1:8080` and point a reverse proxy such as Caddy or nginx at that port.
That port is the only one to expose: Gatus's push API on it requires `PUSH_TOKEN`, and Postgres and the WARP proxy listen on localhost only.

### Without WARP

The WARP proxy lets the worker tell an addon that blocks one IP apart from one that is down.
To run without it, set `PROXY_URL=` in `.env` and start every service except `warp`:

```sh
docker compose up -d postgres gatus worker
```

The worker then has a single route, so an addon that blocks your server's IP shows as DOWN.

### Data and backups

- **History** lives in the `postgres-data` volume. Back it up with `docker compose exec -T postgres pg_dump -U gatus gatus > backup.sql` (substitute your `POSTGRES_USER` and `POSTGRES_DB`).
- **`gatus/config.d`** must survive restarts along with the database: Gatus deletes the history of every endpoint missing from the configuration it starts with, so starting without `10-endpoints.yaml` wipes every addon's history.

### Updating

```sh
git pull
docker compose up -d --build
```

### Badges

Each endpoint serves an uptime badge at `/api/v1/endpoints/{key}/uptimes/7d/badge.svg`, where `{key}` is the key shown in the endpoint's URL on the status page.

## Development

Requirements: Node.js (version in `.nvmrc`), pnpm and Docker.

```sh
pnpm install
cp .env.example .env
cp worker/.env.example worker/.env.dev
pnpm start:dev
```

`pnpm start:dev` starts Postgres, Gatus and the WARP proxy in Docker, then runs the worker on your host with hot reload. `worker/.env.dev` only overrides what differs when the worker runs outside Docker. See `package.json` for the exact commands.

### Running a local Gatus fork

To test changes to the [Gatus fork](https://github.com/Stremio-Community/gatus), check it out next to this repo and add a git-ignored `compose.override.yaml`:

```yaml
services:
  gatus:
    image: gatus:dev
    build:
      context: ../gatus
```

`pnpm start:dev` won't rebuild the image when the fork changes. Rebuild it yourself:

```sh
docker compose up -d --build gatus
```

## Production deployment

https://status.stremio-addons.net runs on the [k8s-self-managed](https://github.com/sleeyax/k8s-self-managed) Kubernetes cluster, from the `deploy` folder: one pod with Gatus and the worker side by side, the worker reaching Gatus on localhost.

- **Releasing**: merging to `main` is releasing. CI builds the worker image to `ghcr.io/stremio-community/stremio-addons-status`, then Flux commits its tag to `deploy/kustomization.yaml` on `main` and rolls it out. Pull before you push, since Flux's commits land in between, and never write `[skip ci]` in a commit message of your own: GitHub skips the build of a push whose last commit holds it.
- **Gatus**: the fork's image is pinned by hand in `deploy/kustomization.yaml`, at the same tag as `compose.yaml`; upgrade both together.
- **Configuration**: the cluster mounts `gatus/config.d/00-base.yaml` from a ConfigMap generated from that same file, so a change to it rolls the pod. The worker writes its endpoints next to it on a PVC, which keeps them across restarts as the host directory does in Compose.
- **Storage**: history lives in the `stremio_addons_status` database on the cluster's shared Postgres, reached over TLS.
- **WARP**: the worker and Gatus's static checks go through the cluster's shared WARP proxy, `socks5://warp.warp.svc.cluster.local:1080`.
- **Secrets**: `deploy/secret.sops.yaml` holds `PUSH_TOKEN`, `DISCORD_WEBHOOK_URL` and the Postgres settings, encrypted to the cluster's key with [sops](https://github.com/getsops/sops) per `.sops.yaml`. Edit it with `sops deploy/secret.sops.yaml` from the repo root; without the cluster key you can add or replace a value, but not read the others.

To render the deploy folder the way Flux does, which reads the base configuration from outside it:

```sh
kubectl kustomize --load-restrictor LoadRestrictionsNone deploy
```
