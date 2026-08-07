# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: dependencies
# ---------------------------------------------------------------------------
# Split from the build so the (slow) native compilation of bcrypt is cached
# and only re-runs when package files actually change. Copying package.json
# before the source is the whole trick: source edits then reuse this layer.
FROM node:22-alpine AS deps

WORKDIR /app

# bcrypt has no prebuilt binary for musl, so it compiles from source here.
# These toolchain packages exist only in this stage and never reach the runtime
# image, which is the main reason for a multi-stage build.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# dumb-init is PID 1. Node does not reap zombies or forward signals the way an
# init process does, so without this SIGTERM can be swallowed and Kubernetes
# waits out the full termination grace period before SIGKILL on every rollout.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production \
    PORT=4000

WORKDIR /app

# node:alpine already ships an unprivileged `node` user (uid 1000). Reusing it
# is simpler than creating one, and running as root in a container is the
# single most common finding in an image scan.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node server.js ./
COPY --chown=node:node src ./src
# Needed by the expiry-sweep CronJob, which runs this same image with a
# different command.
COPY --chown=node:node scripts ./scripts

USER node

EXPOSE 4000

# The orchestrator owns health checking in Kubernetes (see deploy/k8s), but a
# HEALTHCHECK keeps `docker compose ps` and plain `docker run` honest too.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
