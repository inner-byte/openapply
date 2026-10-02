#!/bin/bash
# OpenApply live-check API server (persistent paths)
cd ~/workspace/openapply
export TOKEN_ENCRYPTION_KEY="$(cat $HOME/workspace/openapply/.openapply-live/enc.key)"
export OPENAPPLY_ACCESS_KEY="YfBmVwAER74EbCduIMe-8ZlYaHajHS17NVEGdCzPT5E"
export CPK_INTELLIGENCE_API_KEY="dummy-cpk-key-for-live-check"
export WORKSPACE_MODE=live
export AGENT_BACKEND=model
export PORT=8787
export HOST=127.0.0.1
export PUBLIC_API_URL=http://127.0.0.1:8787
export DATA_DIR="$HOME/workspace/openapply/.openapply-live/server"
export BROWSER_WORKER_URL=http://127.0.0.1:8790
export WORKER_TOKEN="live-check-worker-token-2026-32chars!"
mkdir -p "$DATA_DIR"
exec node_modules/.bin/tsx apps/server/src/index.ts
