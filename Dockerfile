# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
# `npm run build` is tsc AND scripts/copy-assets.mjs, which copies the .sql
# files into dist/. Forgetting this directory is not a build warning — it is
# MODULE_NOT_FOUND, and before the copy script existed it was worse: the image
# built cleanly and shipped with zero module migrations. Covered by a test that
# reads this file against the build script.
COPY scripts ./scripts
RUN npm run build

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Fonts for rank cards (M14).
#
# @napi-rs/canvas discovers the system's fonts at import and draws with whatever
# it finds. An Alpine image ships with NONE, so without this the renderer has no
# family to use, reports so, and every /rank silently falls back to the embed —
# a feature that appears broken rather than absent.
#
# DejaVu covers Latin/Cyrillic/Greek; Noto CJK covers Chinese, Japanese and
# Korean; the emoji font covers what Discord display names are full of. Together
# they are ~40MB, which is the honest price of rendering arbitrary usernames.
RUN apk add --no-cache font-dejavu font-noto font-noto-cjk font-noto-emoji

# The migrations are read from disk at boot, not compiled into the bundle.
COPY migrations ./migrations
COPY --from=build /app/dist ./dist

# Never run as root.
RUN addgroup -S bot && adduser -S bot -G bot
USER bot

CMD ["node", "dist/main.js"]
