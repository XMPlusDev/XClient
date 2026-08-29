/**
 * Validates an IP2Location BIN header, then pushes it to R2 through wrangler.
 *
 *   node scripts/upload-bin.mjs --local            # miniflare bucket for `nuxt dev`
 *   node scripts/upload-bin.mjs --remote           # the real R2 bucket
 *   node scripts/upload-bin.mjs --remote --file X.BIN --key X.BIN
 *
 * Validating first matters: uploading a still-zipped or truncated file wastes
 * a 175 MB transfer and only fails at the first lookup.
 */
import { open, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { argv, exit } from 'node:process'

const DEFAULT_FILE = 'IP2LOCATION-LITE-DB5.IPV6.BIN'
const DEFAULT_BUCKET = 'ip2location'

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}

const file = arg('file', DEFAULT_FILE)
const key = arg('key', file.split(/[\\/]/).pop())
const bucket = arg('bucket', DEFAULT_BUCKET)
const local = argv.includes('--local')
const remote = argv.includes('--remote')

if (local === remote) {
  console.error('Pass exactly one of --local or --remote.')
  exit(1)
}

// --- validate -------------------------------------------------------------

const { size } = await stat(file).catch(() => {
  console.error(`No such file: ${file}`)
  exit(1)
})

const handle = await open(file, 'r')
const header = Buffer.alloc(64)
await handle.read(header, 0, 64, 0)
await handle.close()

if (header[0] === 0x50 && header[1] === 0x4b) {
  console.error(`${file} is a ZIP archive — unzip it and upload the .BIN inside.`)
  exit(1)
}

const meta = {
  dbType: header.readUInt8(0),
  columns: header.readUInt8(1),
  date: `${2000 + header.readUInt8(2)}-${String(header.readUInt8(3)).padStart(2, '0')}-${String(header.readUInt8(4)).padStart(2, '0')}`,
  ipv4Rows: header.readUInt32LE(5),
  ipv6Rows: header.readUInt32LE(13),
  productCode: header.readUInt8(29),
  declaredSize: header.readUInt32LE(31),
}

if (meta.productCode !== 1) {
  console.error(`Unexpected product code ${meta.productCode} — this may not be an IP2Location BIN.`)
  exit(1)
}
if (meta.declaredSize !== size) {
  console.error(`Truncated file: header declares ${meta.declaredSize} bytes, on disk ${size}.`)
  exit(1)
}

console.log(`DB${meta.dbType} (${meta.columns} columns) dated ${meta.date}`)
console.log(`${meta.ipv4Rows.toLocaleString()} IPv4 rows, ${meta.ipv6Rows.toLocaleString()} IPv6 rows`)
console.log(`${(size / 1024 / 1024).toFixed(1)} MB -> r2://${bucket}/${key} (${local ? 'local' : 'remote'})`)
console.log()

// --- upload ---------------------------------------------------------------

const args = [
  'wrangler',
  'r2',
  'object',
  'put',
  `${bucket}/${key}`,
  '--file',
  file,
  '--content-type',
  'application/octet-stream',
  local ? '--local' : '--remote',
]

const child = spawn('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' })
child.on('exit', (code) => {
  if (code === 0) {
    console.log('\nUploaded. If this is a new BIN, bump `cachePrefix` in nuxt.config.ts')
    console.log('so the Cache API stops serving blocks from the previous file.')
  }
  exit(code ?? 1)
})
