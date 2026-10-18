# Casino Arena: the built web app and the Party server in one container.
#
# NOT built or run in the environment this file was written in (no Docker daemon was available there).
# The same one-process setup was verified without Docker; see docs/HOSTING.md. Build it once yourself
# before relying on it:   docker build -t casino-arena .

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
# The party server runs through vite-node (it imports the same TypeScript the app does), so the
# dev dependencies stay in the image.
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY tsconfig.json tsconfig.arena.json vite.config.ts ./
COPY src ./src
COPY scripts/party-server.ts ./scripts/party-server.ts

# Saved party state holds every live player's cards: keep it on a private volume, never in the image.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    STATIC_DIR=dist \
    PARTY_FILE=/data/party-state.json
# Set TRUST_PROXY=1 only when exactly one reverse proxy (your host's) sits in front.

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8787/api/party/health || exit 1
CMD ["npx", "vite-node", "scripts/party-server.ts"]
