#!/bin/sh
set -e

CONFIG_IN="/root/erpc.yaml"
CONFIG_OUT="/root/erpc.yaml.rendered"
ENV_FILE="/root/.env"

if [ -f "$ENV_FILE" ]; then
  # Export variables from .env without executing arbitrary code.
  # We only accept KEY=VALUE lines and skip comments/empty lines.
  set -a
  while IFS='=' read -r key value; do
    case "$key" in
      ''|\#*) continue ;;
    esac
    # Strip optional surrounding quotes.
    value=${value#\"}
    value=${value%\"}
    value=${value#\'}
    value=${value%\'}
    export "$key=$value"
  done < "$ENV_FILE"
  set +a
fi

if command -v envsubst >/dev/null 2>&1; then
  envsubst < "$CONFIG_IN" > "$CONFIG_OUT"
else
  # Fallback: use original config if envsubst is unavailable.
  CONFIG_OUT="$CONFIG_IN"
fi

exec erpc --config "$CONFIG_OUT" "$@"
