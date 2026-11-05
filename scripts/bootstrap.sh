#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }; }
need git
need node
need npm
need openssl
need curl

if [ ! -d target/.git ]; then
  git clone https://github.com/shashwat558/nightshift-target.git target
fi

npm ci --prefix supervisor
npm run build --prefix supervisor
npm ci --prefix target

if [ ! -f ops/.env ]; then
  secret() { openssl rand -hex 32; }
  db_password="$(secret)"
  db_owner_password="$(secret)"
  registration_token="$(secret)"
  gateway_password="$(secret)"
  mattermost_admin_password="$(secret)"
  mattermost_user_password="$(secret)"
  secret_key="$(secret)"
  controller_secret="$(secret)"
  umask 077
  {
    echo 'SWITCH_REGISTRY=ghcr.io'
    echo 'SWITCH_IMAGE_NAMESPACE=sandbox-quantum'
    echo 'SWITCH_VERSION=0.31.0'
    echo 'SWITCH_BIND_ADDR=127.0.0.1'
    echo 'API_HOST_PORT=8000'
    echo 'GATEWAY_HOST_PORT=3100'
    echo 'MATTERMOST_HOST_PORT=8065'
    echo 'POSTGRES_HOST_PORT=5432'
    echo 'DB_USER=switch_app'
    echo "DB_PASSWORD=$db_password"
    echo 'DB_OWNER_USER=postgres'
    echo "DB_OWNER_PASSWORD=$db_owner_password"
    echo 'DB_NAME=switch'
    echo "AGENT_REGISTRATION_TOKEN=$registration_token"
    echo "ADMIN_REGISTRATION_TOKEN=$registration_token"
    echo "SECRET_KEYS=v1:$secret_key"
    echo "CONTROLLER_TOKEN_SECRET=$controller_secret"
    echo 'FEATURE_FLAGS_ENABLED=agent_management'
    echo 'GATEWAY_ADMIN_EMAIL=admin@switch.local'
    echo "GATEWAY_ADMIN_PASSWORD=$gateway_password"
    echo 'FRONTEND_BASE_URL=http://localhost:3100'
    echo 'MATTERMOST_ADMIN_USER=admin'
    echo "MATTERMOST_ADMIN_PASSWORD=$mattermost_admin_password"
    echo 'MATTERMOST_TEAM_NAME=switch'
    echo 'MATTERMOST_USER=shashwat'
    echo "MATTERMOST_USER_PASSWORD=$mattermost_user_password"
    echo 'CREW_TEAM=nightshift'
    echo 'TELEMETRY_ENABLED=false'
  } > ops/.env
  chmod 600 ops/.env
  echo 'created ops/.env with generated secrets (chmod 600)'
  echo 'gateway login: admin@switch.local; password is in ops/.env'
else
  echo 'kept existing ops/.env'
fi

echo 'bootstrap complete'
