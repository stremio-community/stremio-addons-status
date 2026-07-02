FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
# Workspace manifests first, for layer caching. pnpm version comes from the root "packageManager" field.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY worker/package.json worker/
RUN pnpm install --frozen-lockfile
COPY worker ./worker
RUN pnpm -F worker build

FROM node:24-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY worker/package.json worker/
RUN pnpm install --frozen-lockfile --prod --filter worker
COPY --from=build /repo/worker/dist ./worker/dist
CMD ["node", "worker/dist/index.js"]
