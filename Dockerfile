# ============================================================
# codeparse-mcp Docker Image
# Multi-stage build: deps → production
# Compatible with GitHub Copilot MCP and Claude Desktop
# ============================================================

FROM node:22-alpine AS deps

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --omit=dev

# ── Production image ──────────────────────────────────────────────────────────

FROM node:22-alpine AS production

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S codeparse && \
    adduser -S -u 1001 -G codeparse codeparse

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source
COPY src/ ./src/
COPY package.json ./

# Create default directories
RUN mkdir -p /data /project && \
    chown -R codeparse:codeparse /app /data /project

USER codeparse

# ── Environment ───────────────────────────────────────────────────────────────

ENV NODE_ENV=production
ENV CODEPARSE_DB_PATH=/data/graph.db
ENV CODEPARSE_PROJECT_ROOT=/project

# Volume for persistent graph data
VOLUME ["/data", "/project"]

# ── Entrypoint ────────────────────────────────────────────────────────────────

# Default: start MCP server on stdio (for MCP clients)
# Override CMD for CLI usage:
#   docker run ... codeparse init
#   docker run ... codeparse sync

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["serve"]

LABEL org.opencontainers.image.title="codeparse-mcp" \
      org.opencontainers.image.description="Java/Xtend code parser → Graph DB → MCP for ISO 26262 ASIL-D UT" \
      org.opencontainers.image.version="1.0.0"
