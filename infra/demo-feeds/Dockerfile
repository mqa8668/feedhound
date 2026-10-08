# Build context is infra/demo-feeds (the repo-level .dockerignore does not apply here).
FROM oven/bun:1.4.2
WORKDIR /app
COPY server.ts ./
EXPOSE 8080
CMD ["bun", "server.ts"]
