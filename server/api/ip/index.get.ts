import { lookupResponse } from '../../utils/respond'
import { getClientIp } from '../../utils/ip2location'

/** GET /api/ip?ip=8.8.8.8 — falls back to the caller's own address. */
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const ip = String(query.ip ?? query.q ?? '').trim() || getClientIp(event)

  if (!ip) {
    throw createError({ statusCode: 400, statusMessage: 'Missing IP', message: 'Pass ?ip=<address>' })
  }
  return lookupResponse(event, ip)
})
