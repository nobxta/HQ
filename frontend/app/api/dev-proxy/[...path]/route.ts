import { NextRequest, NextResponse } from "next/server";

/**
 * Same-origin dev proxy — LOCAL DEV ONLY.
 *
 * The browser calls /api/dev-proxy/<path> on localhost (same origin, so no CORS), and this
 * handler forwards the request server-to-server to the backend named in the `x-dev-api-base`
 * header. CORS never applies to server-to-server calls, so pointing the frontend at the VPS
 * works no matter what the VPS's CORS config is — and no VPS change is needed.
 *
 * Safety:
 *  - Disabled entirely outside `next dev` (returns 404 in production builds), so it can't be
 *    abused for SSRF on the live site.
 *  - The forward target is checked against an allowlist (localhost / *.hqadz.io).
 */

const ALLOWED_ORIGINS: RegExp[] = [
  /^https?:\/\/localhost:\d+$/,
  /^https?:\/\/127\.0\.0\.1:\d+$/,
  /^https:\/\/([a-z0-9-]+\.)?hqadz\.io$/,
];

function isAllowed(base: string): boolean {
  try {
    return ALLOWED_ORIGINS.some((re) => re.test(new URL(base).origin));
  } catch {
    return false;
  }
}

async function handler(
  req: NextRequest,
  ctx: { params: { path?: string[] } }
) {
  if (process.env.NODE_ENV !== "development") {
    return new NextResponse("Not found", { status: 404 });
  }

  const base = (req.headers.get("x-dev-api-base") || "").replace(/\/+$/, "");
  if (!isAllowed(base)) {
    return NextResponse.json(
      { detail: "Dev proxy: backend not in allowlist" },
      { status: 400 }
    );
  }

  const path = (ctx.params.path || []).join("/");
  const target = `${base}/${path}${req.nextUrl.search}`;

  // Forward only what the backend needs — never the NextAuth session cookie.
  const fwd: Record<string, string> = {};
  const auth = req.headers.get("authorization");
  if (auth) fwd["authorization"] = auth;
  const contentType = req.headers.get("content-type");
  if (contentType) fwd["content-type"] = contentType;

  const method = req.method.toUpperCase();
  const body =
    method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers: fwd,
      body,
      redirect: "manual",
      cache: "no-store",
    });
  } catch (e: any) {
    return NextResponse.json(
      { detail: `Dev proxy: cannot reach backend (${e?.message || e})` },
      { status: 502 }
    );
  }

  const outHeaders = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) outHeaders.set("content-type", ct);
  return new NextResponse(await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: outHeaders,
  });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const dynamic = "force-dynamic";
