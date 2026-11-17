# One container: the Hono API also serves the built frontend from dist/.
# The SQLite database and generated media live on a Fly volume mounted at /data.
FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# ffmpeg-static downloads its Linux binary here (used for extend and scene export).
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production \
    API_PORT=8080 \
    DATA_DIR=/data
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
