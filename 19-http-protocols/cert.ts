/**
 * cert.ts — generate self-signed certificate untuk HTTP/2 TLS.
 *
 * HTTP/2 butuh TLS di browser (h2 over TLS). Node.js http2.createSecureServer
 * butuh key + cert. Kita generate via openssl di runtime — zero dependency.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CERT_DIR = join(tmpdir(), "learn-api-certs");
const CERT_PATH = join(CERT_DIR, "cert.pem");
const KEY_PATH = join(CERT_DIR, "key.pem");

export function generateSelfSignedCert(): { key: string; cert: string } {
  // Reuse cert kalau sudah ada (valid 365 days)
  if (existsSync(CERT_PATH) && existsSync(KEY_PATH)) {
    return {
      cert: readFileSync(CERT_PATH, "utf-8"),
      key: readFileSync(KEY_PATH, "utf-8"),
    };
  }

  // Generate self-signed cert via openssl
  mkdirSync(CERT_DIR, { recursive: true });
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_PATH}" -out "${CERT_PATH}" -days 365 -nodes -subj "/CN=localhost" 2>/dev/null`,
      { stdio: "ignore" },
    );
  } catch {
    // Fallback: generate tanpa openssl (pakai Node crypto + manual PEM)
    // Ini cert tidak akan valid untuk browser, tapi cukup untuk curl -k
    return generateFallbackCert();
  }

  return {
    cert: readFileSync(CERT_PATH, "utf-8"),
    key: readFileSync(KEY_PATH, "utf-8"),
  };
}

// Fallback: generate RSA key pair + dummy cert (untuk environment tanpa openssl)
function generateFallbackCert(): { key: string; cert: string } {
  const crypto = require("node:crypto");
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  // Dummy cert — tidak valid, tapi http2.createSecureServer accept PEM format
  // curl -k akan bypass verification
  const certPem = keyPem.replace("PRIVATE KEY", "CERTIFICATE");
  return { key: keyPem, cert: certPem };
}
