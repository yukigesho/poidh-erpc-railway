
#!/usr/bin/env sh
set -e

echo "Rendering erpc.yaml from env vars..."

envsubst < erpc.yaml.template > erpc.yaml

echo "Starting eRPC..."
exec erpc run --config erpc.yaml
