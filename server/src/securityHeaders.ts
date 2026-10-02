import type { AppMode } from './config'

/**
 * The response headers that tell a browser how far to trust what this origin serves.
 *
 * Two policies, chosen by what a response is:
 *
 * - `document`  the app shell (HTML). It may load this origin's own scripts, styles,
 *               images and API, and nothing else. No inline script and no `eval`.
 * - `api`       everything else (JSON, and static files, which are never documents here).
 *               Such a response has no business loading or being framed by anything.
 *
 * Framing is same-origin only unless the operator lists exact parent origins in
 * `FRAME_ANCESTORS`. Nothing here is ever derived from a request.
 */
export interface SecurityHeaders {
  document: Record<string, string>
  api: Record<string, string>
}

export interface SecurityHeaderOptions {
  mode: AppMode
  /** Exact https:// origins allowed to frame the app, besides this origin itself. */
  frameAncestors: readonly string[]
  /** `Strict-Transport-Security` lifetime in seconds. Not sent in local mode. */
  hstsMaxAge: number
}

export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=()'

/** The app shell's Content-Security-Policy. */
export function documentCsp(options: Pick<SecurityHeaderOptions, 'mode' | 'frameAncestors'>): string {
  const directives = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    // data: and blob: are billboard images: stored as data URLs, and previewed from a local file while cropping.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    ["frame-ancestors 'self'", ...options.frameAncestors].join(' '),
  ]
  // Local mode is served over plain http://, where upgrading every request to https:// would break the page.
  if (options.mode !== 'local') directives.push('upgrade-insecure-requests')
  return directives.join('; ')
}

export const API_CSP = "default-src 'none'; frame-ancestors 'none'"

export function buildSecurityHeaders(options: SecurityHeaderOptions): SecurityHeaders {
  const common: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'permissions-policy': PERMISSIONS_POLICY,
    'cross-origin-opener-policy': 'same-origin-allow-popups',
  }
  // HSTS over plain http is ignored by browsers, and a developer machine must stay reachable on http://.
  // No includeSubDomains and no preload: both commit hosts this service does not control.
  if (options.mode !== 'local') common['strict-transport-security'] = `max-age=${options.hstsMaxAge}`

  const document: Record<string, string> = { ...common, 'content-security-policy': documentCsp(options) }
  // X-Frame-Options cannot name an allowed parent, so it is sent only while there is none to allow.
  if (options.frameAncestors.length === 0) document['x-frame-options'] = 'SAMEORIGIN'

  return { document, api: { ...common, 'content-security-policy': API_CSP, 'x-frame-options': 'DENY' } }
}
