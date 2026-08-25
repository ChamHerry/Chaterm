const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// Electron 41.5.2 win32-x64 ffmpeg.dll.
// Keep this in sync with src/main/index.ts and the Windows package built by
// scripts/docker-build-win.sh.
const KNOWN_WINDOWS_X64_FFMPEG_SHA256 = '9E6FD0CFB118760559137D85CB5F24C26F09182AB5758C4F93CF2290BE401B6E'

function getArgValue(flag) {
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`))
  if (inline) return inline.slice(flag.length + 1)

  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined

  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) {
    console.error(`Missing value for ${flag}`)
    process.exit(1)
  }
  return value
}

const targetArg = getArgValue('--file') || getArgValue('--path')
const expectedHash = (getArgValue('--hash') || process.env.FFMPEG_SHA256 || KNOWN_WINDOWS_X64_FFMPEG_SHA256).toUpperCase()

if (!/^[A-F0-9]{64}$/.test(expectedHash)) {
  console.error(`Invalid SHA-256 hash: ${expectedHash}`)
  process.exit(1)
}

if (!targetArg && process.platform !== 'win32') {
  console.log(`Skipping ffmpeg verification for non-Windows platform: ${process.platform}`)
  process.exit(0)
}

const ffmpegPath = targetArg ? path.resolve(process.cwd(), targetArg) : path.join(__dirname, '../node_modules/electron/dist/ffmpeg.dll')

console.log('Validating ffmpeg.dll integrity...')
console.log(`Target: ${ffmpegPath}`)

if (!fs.existsSync(ffmpegPath)) {
  console.error('❌ ffmpeg.dll not found at expected path!')
  process.exit(1)
}

try {
  const fileBuffer = fs.readFileSync(ffmpegPath)
  const hashSum = crypto.createHash('sha256')
  hashSum.update(fileBuffer)
  const hex = hashSum.digest('hex').toUpperCase()

  if (hex !== expectedHash) {
    console.error('❌ SECURITY ALERT: ffmpeg.dll hash mismatch!')
    console.error(`Expected: ${expectedHash}`)
    console.error(`Actual:   ${hex}`)
    console.error('\nPOSSIBLE CAUSES:')
    console.error('1. Electron version changed (update the hash in scripts/verify-ffmpeg.js)')
    console.error('2. File corruption')
    console.error('3. MALICIOUS TAMPERING (DLL Sideloading/Replacement)')
    process.exit(1)
  }

  console.log('✅ ffmpeg.dll integrity check passed.')
  process.exit(0)
} catch (error) {
  console.error('❌ Error reading file:', error)
  process.exit(1)
}
