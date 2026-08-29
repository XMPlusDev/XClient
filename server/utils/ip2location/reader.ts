/**
 * IP2Location BIN reader — no filesystem, no dependencies, workerd-safe.
 *
 * BIN layout:
 *   [64-byte header]
 *   [65536 * 8-byte IPv4 index][65536 * 8-byte IPv6 index]
 *   [IPv4 row table][IPv6 row table]
 *   [string pool]
 *
 * Rows are fixed width and sorted by ip_from, so a lookup is:
 *   1. index bucket (top 16 bits of the address) -> a narrow low/high row range
 *   2. binary search that range
 *   3. dereference the row's 4-byte pointers into the string pool
 *
 * Because the index bucket usually narrows the search to a few dozen rows, the
 * whole candidate window is pulled in one read and searched in memory — that
 * turns ~22 sequential round trips into one.
 */
import type { ByteSource } from './source'

const MAX_INDEX = 65536
const HEADER_SIZE = 64
const MAX_IPV4 = 4294967295n
const MAX_IPV6 = 340282366920938463463374607431768211455n
const FROM_6TO4 = 42545680458834377588178886921629466624n
const TO_6TO4 = 42550872755692912415807417417958686719n
const FROM_TEREDO = 42540488161975842760550356425300246528n
const TO_TEREDO = 42540488241204005274814694018844196863n
const FROM_V4MAPPED = 281470681743360n
const TO_V4MAPPED = 281474976710655n
const LAST_32 = 4294967295n

/** Widest row window we will pull in a single read before falling back. */
const MAX_WINDOW_BYTES = 512 * 1024

/**
 * Column number (1-based) of each field per database type (DB1..DB26).
 * Index 0 is unused; 0 means the field is absent from that DB type.
 */
const POSITIONS = {
  countryShort: [0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
  region: [0, 0, 0, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3],
  city: [0, 0, 0, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
  isp: [0, 0, 3, 0, 5, 0, 7, 5, 7, 0, 8, 0, 9, 0, 9, 0, 9, 0, 9, 7, 9, 0, 9, 7, 9, 9, 9],
  latitude: [0, 0, 0, 0, 0, 5, 5, 0, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
  longitude: [0, 0, 0, 0, 0, 6, 6, 0, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6],
  domain: [0, 0, 0, 0, 0, 0, 0, 6, 8, 0, 9, 0, 10, 0, 10, 0, 10, 0, 10, 8, 10, 0, 10, 8, 10, 10, 10],
  zipCode: [0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 7, 7, 7, 0, 7, 7, 7, 0, 7, 0, 7, 7, 7, 0, 7, 7, 7],
  timeZone: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 8, 7, 8, 8, 8, 7, 8, 0, 8, 8, 8, 0, 8, 8, 8],
  netSpeed: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 11, 0, 11, 8, 11, 0, 11, 0, 11, 0, 11, 11, 11],
  iddCode: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 12, 0, 12, 0, 12, 9, 12, 0, 12, 12, 12],
  areaCode: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 13, 0, 13, 0, 13, 10, 13, 0, 13, 13, 13],
  weatherStationCode: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 14, 0, 14, 0, 14, 0, 14, 14, 14],
  weatherStationName: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 15, 0, 15, 0, 15, 0, 15, 15, 15],
  mcc: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 16, 0, 16, 9, 16, 16, 16],
  mnc: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 17, 0, 17, 10, 17, 17, 17],
  mobileBrand: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11, 18, 0, 18, 11, 18, 18, 18],
  elevation: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11, 19, 0, 19, 19, 19],
  usageType: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12, 20, 20, 20],
  addressType: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 21, 21],
  category: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 22, 22],
  district: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 23],
  asn: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 24],
  as: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 25],
} as const

export type FieldName = keyof typeof POSITIONS

/** Stored inline in the row as float32 instead of as a string-pool pointer. */
const FLOAT_FIELDS = new Set<FieldName>(['latitude', 'longitude'])

export interface Ip2LocationRecord {
  ip: string
  ipNumber: string
  ipVersion: 4 | 6
  countryCode?: string | null
  countryName?: string | null
  region?: string | null
  city?: string | null
  isp?: string | null
  latitude?: number | null
  longitude?: number | null
  domain?: string | null
  zipCode?: string | null
  timeZone?: string | null
  netSpeed?: string | null
  iddCode?: string | null
  areaCode?: string | null
  weatherStationCode?: string | null
  weatherStationName?: string | null
  mcc?: string | null
  mnc?: string | null
  mobileBrand?: string | null
  elevation?: string | null
  usageType?: string | null
  addressType?: string | null
  category?: string | null
  district?: string | null
  asn?: string | null
  as?: string | null
}

export interface DbMeta {
  dbType: number
  dbColumns: number
  date: string
  ipv4Rows: number
  ipv6Rows: number
  ipv4Indexed: boolean
  ipv6Indexed: boolean
  fileSize: number
  fields: string[]
}

export type Ip2LocationErrorCode =
  | 'INVALID_IP'
  | 'INVALID_BIN'
  | 'UNSUPPORTED_DB'
  | 'IPV6_UNSUPPORTED'
  | 'NOT_FOUND'

export class Ip2LocationError extends Error {
  readonly code: Ip2LocationErrorCode

  constructor(message: string, code: Ip2LocationErrorCode) {
    super(message)
    this.name = 'Ip2LocationError'
    this.code = code
  }
}

interface FieldSpec {
  name: FieldName
  /** Output key on the record. */
  key: keyof Ip2LocationRecord
  /** Byte offset within the row body (ip_from already stripped). */
  offset: number
  isFloat: boolean
}

/** Field names that read better in an HTTP response than IP2Location's own. */
const OUTPUT_KEYS: Partial<Record<FieldName, keyof Ip2LocationRecord>> = {
  countryShort: 'countryCode',
}

const decoder = new TextDecoder('utf-8')

export class Ip2LocationReader {
  private dbType = 0
  private dbColumns = 0
  private dbYear = 0
  private dbMonth = 0
  private dbDay = 0
  private fileSize = 0

  private v4Rows = 0
  private v4Base = 0
  private v6Rows = 0
  private v6Base = 0
  private v4IndexBase = 0
  private v6IndexBase = 0
  private v4ColumnSize = 0
  private v6ColumnSize = 0

  private fields: FieldSpec[] = []
  private countryOffset = -1

  /** Pool pointer -> decoded string. Country and region names repeat heavily. */
  private readonly strings = new Map<number, string>()
  private readonly stringLimit = 50000

  private readonly source: ByteSource

  private constructor(source: ByteSource) {
    this.source = source
  }

  static async open(source: ByteSource): Promise<Ip2LocationReader> {
    const reader = new Ip2LocationReader(source)
    await reader.readHeader()
    return reader
  }

  get meta(): DbMeta {
    const pad = (n: number) => String(n).padStart(2, '0')
    return {
      dbType: this.dbType,
      dbColumns: this.dbColumns,
      date: `${2000 + this.dbYear}-${pad(this.dbMonth)}-${pad(this.dbDay)}`,
      ipv4Rows: this.v4Rows,
      ipv6Rows: this.v6Rows,
      ipv4Indexed: this.v4IndexBase > 0,
      ipv6Indexed: this.v6IndexBase > 0,
      fileSize: this.fileSize,
      fields: this.fields.map((f) => f.key as string),
    }
  }

  // ----------------------------------------------------------------- header

  private async readHeader(): Promise<void> {
    const bytes = await this.source.read(0, HEADER_SIZE)
    if (bytes.length < HEADER_SIZE) {
      throw new Ip2LocationError('File is too small to be an IP2Location BIN', 'INVALID_BIN')
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    this.dbType = view.getUint8(0)
    this.dbColumns = view.getUint8(1)
    this.dbYear = view.getUint8(2)
    this.dbMonth = view.getUint8(3)
    this.dbDay = view.getUint8(4)
    this.v4Rows = view.getUint32(5, true)
    this.v4Base = view.getUint32(9, true)
    this.v6Rows = view.getUint32(13, true)
    this.v6Base = view.getUint32(17, true)
    this.v4IndexBase = view.getUint32(21, true)
    this.v6IndexBase = view.getUint32(25, true)
    const productCode = view.getUint8(29)
    this.fileSize = view.getUint32(31, true)

    // Only BINs published from 2021 onwards carry the product code byte.
    if ((productCode !== 1 && this.dbYear >= 21) || (this.dbType === 80 && this.dbColumns === 75)) {
      throw new Ip2LocationError(
        'Not a valid IP2Location BIN (still zipped, or a different product?)',
        'INVALID_BIN',
      )
    }
    if (this.dbType < 1 || this.dbType >= POSITIONS.countryShort.length) {
      throw new Ip2LocationError(`Unsupported IP2Location DB type: ${this.dbType}`, 'UNSUPPORTED_DB')
    }

    this.v4ColumnSize = this.dbColumns << 2
    this.v6ColumnSize = 16 + ((this.dbColumns - 1) << 2)

    // Resolve the field plan once so row parsing is a flat loop.
    for (const name of Object.keys(POSITIONS) as FieldName[]) {
      const column = POSITIONS[name][this.dbType] ?? 0
      if (column === 0) continue
      // Column 1 is ip_from, which is stripped before parsing -> shift by 2.
      const offset = (column - 2) << 2
      this.fields.push({
        name,
        key: OUTPUT_KEYS[name] ?? (name as keyof Ip2LocationRecord),
        offset,
        isFloat: FLOAT_FIELDS.has(name),
      })
      if (name === 'countryShort') this.countryOffset = offset
    }
  }

  // ----------------------------------------------------------------- lookup

  async lookup(input: string): Promise<Ip2LocationRecord> {
    const parsed = parseIp(input)
    if (!parsed) throw new Ip2LocationError(`Invalid IP address: ${input}`, 'INVALID_IP')

    let version = parsed.version
    let value = parsed.value

    // 6to4, Teredo and ::ffff:0:0/96 all carry a real IPv4 address.
    if (version === 6) {
      const embedded = extractEmbeddedIpv4(value)
      if (embedded !== null) {
        version = 4
        value = embedded
      }
    }

    const v4 = version === 4
    if (!v4 && this.v6Rows === 0) {
      throw new Ip2LocationError('This BIN has no IPv6 data — use the .IPV6.BIN variant', 'IPV6_UNSUPPORTED')
    }

    const base = v4 ? this.v4Base : this.v6Base
    const columnSize = v4 ? this.v4ColumnSize : this.v6ColumnSize
    const firstCol = v4 ? 4 : 16
    const max = v4 ? MAX_IPV4 : MAX_IPV6
    const indexBase = v4 ? this.v4IndexBase : this.v6IndexBase

    if (value >= max) value = max - 1n

    let low = 0
    let high = v4 ? this.v4Rows : this.v6Rows
    if (indexBase > 0) {
      const bucket = Number(v4 ? value >> 16n : value >> 112n)
      ;[low, high] = await this.readIndexBucket(indexBase, bucket)
    }

    const record: Ip2LocationRecord = {
      ip: parsed.normalized,
      ipNumber: value.toString(),
      ipVersion: version,
    }

    const row = await this.findRow(value, low, high, base, columnSize, firstCol)
    if (!row) throw new Ip2LocationError(`No record found for ${parsed.normalized}`, 'NOT_FOUND')

    await this.parseRow(row, record)
    return record
  }

  /** Index entries are two uint32s: the first and last row of the bucket. */
  private async readIndexBucket(indexBase: number, bucket: number): Promise<[number, number]> {
    // Addresses in the header are 1-based file positions.
    const bytes = await this.source.read(indexBase - 1 + bucket * 8, 8)
    if (bytes.length < 8) return [0, 0]
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return [view.getUint32(0, true), view.getUint32(4, true)]
  }

  /**
   * Returns the row body (ip_from stripped) whose range contains `value`.
   *
   * When the candidate window is small enough it is fetched whole and searched
   * in memory; otherwise each probe reads only the row it needs.
   */
  private async findRow(
    value: bigint,
    low: number,
    high: number,
    base: number,
    columnSize: number,
    firstCol: number,
  ): Promise<Uint8Array | null> {
    if (high < low) return null

    const rowCount = high - low + 1
    const windowBytes = rowCount * columnSize + firstCol

    if (windowBytes <= MAX_WINDOW_BYTES) {
      // One read covers every candidate row plus the next row's ip_from,
      // which is the ip_to of the last candidate.
      const window = await this.source.read(base - 1 + low * columnSize, windowBytes)
      const view = new DataView(window.buffer, window.byteOffset, window.byteLength)
      const available = Math.floor(Math.max(0, window.length - firstCol) / columnSize) - 1

      let lo = 0
      let hi = Math.min(rowCount - 1, available)
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const at = mid * columnSize
        const ipFrom = readIpNum(view, at, firstCol)
        const ipTo = readIpNum(view, at + columnSize, firstCol)
        if (ipFrom <= value && value < ipTo) {
          return window.subarray(at + firstCol, at + columnSize)
        }
        if (value < ipFrom) hi = mid - 1
        else lo = mid + 1
      }
      return null
    }

    while (low <= high) {
      const mid = Math.trunc((low + high) / 2)
      const bytes = await this.source.read(base - 1 + mid * columnSize, columnSize + firstCol)
      if (bytes.length < columnSize + firstCol) return null
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const ipFrom = readIpNum(view, 0, firstCol)
      const ipTo = readIpNum(view, columnSize, firstCol)
      if (ipFrom <= value && value < ipTo) return bytes.subarray(firstCol, columnSize)
      if (value < ipFrom) high = mid - 1
      else low = mid + 1
    }
    return null
  }

  private async parseRow(row: Uint8Array, out: Ip2LocationRecord): Promise<void> {
    const view = new DataView(row.buffer, row.byteOffset, row.byteLength)

    if (this.countryOffset >= 0) {
      const ptr = view.getUint32(this.countryOffset, true)
      // The pool stores code and name back to back: [1][CC] is 3 bytes, so the
      // country name always starts at ptr + 3.
      out.countryCode = blank(await this.readString(ptr))
      out.countryName = blank(await this.readString(ptr + 3))
    }

    for (const field of this.fields) {
      if (field.name === 'countryShort') continue
      if (field.isFloat) {
        // Stored inline as float32; IP2Location publishes 6 decimal places.
        const n = Math.round(view.getFloat32(field.offset, true) * 1e6) / 1e6
        ;(out as Record<string, unknown>)[field.key] = Number.isFinite(n) ? n : null
      } else {
        const s = await this.readString(view.getUint32(field.offset, true))
        ;(out as Record<string, unknown>)[field.key] = blank(s)
      }
    }

    // Reserved and unassigned ranges carry a "-" country and 0/0 coordinates.
    // Passing those through invites Null Island bugs downstream.
    if (out.countryCode === null) {
      if (out.latitude === 0) out.latitude = null
      if (out.longitude === 0) out.longitude = null
    }
  }

  /** Pool entries are [uint8 length][bytes]; pointers are absolute and 0-based. */
  private async readString(pointer: number): Promise<string> {
    const hit = this.strings.get(pointer)
    if (hit !== undefined) return hit

    // 255 is the widest a length-prefixed entry can be, +1 for the prefix.
    const bytes = await this.source.read(pointer, 256)
    if (bytes.length === 0) return ''
    const length = Math.min(bytes[0]!, bytes.length - 1)
    const value = decoder.decode(bytes.subarray(1, 1 + length))

    if (this.strings.size >= this.stringLimit) this.strings.clear()
    this.strings.set(pointer, value)
    return value
  }
}

// ------------------------------------------------------------------ helpers

/** IP2Location writes "-" and "This parameter is unavailable..." for unknowns. */
function blank(value: string): string | null {
  if (!value || value === '-') return null
  if (value.startsWith('This parameter is unavailable')) return null
  return value
}

function readIpNum(view: DataView, offset: number, size: number): bigint {
  if (size === 4) return BigInt(view.getUint32(offset, true))
  // 128-bit little-endian: byte 0 is the least significant.
  let value = 0n
  for (let i = 12; i >= 0; i -= 4) value = (value << 32n) | BigInt(view.getUint32(offset + i, true))
  return value
}

function extractEmbeddedIpv4(value: bigint): bigint | null {
  if (value >= FROM_V4MAPPED && value <= TO_V4MAPPED) return value - FROM_V4MAPPED
  if (value >= FROM_6TO4 && value <= TO_6TO4) return (value >> 80n) & LAST_32
  if (value >= FROM_TEREDO && value <= TO_TEREDO) return ~value & LAST_32
  return null
}

export interface ParsedIp {
  version: 4 | 6
  value: bigint
  normalized: string
}

export function parseIp(input: string): ParsedIp | null {
  let ip = input.trim()
  if (!ip) return null

  // Tolerate a bracketed IPv6 literal, with or without a port: [::1]:443
  if (ip.startsWith('[')) {
    const close = ip.indexOf(']')
    if (close === -1) return null
    ip = ip.slice(1, close)
  }

  if (ip.includes(':') && !ip.includes('.')) {
    // A lone colon in a dotless address is either IPv6 or "host:port"; only
    // the multi-colon form can be IPv6.
    if (ip.split(':').length === 2) ip = ip.slice(0, ip.indexOf(':'))
  }

  if (ip.includes(':')) {
    const value = ipv6ToBigInt(ip)
    return value === null ? null : { version: 6, value, normalized: ip.toLowerCase() }
  }
  const value = ipv4ToBigInt(ip)
  return value === null ? null : { version: 4, value, normalized: ip }
}

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8n) | BigInt(octet)
  }
  return value
}

function ipv6ToBigInt(ip: string): bigint | null {
  let text = ip.toLowerCase()

  // Drop a zone id (fe80::1%eth0) — irrelevant for geolocation.
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)

  // A trailing dotted quad (::ffff:1.2.3.4) expands into two hextets.
  const lastColon = text.lastIndexOf(':')
  if (lastColon === -1) return null
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = ipv4ToBigInt(tail)
    if (v4 === null) return null
    text = `${text.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`
  }

  const doubleColon = text.indexOf('::')
  let head: string[]
  let tailGroups: string[]
  if (doubleColon === -1) {
    head = text.split(':')
    tailGroups = []
  } else {
    if (text.indexOf('::', doubleColon + 1) !== -1) return null
    const left = text.slice(0, doubleColon)
    const right = text.slice(doubleColon + 2)
    head = left === '' ? [] : left.split(':')
    tailGroups = right === '' ? [] : right.split(':')
  }

  const total = head.length + tailGroups.length
  if (total > 8 || (doubleColon === -1 && total !== 8)) return null

  const groups = [...head, ...Array(8 - total).fill('0'), ...tailGroups]
  let value = 0n
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    value = (value << 16n) | BigInt(parseInt(group, 16))
  }
  return value
}
