# The image Glama builds to decide whether this server is distributable.
#
# Glama ingests the official MCP registry, then builds every server in a Firecracker microVM. A
# server it cannot build keeps its profile page but is withheld from search, category listings
# and recommendations — so no Dockerfile means the listing exists and nobody can find it.
#
# This builds from source rather than installing the published package, so the image reflects
# the commit it was built from. The two stages mirror what scripts/dev/verify-pack.mjs does,
# which is the path already proven to produce a server that completes an MCP handshake.

# ── build ─────────────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /src

# corepack pins pnpm from the packageManager field, so the build uses the version the repo
# declares rather than whatever is newest.
RUN corepack enable

# Dependency manifests first: these layers survive a source-only change.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
# mkdir first: `npm pack --pack-destination` does not create the directory, it fails with ENOENT
# on the tarball it is about to write. This Dockerfile shipped without ever being built, so the
# build broke here on its first real run — Glama could not build it, fell back to inferring a
# spec of its own, and that spec ran `clawops` with no subcommand: the CLI printed its help and
# exited 1, and the listing was withheld. See scripts/dev/verify-docker.mjs.
RUN mkdir -p /out && pnpm build && npm pack --pack-destination /out

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:22-slim
# Install the tarball a user would install, not the working tree. `files` in package.json is
# ["dist","spec"], so this also proves nothing needed at runtime was left out of the package.
# Two packages the slim image leaves out and clawops cannot work without:
#
#   openssh-client — `clawops init` generates its ed25519 key with ssh-keygen, not with node's
#     crypto, which writes a PKCS#8 PEM that ssh2 and OpenSSH both refuse.
#   ca-certificates — there is no CA bundle in node:*-slim, so every HTTPS call from inside the
#     container fails to verify. That is the Pulumi CLI download on first use and every cloud
#     API call after it: the container could reach nothing, credentials or not.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/*.tgz /tmp/
RUN npm install -g /tmp/*.tgz && rm -f /tmp/*.tgz

# Not root. clawops reads SSH keys and cloud credential files by design, and a server that runs
# as root in a sandbox someone else operates is a worse neighbour than it needs to be.
RUN useradd --create-home --shell /usr/sbin/nologin clawops
USER clawops
ENV HOME=/home/clawops

# stdio transport, matching the `packages[].transport` declared in server.json. No credentials
# are needed to start: the server answers a handshake and advertises its tools, and only a tool
# call that touches a cloud needs anything more.
ENTRYPOINT ["clawops", "mcp", "serve"]
