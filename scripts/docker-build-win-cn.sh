#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DOCKER_IMAGE="${DOCKER_IMAGE:-electronuserland/builder:wine}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"
VOLUME_PREFIX="${VOLUME_PREFIX:-chaterm_docker}"
SKIP_NPM_CI="${SKIP_NPM_CI:-0}"
CLEAN_DIST="${CLEAN_DIST:-1}"

NODE_MODULES_VOLUME="${NODE_MODULES_VOLUME:-${VOLUME_PREFIX}_node_modules}"
NPM_CACHE_VOLUME="${NPM_CACHE_VOLUME:-${VOLUME_PREFIX}_npm_cache}"
ELECTRON_CACHE_VOLUME="${ELECTRON_CACHE_VOLUME:-${VOLUME_PREFIX}_electron_cache}"
ELECTRON_BUILDER_CACHE_VOLUME="${ELECTRON_BUILDER_CACHE_VOLUME:-${VOLUME_PREFIX}_electron_builder_cache}"

log() {
  printf '\033[1;34m[win-cn-docker]\033[0m %s\n' "$*"
}

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required but was not found in PATH." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running or is not accessible." >&2
  exit 1
fi

if [[ "$CLEAN_DIST" != "0" ]]; then
  log "Cleaning previous Windows CN build artifacts"
  rm -rf dist/cn/win-unpacked
  rm -f dist/cn/*-cn-setup-*.exe dist/cn/*-cn-setup-*.exe.blockmap
fi

log "Using Docker image: ${DOCKER_IMAGE} (${DOCKER_PLATFORM})"
log "Using isolated node_modules volume: ${NODE_MODULES_VOLUME}"

HOST_UID="$(id -u)"
HOST_GID="$(id -g)"

container_script=$(cat <<'EOS'
set -euo pipefail

echo "node=$(node --version) npm=$(npm --version) arch=$(uname -m)"

if [[ "${SKIP_NPM_CI:-0}" != "1" ]]; then
  npm ci
else
  echo "Skipping npm ci because SKIP_NPM_CI=1"
fi

npm run check:release-notes
npm run build:cn

ELECTRON_VERSION="$(node -p "require('./node_modules/electron/package.json').version")"
echo "Installing Windows x64 better-sqlite3 prebuild for Electron ${ELECTRON_VERSION}"
(
  cd node_modules/better-sqlite3
  npx prebuild-install -r electron -t "${ELECTRON_VERSION}" --platform win32 --arch x64 --force
)

npx electron-builder --win --config electron-builder.cn.yml --publish never

node scripts/verify-ffmpeg.js --file dist/cn/win-unpacked/ffmpeg.dll

node <<'NODE'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const asar = require('@electron/asar')

const archive = 'dist/cn/win-unpacked/resources/app.asar'
const unpacked = 'dist/cn/win-unpacked/resources/app.asar.unpacked'
const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString())
const main = asar.extractFile(archive, 'out/main/index.js').toString()

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertMZ(file) {
  const buffer = fs.readFileSync(file)
  assert(buffer[0] === 0x4d && buffer[1] === 0x5a, `${file} is not a Windows PE/MZ binary`)
}

assert(pkg.dependencies?.oracledb, 'oracledb is missing from packaged package.json dependencies')
assert(main.includes('import("oracledb")') || main.includes("import('oracledb')"), 'main bundle does not import oracledb')

const ffmpegPath = 'dist/cn/win-unpacked/ffmpeg.dll'
const ffmpegHash = crypto.createHash('sha256').update(fs.readFileSync(ffmpegPath)).digest('hex').toUpperCase()
assert(main.includes(ffmpegHash), `main bundle does not contain packaged ffmpeg.dll hash: ${ffmpegHash}`)

assertMZ(path.join(unpacked, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'))

const oracleReleaseDir = path.join(unpacked, 'node_modules/oracledb/build/Release')
const oracleWinBinary = fs.readdirSync(oracleReleaseDir).find((name) => /^oracledb-.*-win32-x64\.node$/.test(name))
assert(oracleWinBinary, 'oracledb win32-x64 native binary is missing')
assertMZ(path.join(oracleReleaseDir, oracleWinBinary))

console.log('Packaged dependency verification passed')
NODE

ls -lh dist/cn/*-cn-setup-*.exe dist/cn/*-cn-setup-*.exe.blockmap

if [[ -n "${HOST_UID:-}" && -n "${HOST_GID:-}" ]]; then
  chown -R "${HOST_UID}:${HOST_GID}" dist/cn out 2>/dev/null || true
fi
EOS
)

docker run --rm --platform "$DOCKER_PLATFORM" \
  -v "$ROOT_DIR:/project" \
  -v "$NODE_MODULES_VOLUME:/project/node_modules" \
  -v "$NPM_CACHE_VOLUME:/root/.npm" \
  -v "$ELECTRON_CACHE_VOLUME:/root/.cache/electron" \
  -v "$ELECTRON_BUILDER_CACHE_VOLUME:/root/.cache/electron-builder" \
  -w /project \
  -e HUSKY=0 \
  -e SKIP_NPM_CI="$SKIP_NPM_CI" \
  -e HOST_UID="$HOST_UID" \
  -e HOST_GID="$HOST_GID" \
  "$DOCKER_IMAGE" \
  /bin/bash -lc "$container_script"

log "Done. Windows CN installer is in dist/cn/"
