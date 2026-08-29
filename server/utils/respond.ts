/**
 * Shared response shaping for the lookup endpoints.
 */
import type { H3Event } from 'h3'
import { Ip2LocationError, useIp2Location, type Ip2LocationRecord } from './ip2location'

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_IP: 400,
  IPV6_UNSUPPORTED: 501,
  NOT_FOUND: 404,
  INVALID_BIN: 500,
  UNSUPPORTED_DB: 500,
}

export function toHttpError(error: unknown): Error {
  if (error instanceof Ip2LocationError) {
    return createError({
      statusCode: STATUS_BY_CODE[error.code] ?? 500,
      statusMessage: error.code,
      message: error.message,
      data: { code: error.code },
    })
  }
  return error as Error
}

/** `?fields=countryCode,city` trims the payload to what the caller asked for. */
function pickFields(record: Ip2LocationRecord, fields: string | undefined): Ip2LocationRecord {
  if (!fields) return record
  const wanted = new Set(
    fields
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean),
  )
  if (wanted.size === 0) return record

  const out: Record<string, unknown> = {
    ip: record.ip,
    ipNumber: record.ipNumber,
    ipVersion: record.ipVersion,
  }
  for (const key of wanted) {
    if (key in record) out[key] = (record as Record<string, unknown>)[key]
  }
  return out as Ip2LocationRecord
}

export async function lookupResponse(event: H3Event, ip: string): Promise<Ip2LocationRecord> {
  const { cacheMaxAge } = useRuntimeConfig(event).ip2location
  try {
    const reader = await useIp2Location(event)
    const record = await reader.lookup(ip)

    // The BIN only changes on redeploy, so answers are safe to cache hard.
    setResponseHeader(event, 'cache-control', `public, max-age=${cacheMaxAge}`)
    return pickFields(record, getQuery(event).fields as string | undefined)
  } catch (error) {
    throw toHttpError(error)
  }
}
