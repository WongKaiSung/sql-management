# DualSQL / SQLConnect — container image
# Node/Express app serving the API and the static UI in public/.

FROM node:22-alpine

# tini gives us proper PID 1 signal handling so SIGINT/SIGTERM reach the app
# (server.js closes the MSSQL/PG pools gracefully on those signals).
RUN apk add --no-cache tini

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source. public/index.html is THE UI — .dockerignore excludes the stale
# index_FIXED.html / *.bak copies so they can never sneak into the image.
COPY server.js ./
COPY public ./public

# Build stamp — passed in by deploy/build-image.ps1. After deploying, open
# http://<server>:3000/build.txt to confirm which build is actually running.
ARG BUILD_STAMP=dev
RUN echo "$BUILD_STAMP" > public/build.txt

# Inside the container, listen on all interfaces so the published port is reachable.
ENV HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production

# Audit logs are written to ./logs — declare it so it can be mounted as a volume.
RUN mkdir -p logs
VOLUME ["/app/logs"]

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
