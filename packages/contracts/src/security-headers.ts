/** Shared browser protections for the web and API processes. */
export function securityHeaders(https: boolean): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    // Router hydration, the theme bootstrap and inline styles still require inline allowances.
    // Sanitization remains the primary protection against untrusted HTML/script content.
    "Content-Security-Policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; form-action 'self'" + (https ? "; upgrade-insecure-requests" : ""),
    ...(https ? { "Strict-Transport-Security": "max-age=15552000" } : {}),
  };
}
