#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
node src/index.mjs --mode hourly
