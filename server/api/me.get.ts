import { lookupResponse } from '../utils/respond'
import { getClientIp } from '../utils/ip2location'

/** GET /api/me — geolocates whoever is calling. */
export default defineEventHandler(async (event) => {
  const ip = getClientIp(event)
  if (!ip) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Unknown client IP',
      message: 'No CF-Connecting-IP header on this request.',
    })
  }

  const record = await lookupResponse(event, ip)
  // Per-caller answer, so it must not land in a shared cache.
  setResponseHeader(event, 'cache-control', 'private, no-store')
  return record
})
