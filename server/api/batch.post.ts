import { useIp2Location, Ip2LocationError, type Ip2LocationRecord } from '../utils/ip2location'
import { toHttpError } from '../utils/respond'

interface BatchBody {
  ips?: unknown
}

type BatchEntry = Ip2LocationRecord | { ip: string; error: string; code: string }

/** POST /api/batch  { "ips": ["8.8.8.8", "1.1.1.1"] } */
export default defineEventHandler(async (event) => {
  const { batchLimit } = useRuntimeConfig(event).ip2location
  const body = await readBody<BatchBody>(event)
  const ips = body?.ips

  if (!Array.isArray(ips) || ips.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid body',
      message: 'Expected { "ips": ["8.8.8.8", ...] }',
    })
  }
  if (ips.length > batchLimit) {
    throw createError({
      statusCode: 413,
      statusMessage: 'Too many addresses',
      message: `At most ${batchLimit} addresses per request (got ${ips.length}).`,
    })
  }

  let reader
  try {
    reader = await useIp2Location(event)
  } catch (error) {
    throw toHttpError(error)
  }

  // Sequential on purpose: lookups share the block cache, so running them in
  // order lets later addresses hit blocks the earlier ones just pulled.
  const results: BatchEntry[] = []
  for (const raw of ips) {
    const ip = String(raw)
    try {
      results.push(await reader.lookup(ip))
    } catch (error) {
      const code = error instanceof Ip2LocationError ? error.code : 'ERROR'
      results.push({ ip, error: (error as Error).message, code })
    }
  }

  return { count: results.length, results }
})
