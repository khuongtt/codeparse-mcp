#!/bin/sh
# docker/entrypoint.sh

set -e

# Write config from environment if .codeparse.json not already present
if [ ! -f "/project/.codeparse.json" ]; then
  cat > /project/.codeparse.json << EOF
{
  "projectRoot": "${CODEPARSE_PROJECT_ROOT:-/project}",
  "dbPath": "${CODEPARSE_DB_PATH:-/data/graph.db}",
  "include": ["**/*.java", "**/*.xtend"],
  "exclude": ["**/node_modules/**", "**/build/**", "**/target/**", "**/.gradle/**"]
}
EOF
fi

case "$1" in
  serve)
    exec node /app/src/mcp/server.js
    ;;
  init)
    shift
    exec node /app/src/cli/index.js init --root "${CODEPARSE_PROJECT_ROOT:-/project}" "$@"
    ;;
  sync)
    shift
    exec node /app/src/cli/index.js sync --root "${CODEPARSE_PROJECT_ROOT:-/project}" "$@"
    ;;
  status)
    exec node /app/src/cli/index.js status --root "${CODEPARSE_PROJECT_ROOT:-/project}"
    ;;
  sync-file)
    shift
    exec node /app/src/cli/index.js sync-file "$1" --root "${CODEPARSE_PROJECT_ROOT:-/project}"
    ;;
  *)
    exec node /app/src/cli/index.js "$@"
    ;;
esac
