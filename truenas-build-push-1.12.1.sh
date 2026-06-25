#!/bin/sh
set -eu

VERSION=${VERSION:-1.12.1}
INBOX=/mnt/pool0/apps/message-hub/inbox
BUILD_DIR=/mnt/pool0/apps/message-hub/build-$VERSION
IMAGE=ghcr.io/dbesada/message-hub:$VERSION
ARCHIVE=${ARCHIVE:-$INBOX/message-hub-src-$VERSION.tar.gz}
LOG=$INBOX/build-$VERSION.log
PASS_FILE=$INBOX/registry-pass.txt
REGISTRY_USER=${REGISTRY_USER:-codex}
REGISTRY_HOST=${REGISTRY_HOST:-192.168.50.230:5000}
PROOF_FILE=$INBOX/build-1.12.1.started

NOW=$(date '+%Y-%m-%dT%H:%M:%S%z')
printf '%s\n' "$NOW" > "$PROOF_FILE"
exec >"$LOG" 2>&1
echo "[$NOW] start"

if [ ! -f "$ARCHIVE" ]; then
  echo "archive not found: $ARCHIVE"
  exit 1
fi

if [ -n "${REGISTRY_PASS:-}" ]; then
  :
elif [ -f "$PASS_FILE" ]; then
  REGISTRY_PASS=$(cat "$PASS_FILE")
else
  read -r REGISTRY_PASS
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
tar -xzf "$ARCHIVE" -C "$BUILD_DIR"

cd "$BUILD_DIR"
printf '%s\n' "$REGISTRY_PASS" | docker login "$REGISTRY_HOST" -u "$REGISTRY_USER" --password-stdin
docker build -t "$IMAGE" .
docker push "$IMAGE"

echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] done"
