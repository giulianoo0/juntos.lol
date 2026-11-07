import { ANY_HOST, type ExtensionManifest } from './manifest'

const HCAPTCHA = 'https://hcaptcha.com https://*.hcaptcha.com'

export function cspFor(m: ExtensionManifest, juntosOrigins: string[]): string {
  // Any host is any https origin; http stays out, as do other schemes.
  const https = (hosts: string[]) => hosts.includes(ANY_HOST) ? ' https:' : hosts.map((h) => ` https://${h}`).join('')
  const captcha = m.captcha === 'hcaptcha'
  return [
    "default-src 'self'",
    `script-src 'self'${captcha ? ' https://js.hcaptcha.com https://*.hcaptcha.com' : ''}`,
    `style-src 'self'${captcha ? ` ${HCAPTCHA}` : ''}`,
    // hCaptcha's script fetches from per-site subdomains (`<hash>.w.hcaptcha.com`).
    `connect-src 'self'${https(m.hosts.connect)}${captcha ? ` ${HCAPTCHA}` : ''}`,
    `img-src 'self' data:${https(m.hosts.images)}`,
    `frame-src ${captcha ? HCAPTCHA : "'none'"}`,
    `frame-ancestors ${juntosOrigins.join(' ')}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ')
}

export function securityHeaders(m: ExtensionManifest, juntosOrigins: string[]): Headers {
  return new Headers({
    'content-security-policy': cspFor(m, juntosOrigins),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
  })
}
