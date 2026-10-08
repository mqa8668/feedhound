FROM oven/bun:1.4.2 AS base
WORKDIR /repo

# Every workspace in package.json/bun.lock must be on disk for --frozen-lockfile,
# so copy all of apps/ and packages/ (see .dockerignore for exclusions).
COPY package.json bunfig.toml bun.lock tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN bun install --frozen-lockfile
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

WORKDIR /repo/apps/agent
EXPOSE 4821
CMD ["bun", "src/index.ts"]
