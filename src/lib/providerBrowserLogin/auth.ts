import { createHash } from "node:crypto";
import { jwtVerify } from "jose";

/** No management API keys, disabled-login bypass, or forwarded identity headers. */
export async function browserLoginOwner(request: Request): Promise<string | null> {
  const configured = process.env.OMNIROUTE_BROWSER_LOGIN_ORIGIN;
  if (!configured || !process.env.JWT_SECRET) return null;
  let expected: URL;
  try {
    expected = new URL(configured);
  } catch {
    return null;
  }
  if (expected.protocol !== "https:" || expected.origin !== configured) return null;
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  if (origin !== configured) {
    if (request.method !== "GET" || origin || !referer) return null;
    try {
      if (new URL(referer).origin !== configured) return null;
    } catch {
      return null;
    }
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return null;
  const matches = (request.headers.get("cookie") || "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith("auth_token="));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(11);
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(process.env.JWT_SECRET), {
      algorithms: ["HS256"],
    });
    if (payload.authenticated !== true || typeof payload.exp !== "number") return null;
    return createHash("sha256").update(token).digest("hex");
  } catch {
    return null;
  }
}
