#!/usr/bin/env bash
# Rebuilds and restarts one (or all) testbed service(s) from a clean state, then waits until each
# one's sshd is actually answering before returning — so a caller (a test run, CI) never races a
# container that's still booting systemd.
#
# Usage: testbed/reset.sh [ubuntu2404|ubuntu2204|all]   (default: all)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

SERVICE="${1:-all}"
TIMEOUT_SECONDS=120

if [[ "$SERVICE" == "all" ]]; then
  COMPOSE_SERVICES=(ubuntu2404 ubuntu2204)
else
  COMPOSE_SERVICES=("$SERVICE")
fi

declare -A SSH_PORTS=([ubuntu2404]=2222 [ubuntu2204]=2223)

echo "==> Tearing down existing testbed containers/volumes"
docker compose down -v

echo "==> Building and starting: ${COMPOSE_SERVICES[*]}"
docker compose up -d --build --wait "${COMPOSE_SERVICES[@]}"

for svc in "${COMPOSE_SERVICES[@]}"; do
  port="${SSH_PORTS[$svc]}"
  echo "==> Waiting for sshd on 127.0.0.1:${port} (service: ${svc}, timeout ${TIMEOUT_SECONDS}s)"
  deadline=$((SECONDS + TIMEOUT_SECONDS))
  until ssh-keyscan -T 2 -p "$port" 127.0.0.1 2>/dev/null | grep -q .; do
    if (( SECONDS >= deadline )); then
      echo "!! Timed out waiting for sshd on port ${port} (service: ${svc})" >&2
      docker compose logs --tail=100 "$svc" >&2 || true
      exit 1
    fi
    sleep 1
  done
  echo "==> ${svc}: sshd is answering on port ${port}"
done

echo "==> Testbed ready: ${COMPOSE_SERVICES[*]}"
