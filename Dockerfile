# One image: build the web app, then run the Node server, which serves it plus /api and /ws.
FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/rules/package.json packages/rules/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm --filter @kraterra/web build

FROM base AS prod
RUN pnpm install --frozen-lockfile --prod --filter @kraterra/server...
COPY packages/rules/src packages/rules/src
COPY apps/server/src apps/server/src
COPY --from=build /app/apps/web/dist /app/web
ENV NODE_ENV=production PORT=8080 WEB_DIST=/app/web DATA_DIR=/tmp/data
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
USER node
EXPOSE 8080
WORKDIR /app/apps/server
CMD ["node_modules/.bin/tsx", "src/main.ts"]
