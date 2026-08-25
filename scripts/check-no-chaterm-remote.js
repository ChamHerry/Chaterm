#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const scanRoots = ['src', 'build', 'electron.vite.config.ts', 'electron-builder.yml']
const forbiddenPatterns = [
  /api8\.chaterm\.net/,
  /api\.chaterm\.net/,
  /static-download8\.chaterm\.net/,
  /static-download\.chaterm\.net/,
  /chaterm-static\.intsig\.net/,
  /login\.chaterm\.cn/,
  /auth\.chaterm\.ai/,
  /demo\.chaterm\.ai/,
  /RENDERER_VUE_APP_API_BASEURL/,
  /RENDERER_SYNC_SERVER_URL/,
  /RENDERER_KMS_SERVER_URL/,
  /RENDERER_SPEECH_WS_URL/,
  /RENDERER_SSO/,
  /\/user\/info/,
  /\/user\/login-/,
  /\/sync\/user-config/,
  /\/plugin\/list/,
  /\/speech\/voice-to-text/
]
const ignoredDirs = new Set(['node_modules', 'dist', 'out', '.git'])

function listFiles(target) {
  const abs = path.join(repoRoot, target)
  if (!fs.existsSync(abs)) return []
  const stat = fs.statSync(abs)
  if (stat.isFile()) return [abs]
  if (!stat.isDirectory()) return []
  return fs.readdirSync(abs).flatMap((child) => (ignoredDirs.has(child) ? [] : listFiles(path.join(target, child))))
}

const matches = []
for (const file of scanRoots.flatMap(listFiles)) {
  const rel = path.relative(repoRoot, file)
  const content = fs.readFileSync(file, 'utf8')
  content.split(/\r?\n/).forEach((line, index) => {
    if (forbiddenPatterns.some((pattern) => pattern.test(line))) {
      matches.push(`${rel}:${index + 1}:${line.trim()}`)
    }
  })
}

if (matches.length > 0) {
  console.error('Forbidden built-in Chaterm remote references found:')
  for (const match of matches) console.error(match)
  process.exit(1)
}

console.log('No built-in Chaterm remote references found in runtime code or build config.')
