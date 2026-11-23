#!/bin/sh
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo 'Установите Node.js 20+'; exit 1; }
npm ls --depth=0 >/dev/null 2>&1 || npm ci --no-audit --no-fund
if [ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-}" ]; then
  npx playwright install chromium
fi
exec npm start
