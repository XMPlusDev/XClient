export default defineNuxtConfig({
  compatibilityDate: '2025-08-25',
  devtools: { enabled: false },

  // Gives `nuxt dev` the same R2 binding that Pages injects in production,
  // backed by miniflare and the bucket declared in wrangler.toml.
  modules: ['nitro-cloudflare-dev'],

  nitro: {
    preset: 'cloudflare-pages',
  },

  runtimeConfig: {
    ip2location: {
      /** R2 binding name — must match wrangler.toml and the Pages settings. */
      bucketBinding: 'IP2LOCATION',
      /** Object key of the BIN inside that bucket. */
      binKey: 'IP2LOCATION-LITE-DB5.IPV6.BIN',
      /**
       * Namespace for the Cache API block layer. Bump this whenever a new BIN
       * is uploaded, otherwise stale blocks from the old file get served.
       */
      cachePrefix: 'lite-db5-ipv6-20260815',
      /** Ranged-read granularity, in bytes. */
      blockSize: 32768,
      /** Blocks held per isolate (blockSize * maxBlocks is the memory cap). */
      maxBlocks: 192,
      /** max-age for successful lookups, in seconds. */
      cacheMaxAge: 86400,
      /** Addresses accepted by POST /api/batch. */
      batchLimit: 100,
    },
  },

  routeRules: {
    '/api/**': { cors: true },
  },
})
