function header(request, name) {
  const value = request.headers?.[name]
  return typeof value === 'string' ? value.trim() : ''
}

/** JSON plus a non-simple header protects desktop opaque origins from forms
 * and sandboxed pages. This endpoint must not answer cross-origin preflights. */
export function allowPluginRequest(request) {
  if (header(request, 'content-type').split(';')[0].toLowerCase() !== 'application/json') return false
  const origin = header(request, 'origin')
  const host = header(request, 'host').toLowerCase()
  const site = header(request, 'sec-fetch-site')
  const remote = request.socket?.remoteAddress
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)
  const desktop = origin === 'null' || /^app:\/\//i.test(origin) || origin === 'file://'
  if (desktop) return loopback && localHost && header(request, 'x-dsh-purge-client') === '1'
  if (site === 'cross-site') return false
  if (!origin) return loopback && localHost
  try {
    const url = new URL(origin)
    const protocol = request.socket?.encrypted ? 'https:' : 'http:'
    return url.protocol === protocol && url.host.toLowerCase() === host && !url.username && !url.password
  } catch { return false }
}
