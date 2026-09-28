import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, getCACertificates, type SecureContext } from "node:tls";
import { NetworkProxyError } from "./proxy-protocol.ts";

export interface ProxyCertificates {
	readonly bundlePath: string;
	context(hostname: string): Promise<SecureContext>;
	close(): Promise<void>;
}

/** The only persisted material is a public CA bundle, never an issuer or leaf private key. */
export async function createProxyCertificates(): Promise<ProxyCertificates> {
	await import("reflect-metadata");
	const x509 = await import("@peculiar/x509");
	const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
	let issuer: CryptoKeyPair | undefined = await crypto.subtle.generateKey(algorithm, false, ["sign", "verify"]);
	const notBefore = new Date(Date.now() - 60_000);
	const notAfter = new Date(Date.now() + 24 * 60 * 60_000);
	const authority = await x509.X509CertificateGenerator.createSelfSigned({
		name: "CN=mycli temporary network proxy", keys: issuer, signingAlgorithm: algorithm,
		serialNumber: randomBytes(16).toString("hex"), notBefore, notAfter,
		extensions: [new x509.BasicConstraintsExtension(true, 0, true),
			new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
			await x509.SubjectKeyIdentifierExtension.create(issuer.publicKey)],
	});
	const directory = await mkdtemp(join(tmpdir(), "mycli-proxy-ca-"));
	const bundlePath = join(directory, "ca.pem");
	try {
		await writeFile(bundlePath, [...getCACertificates("default"), authority.toString("pem")].join("\n"), { mode: 0o400, flag: "wx" });
	} catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
	const cache = new Map<string, Promise<SecureContext>>();
	let closing: Promise<void> | undefined;
	async function issue(hostname: string): Promise<SecureContext> {
		const signingKey = issuer?.privateKey;
		if (!signingKey) throw new NetworkProxyError(503, "Network proxy is closed.");
		const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
		const certificate = await x509.X509CertificateGenerator.create({
			subject: "CN=mycli proxied origin", issuer: authority.subject,
			publicKey: keys.publicKey, signingKey, signingAlgorithm: algorithm,
			serialNumber: randomBytes(16).toString("hex"), notBefore, notAfter,
			extensions: [new x509.BasicConstraintsExtension(false, undefined, true),
				new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
				new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
				new x509.SubjectAlternativeNameExtension([{ type: isIP(hostname) ? "ip" : "dns", value: hostname }])],
		});
		const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
		try {
			return createSecureContext({ key: `-----BEGIN PRIVATE KEY-----\n${privateKey.toString("base64")}\n-----END PRIVATE KEY-----`,
				cert: certificate.toString("pem"), minVersion: "TLSv1.2" });
		} finally { privateKey.fill(0); }
	}
	return Object.freeze({
		bundlePath,
		context: async (hostname: string): Promise<SecureContext> => {
			if (closing) throw new NetworkProxyError(503, "Network proxy is closed.");
			let pending = cache.get(hostname);
			if (!pending) {
				if (cache.size >= 64) throw new NetworkProxyError(503, "Network proxy certificate capacity exceeded.");
				pending = issue(hostname);
				cache.set(hostname, pending);
			}
			return pending;
		},
		close: (): Promise<void> => closing ??= (async () => {
			issuer = undefined;
			await Promise.allSettled(cache.values());
			cache.clear();
			await rm(directory, { recursive: true, force: true });
		})(),
	});
}
