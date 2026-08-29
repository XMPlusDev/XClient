/**
 * Byte sources for the IP2Location BIN reader.
 *
 * The reader never sees a file — it asks for byte ranges. On Cloudflare that
 * range comes from an R2 ranged GET, which is a network round trip, so every
 * read goes through a block cache: reads are widened to fixed-size blocks,
 * blocks are memoised per isolate, and (optionally) parked in the colo-local
 * Cache API so a cold isolate still gets warm bytes.
 */

export interface ByteSource {
  /** Read exactly `length` bytes at `offset`. May return fewer at EOF. */
  read(offset: number, length: number): Promise<Uint8Array>
}

/** Minimal shape of the R2 binding we depend on. */
export interface R2Like {
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
}

export class MissingObjectError extends Error {
  constructor(key: string) {
    super(`R2 object not found: ${key}`)
    this.name = 'MissingObjectError'
  }
}

/** Raw ranged reads against an R2 bucket. */
export class R2ByteSource implements ByteSource {
  private bucket: R2Like
  private readonly key: string

  constructor(bucket: R2Like, key: string) {
    this.bucket = bucket
    this.key = key
  }

  /**
   * Bindings are per-isolate objects; a long-lived reader keeps working if we
   * refresh the handle each request rather than pinning the first one we saw.
   */
  rebind(bucket: R2Like): void {
    this.bucket = bucket
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const object = await this.bucket.get(this.key, { range: { offset, length } })
    if (!object) throw new MissingObjectError(this.key)
    return new Uint8Array(await object.arrayBuffer())
  }
}

/** Minimal shape of the colo-local `caches.default`, absent outside workerd. */
interface EdgeCache {
  match(key: string): Promise<Response | undefined>
  put(key: string, response: Response): Promise<void>
}

/** `caches.default` is a Cloudflare extension, so it is not in the DOM types. */
function edgeCache(): EdgeCache | null {
  const global = globalThis as { caches?: { default?: EdgeCache } }
  return global.caches?.default ?? null
}

export interface BlockCacheOptions {
  /** Read granularity. Bigger = fewer round trips, more wasted bytes. */
  blockSize?: number
  /** Max blocks held in the isolate. blockSize * maxBlocks is the ceiling. */
  maxBlocks?: number
  /** Namespace for the Cache API layer. Omit to disable that layer. */
  cacheKeyPrefix?: string
}

/**
 * Caching wrapper. Splits every read into aligned blocks and serves them from
 * memory -> Cache API -> origin, in that order.
 */
export class CachedSource implements ByteSource {
  readonly blockSize: number
  private readonly maxBlocks: number
  private readonly cacheKeyPrefix: string | null

  /** Insertion-ordered, so the oldest key is the first one Map yields. */
  private readonly blocks = new Map<number, Uint8Array>()
  /** De-dupes concurrent misses for the same block. */
  private readonly inflight = new Map<number, Promise<Uint8Array>>()

  stats = { hits: 0, misses: 0, edgeHits: 0 }

  private readonly origin: ByteSource

  constructor(origin: ByteSource, options: BlockCacheOptions = {}) {
    this.origin = origin
    this.blockSize = options.blockSize ?? 32 * 1024
    this.maxBlocks = options.maxBlocks ?? 192
    this.cacheKeyPrefix = options.cacheKeyPrefix ?? null
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array(0)

    const firstBlock = Math.floor(offset / this.blockSize)
    const lastBlock = Math.floor((offset + length - 1) / this.blockSize)

    // Fast path: the range sits inside one block, so slice it in place.
    if (firstBlock === lastBlock) {
      const block = await this.getBlock(firstBlock)
      const start = offset - firstBlock * this.blockSize
      return block.subarray(start, Math.min(start + length, block.length))
    }

    const parts = await Promise.all(
      Array.from({ length: lastBlock - firstBlock + 1 }, (_, i) => this.getBlock(firstBlock + i)),
    )

    const out = new Uint8Array(length)
    let written = 0
    for (let i = 0; i < parts.length; i++) {
      const block = parts[i]!
      const blockStart = (firstBlock + i) * this.blockSize
      const from = Math.max(0, offset - blockStart)
      const to = Math.min(block.length, offset + length - blockStart)
      if (to <= from) continue
      out.set(block.subarray(from, to), written)
      written += to - from
    }
    return written === length ? out : out.subarray(0, written)
  }

  private getBlock(index: number): Promise<Uint8Array> {
    const cached = this.blocks.get(index)
    if (cached) {
      this.stats.hits++
      // Refresh recency: delete + re-set moves it to the end of the Map.
      this.blocks.delete(index)
      this.blocks.set(index, cached)
      return Promise.resolve(cached)
    }

    const pending = this.inflight.get(index)
    if (pending) return pending

    this.stats.misses++
    const promise = this.fetchBlock(index)
      .then((block) => {
        this.store(index, block)
        return block
      })
      .finally(() => {
        this.inflight.delete(index)
      })

    this.inflight.set(index, promise)
    return promise
  }

  private async fetchBlock(index: number): Promise<Uint8Array> {
    const edge = this.cacheKeyPrefix ? edgeCache() : null
    const cacheKey = `https://ip2location.internal/${this.cacheKeyPrefix}/${index}`

    if (edge) {
      const hit = await edge.match(cacheKey).catch(() => undefined)
      if (hit) {
        this.stats.edgeHits++
        return new Uint8Array(await hit.arrayBuffer())
      }
    }

    const block = await this.origin.read(index * this.blockSize, this.blockSize)

    if (edge && block.length > 0) {
      // The BIN is immutable for the life of a deployment, so cache hard.
      // `slice()` copies out of the shared buffer the block may be a view of.
      const response = new Response(block.slice().buffer as ArrayBuffer, {
        headers: { 'cache-control': 'public, max-age=31536000, immutable' },
      })
      edge.put(cacheKey, response).catch(() => {})
    }

    return block
  }

  private store(index: number, block: Uint8Array): void {
    this.blocks.set(index, block)
    while (this.blocks.size > this.maxBlocks) {
      const oldest = this.blocks.keys().next()
      if (oldest.done) break
      this.blocks.delete(oldest.value)
    }
  }
}
