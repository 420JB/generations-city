/**
 * Property media owner messages: short, plain text, and link-free. Viewers stay inside
 * Generations City, so a message may name a project or an @handle but never a URL.
 * Rendered as inert React text only (never HTML, never linkified).
 */
export const BILLBOARD_MESSAGE_MAX = 180

export const LINK_NOT_ALLOWED = "Links aren't allowed in property media messages. Use a project name or @handle instead."

const LINK_PATTERNS: readonly RegExp[] = [
  // Any scheme://… (http, https, ipfs, ftp, custom…)
  /\b[a-z][a-z0-9+.-]*:\/\//i,
  // Schemes that do not need slashes
  /\b(?:https?|mailto|javascript|vbscript|tel|sms|ftp|file|ipfs|ipns|magnet|blob|irc|wss?|web\+[a-z]+):/i,
  /\bdata:[a-z]+\//i,
  // www.example…
  /\bwww\d{0,3}\./i,
  // Markdown links and HTML anchors / tags
  /\]\s*\(/,
  /<\s*\/?\s*[a-z!][^>]*>/i,
  /\bhref\s*=/i,
  // Bare domains: example.com, foo.xyz, sub.example.co.uk, me@example.com
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]+)\b/i,
  // IPv4 addresses
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
]

/** True when text contains anything URL- or domain-like. */
export function containsLink(text: string): boolean {
  return LINK_PATTERNS.some((re) => re.test(text))
}

export type MessageValidation = { ok: true; value: string | null } | { ok: false; error: string }

/** Trim and validate an owner message. Empty means "no message". Never strips or rewrites content. */
export function validateBillboardMessage(raw: string): MessageValidation {
  const value = raw.replace(/\r\n?/g, '\n').trim()
  if (!value) return { ok: true, value: null }
  if (value.length > BILLBOARD_MESSAGE_MAX) return { ok: false, error: `Keep it to ${BILLBOARD_MESSAGE_MAX} characters.` }
  if (containsLink(value)) return { ok: false, error: LINK_NOT_ALLOWED }
  return { ok: true, value }
}
