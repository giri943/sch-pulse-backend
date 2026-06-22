/* Unit checks for classify() against synthetic WAF responses. */
import { classify, type Classification } from "../services/monitoring/classify";

let pass = 0;
let fail = 0;
function check(name: string, got: { classification: Classification; up: boolean; waf: string | null }, wantClass: Classification, wantUp: boolean, wantWaf: string | null) {
  const ok = got.classification === wantClass && got.up === wantUp && got.waf === wantWaf;
  console.log(`${ok ? "✓" : "✗"} ${name}: ${got.classification} up=${got.up} waf=${got.waf}${ok ? "" : `  (wanted ${wantClass}/${wantUp}/${wantWaf})`}`);
  ok ? pass++ : fail++;
}
const H = (o: Record<string, string>) => new Headers(o);

// Healthy
check("plain 200", classify({ status: 200 }), "up", true, null);
check("expected 204", classify({ status: 204, expectedStatus: 204 }), "up", true, null);
check("content missing on 200", classify({ status: 200, contentMatch: false }), "content_mismatch", false, null);

// Cloudflare
check("CF challenge (Just a moment)", classify({ status: 503, headers: H({ "cf-ray": "abc", server: "cloudflare" }), bodySample: "<title>Just a moment...</title>" }), "up_challenged", true, "cloudflare");
check("CF block 403", classify({ status: 403, headers: H({ "cf-ray": "abc", server: "cloudflare" }), bodySample: "Attention Required! | Cloudflare" }), "up_blocked", true, "cloudflare");
check("CF 521 origin down", classify({ status: 521, headers: H({ "cf-ray": "abc", server: "cloudflare" }) }), "down_origin", false, "cloudflare");

// F5 BIG-IP (vantara-style)
check("F5 TS cookie challenge (redirect)", classify({ status: 307, redirected: true, headers: H({ location: "/en" }), setCookies: ["TS015d8eb0=0138efca; Path=/; Domain=.vantara.in"] }), "up_challenged", true, "f5-bigip");
check("F5 TS on healthy direct 200", classify({ status: 200, setCookies: ["TS015d8eb0=abc; Path=/"] }), "up", true, null);
check("F5 request rejected", classify({ status: 200, bodySample: "The requested URL was rejected. Please consult with... support id" }), "up_blocked", true, "f5-bigip");

// Akamai
check("Akamai access denied", classify({ status: 403, headers: H({ server: "AkamaiGHost" }), bodySample: "Access Denied" }), "up_blocked", true, "akamai");

// Imperva (200 block page)
check("Imperva incident 200", classify({ status: 200, headers: H({ "x-iinfo": "1-234" }), bodySample: "Request unsuccessful. Incapsula incident ID: 123" }), "up_blocked", true, "imperva");

// AWS WAF
check("AWS WAF 403", classify({ status: 403, headers: H({ "x-amzn-waf-action": "block" }) }), "up_blocked", true, "aws-waf");

// Sucuri
check("Sucuri block", classify({ status: 403, headers: H({ "x-sucuri-id": "1" }), bodySample: "Sucuri WebSite Firewall" }), "up_blocked", true, "sucuri");

// Genuine failures (no WAF)
check("500 origin error", classify({ status: 500 }), "down_origin", false, null);
check("404 unexpected", classify({ status: 404 }), "down_origin", false, null);
check("DNS fail", classify({ errorCode: "ENOTFOUND" }), "dns_failed", false, null);
check("conn refused", classify({ errorCode: "ECONNREFUSED" }), "down_network", false, null);
check("TLS expired", classify({ errorCode: "CERT_HAS_EXPIRED" }), "tls_failed", false, null);
check("timeout", classify({ errorCode: "Request timed out" }), "timeout", false, null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
