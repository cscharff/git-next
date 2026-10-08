import { beforeAll, describe, expect, it } from "vitest";
import { accessToken, identityOf, resetAccessCache, verifyAccess } from "../src/access.ts";

const team = "example.cloudflareaccess.com";
const aud = "aud-tag-123";
let privateKey: CryptoKey;
let jwk: JsonWebKey;
const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

async function sign(claims: Record<string, unknown>, kid = "k1", key = privateKey) {
	const head = b64url(JSON.stringify({ alg: "RS256", kid }));
	const body = b64url(JSON.stringify(claims));
	const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`)));
	return `${head}.${body}.${b64url(sig)}`;
}
const fetcher = (async () => Response.json({ keys: [{ ...jwk, kid: "k1" }] })) as unknown as typeof fetch;
const cfg = { teamDomain: team, aud, fetcher, now: () => 1_800_000_000_000 };
const good = { iss: `https://${team}`, aud: [aud], exp: 1_800_000_600, email: "member@example.com" };

beforeAll(async () => {
	const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	privateKey = pair.privateKey;
	jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
	resetAccessCache();
});

describe("verifyAccess", () => {
	it("accepts a token signed by the team for this audience", async () => {
		expect(await verifyAccess(await sign(good), cfg)).toEqual({ email: "member@example.com", sub: undefined });
	});

	it("reports a service token's client id (Access leaves its email empty)", async () => {
		expect(await verifyAccess(await sign({ ...good, email: "", sub: "", common_name: "abc123.access" }), cfg)).toEqual({ email: "", sub: "", serviceToken: "abc123.access" });
	});

	it("rejects missing, expired, wrong-audience, wrong-issuer, unknown-key and tampered tokens", async () => {
		expect(await verifyAccess(null, cfg)).toBeNull();
		expect(await verifyAccess(await sign({ ...good, exp: 1_799_999_000 }), cfg)).toBeNull();
		expect(await verifyAccess(await sign({ ...good, aud: ["other"] }), cfg)).toBeNull();
		expect(await verifyAccess(await sign({ ...good, iss: "https://evil.example" }), cfg)).toBeNull();
		expect(await verifyAccess(await sign(good, "unknown"), cfg)).toBeNull();
		const [h, , s] = (await sign(good)).split(".");
		expect(await verifyAccess(`${h}.${b64url(JSON.stringify({ ...good, email: "attacker@example.com" }))}.${s}`, cfg)).toBeNull();
		expect(await verifyAccess(await sign(good), { ...cfg, aud: "" })).toBeNull(); // not configured: fail closed
	});

	it("reads the token from the header or the CF_Authorization cookie", () => {
		expect(accessToken(new Request("https://x", { headers: { "Cf-Access-Jwt-Assertion": "a.b.c" } }))).toBe("a.b.c");
		expect(accessToken(new Request("https://x", { headers: { Cookie: "x=1; CF_Authorization=d.e.f" } }))).toBe("d.e.f");
		expect(accessToken(new Request("https://x"))).toBeNull();
	});
});

describe("identityOf", () => {
	it("uses the email, or service:<client id> for a service token (with a short name for audit trails)", async () => {
		expect(identityOf({ email: "a@example.com" })).toEqual({ id: "a@example.com", name: "a@example.com" });
		expect(identityOf({ email: "", serviceToken: "abc123def456.access" })).toEqual({ id: "service:abc123def456.access", name: "service token abc123" });
		expect(identityOf({ sub: "s-1" })).toEqual({ id: "s-1", name: "s-1" });
	});
});
