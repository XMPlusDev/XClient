/**
 * Exercises the BIN reader against a local file, using the same code path the
 * Worker uses — only the ByteSource differs (fs instead of R2).
 *
 *   node scripts/verify-bin.mjs [path/to/file.BIN]
 */
import { open } from 'node:fs/promises'
import { argv, exit } from 'node:process'
import { Ip2LocationReader } from '../server/utils/ip2location/reader.ts'
import { CachedSource } from '../server/utils/ip2location/source.ts'

const path = argv[2] ?? 'IP2LOCATION-LITE-DB5.IPV6.BIN'

class FileByteSource {
  constructor(handle) {
    this.handle = handle
    this.reads = 0
    this.bytes = 0
  }

  async read(offset, length) {
    this.reads++
    const buf = Buffer.allocUnsafe(length)
    const { bytesRead } = await this.handle.read(buf, 0, length, offset)
    this.bytes += bytesRead
    const slice = bytesRead === length ? buf : buf.subarray(0, bytesRead)
    return new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength)
  }
}

const CASES = [
  '8.8.8.8',
  '1.1.1.1',
  '13.107.42.14',
  '203.0.113.7',
  '112.198.0.1',
  '0.0.0.0',
  '255.255.255.255',
  '2001:4860:4860::8888',
  '2606:4700:4700::1111',
  '::ffff:8.8.8.8',
  '2002:0808:0808::',
  'not-an-ip',
  '999.1.1.1',
]

const handle = await open(path, 'r')
const origin = new FileByteSource(handle)
// Same block cache as production, so the read counts below are representative.
const source = new CachedSource(origin, { blockSize: 32768, maxBlocks: 192, cacheKeyPrefix: undefined })

const reader = await Ip2LocationReader.open(source)
console.log('database:', reader.meta)
console.log()

let failures = 0
for (const ip of CASES) {
  const before = origin.reads
  const started = performance.now()
  try {
    const record = await reader.lookup(ip)
    const ms = (performance.now() - started).toFixed(1)
    const place = [record.city, record.region, record.countryName].filter(Boolean).join(', ') || '(none)'
    const coords =
      record.latitude != null ? ` [${record.latitude}, ${record.longitude}]` : ''
    console.log(
      `ok    ${ip.padEnd(24)} v${record.ipVersion} ${String(record.countryCode ?? '--').padEnd(3)} ` +
        `${place}${coords}  (${origin.reads - before} reads, ${ms}ms)`,
    )
  } catch (error) {
    const expected = ip === 'not-an-ip' || ip === '999.1.1.1'
    if (!expected) failures++
    console.log(`${expected ? 'ok   ' : 'FAIL '} ${ip.padEnd(24)} ${error.code ?? ''} ${error.message}`)
  }
}

// Warm-cache throughput on a spread of addresses.
const sample = Array.from({ length: 500 }, (_, i) => `${(i * 7) % 224}.${i % 251}.${(i * 13) % 249}.1`)
const t0 = performance.now()
const readsBefore = origin.reads
let found = 0
for (const ip of sample) {
  try {
    await reader.lookup(ip)
    found++
  } catch {
    /* unassigned ranges are expected in a synthetic sample */
  }
}
const elapsed = performance.now() - t0

console.log()
console.log(
  `${sample.length} lookups in ${elapsed.toFixed(0)}ms ` +
    `(${(elapsed / sample.length).toFixed(2)}ms each, ${found} resolved)`,
)
console.log(
  `origin reads: ${origin.reads - readsBefore} for those lookups, ` +
    `${(origin.bytes / 1024 / 1024).toFixed(1)} MB read in total`,
)
console.log('block cache:', source.stats)

await handle.close()
if (failures > 0) {
  console.error(`\n${failures} unexpected failure(s)`)
  exit(1)
}
console.log('\nall checks passed')
