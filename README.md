# Self-hosted IP2Location API

A Nuxt 4 app whose Nitro server routes read an IP2Location **BIN** database
directly, deployed serverless on **Cloudflare Pages**. No third-party geo API,
no database server, no per-query billing — just your own BIN file in R2.

Currently wired to `IP2LOCATION-LITE-DB5.IPV6.BIN` (2025-08-15): 2.95M IPv4 and
2.85M IPv6 ranges, 175 MB, returning country, region, city and coordinates.

## How it works

Cloudflare Workers have no filesystem, so the BIN lives in R2 and is read with
**ranged GETs** — it is never loaded into memory.

The BIN layout makes that cheap:

```
[64-byte header][65536×8B IPv4 index][65536×8B IPv6 index]
[IPv4 rows, fixed width, sorted by ip_from][IPv6 rows][string pool]
```

A lookup is three steps:

1. **Index bucket** — the top 16 bits of the address point at an 8-byte entry
   giving the first and last candidate row. For this DB that narrows 2.95M rows
   to ~45.
2. **One windowed read** — those ~45 rows are ~1 KB, so the whole candidate
   window is fetched in a single read and binary-searched in memory. That
   replaces the ~22 sequential round trips a naive binary search would make.
3. **String pool** — the matched row holds 4-byte pointers; latitude and
   longitude are stored inline as float32.

Every read goes through a two-tier block cache (32 KB blocks): an in-isolate
LRU, then the colo-local Cache API. Cold lookups cost 2–3 R2 reads; warm ones
usually cost zero.

Measured against the real file (`npm run test:bin`):

```
8.8.8.8              v4 US  Mountain View, California  [37.386051, -122.083847]   3 reads
1.1.1.1              v4 AU  Brisbane, Queensland       [-27.467541, 153.028091]   3 reads
2001:4860:4860::8888 v6 US  Mountain View, California  [37.386051, -122.083847]  11 reads
500 lookups: 0.04ms each once warm
```

`::ffff:8.8.8.8`, 6to4 (`2002::/16`) and Teredo (`2001::/32`) addresses are
unwrapped to their embedded IPv4 address, matching IP2Location's own readers.

## Setup

```bash
npm install
```

Create the bucket and upload the BIN (validates the header before spending the
transfer):

```bash
npx wrangler r2 bucket create ip2location
npm run bin:remote
```

For local development, the same file goes into the miniflare-backed bucket:

```bash
npm run bin:local
npm run dev
```

`nitro-cloudflare-dev` gives `nuxt dev` the same `IP2LOCATION` R2 binding that
Pages injects in production, so dev and prod take an identical code path.

## Deploy

```bash
npm run deploy
```

The R2 binding must also exist on the Pages project itself — in the dashboard:
**Settings → Bindings → R2 bucket**, variable name `IP2LOCATION`, bucket
`ip2location`. A binding declared only in `wrangler.toml` covers local dev and
`wrangler pages deploy`, but a Git-connected Pages build needs it configured on
the project.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /api/ip/:ip` | Look up one address |
| `GET /api/ip?ip=…` | Same, query-string form; omit `ip` to use the caller's |
| `GET /api/me` | Geolocate the caller (`CF-Connecting-IP`) |
| `POST /api/batch` | `{ "ips": [...] }`, up to 100 per request |
| `GET /api/health` | BIN metadata and cache counters |

```bash
curl https://location.xmplus.dev/api/ip/8.8.8.8
```

```json
{
  "ip": "8.8.8.8",
  "ipNumber": "134744072",
  "ipVersion": 4,
  "countryCode": "US",
  "countryName": "United States of America",
  "region": "California",
  "city": "Mountain View",
  "latitude": 37.386051,
  "longitude": -122.083847
}
```

Add `?fields=countryCode,city` to trim the payload. Unknown values come back as
`null` rather than IP2Location's `"-"`, and reserved ranges get `null`
coordinates instead of `0, 0`.

Errors are JSON with a stable `code`: `INVALID_IP` (400), `NOT_FOUND` (404),
`IPV6_UNSUPPORTED` (501).

## Using a different BIN

The reader handles **DB1–DB26**, IPv4-only or IPv6 files, LITE or commercial —
it reads the database type from the header and works out which columns exist, so
a DB11 or DB23 file starts returning ZIP code, timezone, ISP or usage type with
no code change.

```bash
node scripts/upload-bin.mjs --remote --file IP2LOCATION-LITE-DB11.IPV6.BIN
```

Then in `nuxt.config.ts` point `binKey` at the new object and **bump
`cachePrefix`** — otherwise the Cache API keeps serving 32 KB blocks from the
previous file, which will silently return garbage.

An `.IPV6.BIN` file contains both the IPv4 and IPv6 tables; the IPv4-only
variant answers `IPV6_UNSUPPORTED` for v6 addresses.

## Configuration

All under `runtimeConfig.ip2location` in `nuxt.config.ts`, overridable with
`NUXT_IP2LOCATION_*` environment variables:

| Key | Default | Notes |
| --- | --- | --- |
| `bucketBinding` | `IP2LOCATION` | R2 binding name |
| `binKey` | `IP2LOCATION-LITE-DB5.IPV6.BIN` | Object key |
| `cachePrefix` | `lite-db5-ipv6-20250815` | Bump on every BIN change |
| `blockSize` | `32768` | Ranged-read granularity |
| `maxBlocks` | `192` | ~6 MB of blocks per isolate |
| `cacheMaxAge` | `86400` | `max-age` on lookup responses |
| `batchLimit` | `100` | Addresses per batch request |

## Licensing

The LITE databases are free under CC-BY-SA 4.0 and require attribution. This
repository does not include the BIN — download it from
[lite.ip2location.com](https://lite.ip2location.com) and upload it to your own
bucket.
