# Stremio Addons Status

A status page for Stremio addons that checks whether an addon **actually works**, not just whether it's online.

Most status checkers only ping the addon's `/manifest.json`. That hides the failure users actually run into: the addon responds, but returns **no streams**. This project probes each addon the same way Stremio does: it picks a real title, then asks the addon for streams, catalogs, or metadata and reports a real verdict.

It tracks **every approved addon** on [stremio-addons.net](https://stremio-addons.net) and tailors the check to each one: stream addons get the full stream check, while catalog or metadata-only addons are validated against what they advertise.

## How it works

We use [our fork of Gatus](https://github.com/Stremio-Community/gatus) for the uptime dashboard plus a small custom-built worker service. The fork is stock [Gatus](https://github.com/TwiN/gatus) with a few patches to its external-endpoint push API (stable endpoint keys and per-probe results) that aren't upstream yet. The worker fetches the addon list, probes each addon, and reports each verdict to Gatus.

Requests go through a Cloudflare WARP proxy first, falling back to a direct connection when WARP is blocked so an addon is only DOWN when it's unreachable from _both_ routes, not because it happens to block one IP or the other.

In a nutshell:

```
stremio-addons.net API ──► worker ──► Gatus (status page + Discord notifications)
```

## Quick start

```sh
cp .env.example .env
docker compose up -d
```

- **Status page**: http://localhost:8080. Addons are grouped by category; open one to see its uptime history.
- **Badge**: `.../api/v1/endpoints/{key}/uptimes/7d/badge.svg`

Point `DISCORD_WEBHOOK_URL` at a channel in your Discord server to receive down and recovery alerts. `POSTGRES_HOST` and `POSTGRES_SSLMODE` tell Gatus where its Postgres runs; they default to the Compose container without TLS. See `.env.example` for the full configuration details.

## Deployment

https://status.stremio-addons.net runs on the [k8s-self-managed](https://github.com/sleeyax/k8s-self-managed) Kubernetes cluster, from the `deploy` folder: one pod with Gatus and the worker side by side, the worker reaching Gatus on localhost.

- **Releasing**: merging to `main` is releasing. CI builds the worker image to `ghcr.io/stremio-community/stremio-addons-status`, then Flux commits its tag to `deploy/kustomization.yaml` on `main` and rolls it out. Pull before you push, since Flux's commits land in between, and never write `[skip ci]` in a commit message of your own: GitHub skips the build of a push whose last commit holds it.
- **Gatus**: the fork's image is pinned by hand in `deploy/kustomization.yaml`, at the same tag as `compose.yaml`; upgrade both together.
- **Configuration**: the cluster mounts `gatus/config.d/00-base.yaml` from a ConfigMap generated from that same file, so a change to it rolls the pod. The worker writes its endpoints next to it on every start, as in Compose.
- **Storage**: history lives in the `stremio_addons_status` database on the cluster's shared Postgres, reached over TLS.
- **WARP**: the worker and Gatus's static checks go through the cluster's shared WARP proxy, `socks5://warp.warp.svc.cluster.local:1080`.
- **Secrets**: `deploy/secret.sops.yaml` holds `PUSH_TOKEN`, `DISCORD_WEBHOOK_URL` and the Postgres settings, encrypted to the cluster's key with [sops](https://github.com/getsops/sops) per `.sops.yaml`. Edit it with `sops deploy/secret.sops.yaml` from the repo root; without the cluster key you can add or replace a value, but not read the others.

To render the deploy folder the way Flux does, which reads the base configuration from outside it:

```sh
kubectl kustomize --load-restrictor LoadRestrictionsNone deploy
```

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
