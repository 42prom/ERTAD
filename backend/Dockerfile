FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY admin/package.json admin/package.json
RUN npm ci --workspace @ertad/backend --include-workspace-root --ignore-scripts
COPY backend backend
RUN npm run build --workspace @ertad/backend && npm prune --omit=dev --workspace @ertad/backend --include-workspace-root --ignore-scripts

FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS runtime
ENV NODE_ENV=development
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/backend/dist ./backend/dist
COPY --from=build --chown=node:node /app/backend/db ./backend/db
COPY --from=build --chown=node:node /app/backend/package.json ./backend/package.json
USER node
EXPOSE 3000
CMD ["node", "backend/dist/index.js"]
