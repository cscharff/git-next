// Cloudflare Access in front of the deployed Worker, enforced in code as well: every non-local request must carry a
// valid Access JWT (Cf-Access-Jwt-Assertion header, or the CF_Authorization cookie) signed by the team's keys, for
// this application's audience, unexpired. Until ACCESS_AUD is configured, non-local requests are refused (fail closed).

export interface AccessConfig {
	teamDomain: string;
	aud: string;
	fetcher?: typeof fetch;
	now?: () => number;
}

interface Jwk extends JsonWebKey {
	kid: string;
}

let certCache: { team: string; keys: Jwk[]; at: number } | null = null;

const b64urlDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64urlDecode(s)));

async function teamKeys(cfg: AccessConfig, refresh = false): Promise<Jwk[]> {
	if (!refresh && certCache && certCache.team === cfg.teamDomain && Date.now() - certCache.at < 3600_000) return certCache.keys;
	const res = await (cfg.fetcher ?? fetch)(`https://${cfg.teamDomain}/cdn-cgi/access/certs`);
	if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
	const body = (await res.json()) as { keys?: Jwk[] };
	certCache = { team: cfg.teamDomain, keys: body.keys ?? [], at: Date.now() };
	return certCache.keys;
}

export function accessToken(request: Request): string | null {
	const header = request.headers.get("Cf-Access-Jwt-Assertion");
	if (header) return header;
	const cookie = request.headers.get("Cookie") ?? "";
	return cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1] ?? null;
}

/** Returns the verified token's claims, or null if the token is missing, malformed, unsigned by the team, expired or for another app. */
export async function verifyAccess(token: string | null, cfg: AccessConfig): Promise<{ email?: string; sub?: string; serviceToken?: string } | null> {
	if (!token || !cfg.aud || !cfg.teamDomain) return null;
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	let header: { kid?: string; alg?: string };
	let claims: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string; sub?: string; common_name?: string };
	try {
		header = json(parts[0]);
		claims = json(parts[1]);
	} catch {
		return null;
	}
	if (header.alg !== "RS256" || !header.kid) return null;
	let keys = await teamKeys(cfg);
	let jwk = keys.find((k) => k.kid === header.kid);
	if (!jwk) {
		keys = await teamKeys(cfg, true); // key rotation
		jwk = keys.find((k) => k.kid === header.kid);
	}
	if (!jwk) return null;
	const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
	const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
	if (!ok) return null;
	const now = Math.floor((cfg.now ?? Date.now)() / 1000);
	const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (claims.iss !== `https://${cfg.teamDomain}` || !auds.includes(cfg.aud) || !claims.exp || claims.exp < now || (claims.nbf && claims.nbf > now + 60)) return null;
	// Service tokens carry no email: Access puts the token's client id in common_name.
	return { email: claims.email, sub: claims.sub, ...(!claims.email && claims.common_name ? { serviceToken: claims.common_name } : {}) };
}

/**
 * Who a verified request is. `id` is what ADMIN_EMAILS is matched against: the email, or `service:<client id>` for a
 * service token. `name` is what goes in audit trails and on screen: the email, or a short label for a service token
 * (the full client id isn't needed to tell tokens apart and doesn't belong on a dashboard).
 */
export function identityOf(user: { email?: string; sub?: string; serviceToken?: string }): { id: string; name: string } {
	if (user.email) return { id: user.email, name: user.email };
	if (user.serviceToken) return { id: `service:${user.serviceToken}`, name: `service token ${user.serviceToken.slice(0, 6)}` };
	return { id: user.sub || "unknown", name: user.sub || "unknown" };
}

export function resetAccessCache() {
	certCache = null;
}
