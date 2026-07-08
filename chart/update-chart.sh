#!/usr/bin/env bash
# Regenerate the tokscale chart SVG and push it to the GitHub profile repo.
# Called automatically after `tokscale submit` (zshrc wrapper + tokscale-daily skill).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG=~/.tokscale-chart-update.log

{
  echo "--- $(date '+%Y-%m-%d %H:%M:%S') updating tokscale chart"

  # node may not be on PATH in non-interactive shells (nvm)
  if ! command -v node >/dev/null 2>&1; then
    NVM_NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
    [ -n "$NVM_NODE" ] && export PATH="$NVM_NODE:$PATH"
  fi

  cd "$REPO/chart"
  [ -d node_modules ] || npm install --silent
  node build-chart.mjs

  cd "$REPO"
  if git diff --quiet -- assets/tokscale-chart.svg; then
    echo "chart unchanged, nothing to push"
  else
    git add assets/tokscale-chart.svg
    git commit -m "chart: update token usage $(date '+%Y-%m-%d')" -- assets/tokscale-chart.svg
    git pull --rebase --quiet origin main || true
    git push --quiet origin main
    echo "chart updated and pushed"
  fi
} >>"$LOG" 2>&1
