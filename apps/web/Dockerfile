FROM oven/bun:1.4.2 AS build
WORKDIR /repo

# Every workspace in package.json/bun.lock must be on disk for --frozen-lockfile,
# so copy all of apps/ and packages/ (see .dockerignore for exclusions).
COPY package.json bunfig.toml bun.lock tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN bun install --frozen-lockfile
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

WORKDIR /repo/apps/web
RUN bun run build

# Runtime: static dist + a small Bun server that also proxies /api and /ws to the api.
FROM oven/bun:1.4.2 AS runtime
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION \
    NODE_ENV=production \
    API_URL=http://api:4820 \
    WEB_DIST=/app/dist
WORKDIR /app
COPY --from=build /repo/apps/web/dist ./dist
COPY apps/web/scripts/serve.ts ./serve.ts
EXPOSE 4823
CMD ["bun", "serve.ts"]
