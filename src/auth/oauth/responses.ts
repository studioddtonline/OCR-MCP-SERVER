export function html(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function page(title: string, body: string, formAction = "'self'", status = 200): Response {
  return new Response(
    `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title><body style="font:16px system-ui;max-width:42rem;margin:3rem auto;padding:0 1rem"><h1>${html(title)}</h1>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "content-security-policy":
          `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
      },
    },
  );
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization",
    },
  });
}

export function oauthError(error: string, status = 400): Response {
  return json({ error }, status);
}

export function formBody(request: Request): Promise<URLSearchParams> {
  return request.text().then((text) => new URLSearchParams(text));
}

export function originIsExpected(request: Request, base: string): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(base).origin;
}
