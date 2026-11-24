#!/bin/sh
# Build the folder Cloudflare serves at https://simonsoliloquy.com/simons-subway/ (see wrangler.jsonc):
# the Vite build with --base=/simons-subway/ (tests run first, as `npm run build` does), into
# .cf/simons-subway/ because the URL path is the folder path. VITE_RIDES=on as on Vercel.
# By hand: sh tools/cf-build.sh && npx wrangler deploy
set -e
cd "$(dirname "$0")/.."
[ -d node_modules ] || npm ci
node --test test/*.test.mjs
rm -rf .cf
VITE_RIDES=on npx vite build --base=/simons-subway/ --outDir .cf/simons-subway --emptyOutDir
find .cf -type f | wc -l
