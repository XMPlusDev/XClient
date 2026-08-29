import { lookupResponse } from '../../utils/respond'

export default defineEventHandler(async (event) => {
  const ip = decodeURIComponent(getRouterParam(event, 'ip') ?? '')
  return lookupResponse(event, ip)
})
