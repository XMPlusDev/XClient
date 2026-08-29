import { useIp2Location, getCacheStats } from '../utils/ip2location'
import { toHttpError } from '../utils/respond'

/** GET /api/health — BIN metadata plus this isolate's cache counters. */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  try {
    const reader = await useIp2Location(event)
    return { status: 'ok', database: reader.meta, cache: getCacheStats() }
  } catch (error) {
    throw toHttpError(error)
  }
})
