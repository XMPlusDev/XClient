/**
 * Nitro glue: resolves the R2 binding for the current request and hands back a
 * reader whose header and hot blocks are cached for the life of the isolate.
 */
import type { H3Event } from 'h3'
import { Ip2LocationReader } from './reader'
import { CachedSource, R2ByteSource, type R2Like } from './source'

export * from './reader'

interface CloudflareContext {
  cloudflare?: { env?: Record<string, unknown> }
}

/**
 * Isolate-scoped singletons. Cloudflare keeps a warm isolate alive across many
 * requests, so parsing the header once and holding the block cache is the
 * difference between ~5 R2 reads per lookup and ~1.
 */
let source: R2ByteSource | null = null
let cached: CachedSource | null = null
let readerPromise: Promise<Ip2LocationReader> | null = null

export function getR2Bucket(event: H3Event): R2Like {
  const { bucketBinding } = useRuntimeConfig(event).ip2location
  const env = (event.context as CloudflareContext).cloudflare?.env
  const bucket = env?.[bucketBinding] as R2Like | undefined

  if (!bucket || typeof bucket.get !== 'function') {
    throw createError({
      statusCode: 503,
      statusMessage: 'Database unavailable',
      message:
        `R2 binding "${bucketBinding}" is not available. Bind the bucket in ` +
        `wrangler.toml (and in the Pages project settings for deployments).`,
    })
  }
  return bucket
}

export function useIp2Location(event: H3Event): Promise<Ip2LocationReader> {
  const { binKey, cachePrefix, blockSize, maxBlocks } = useRuntimeConfig(event).ip2location
  const bucket = getR2Bucket(event)

  if (!source) {
    source = new R2ByteSource(bucket, binKey)
    cached = new CachedSource(source, {
      blockSize: Number(blockSize),
      maxBlocks: Number(maxBlocks),
      cacheKeyPrefix: cachePrefix || undefined,
    })
  } else {
    // Bindings are per-isolate objects; refresh rather than pin a stale one.
    source.rebind(bucket)
  }

  if (!readerPromise) {
    readerPromise = Ip2LocationReader.open(cached!).catch((error) => {
      // Never cache a failed open — the next request should retry.
      readerPromise = null
      throw error
    })
  }
  return readerPromise
}

/** Diagnostics for the health endpoint. */
export function getCacheStats() {
  return cached?.stats ?? { hits: 0, misses: 0, edgeHits: 0 }
}

/**
 * The caller's address. Cloudflare sets CF-Connecting-IP and it cannot be
 * spoofed by the client, so it is the only header trusted by default.
 */
export function getClientIp(event: H3Event): string | null {
  const cf = getRequestHeader(event, 'cf-connecting-ip')
  if (cf) return cf
  const forwarded = getRequestHeader(event, 'x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()
  return getRequestIP(event, { xForwardedFor: false }) ?? null
}
