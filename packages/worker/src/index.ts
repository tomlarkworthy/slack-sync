// Cloudflare Worker entry for the FoC Slack -> Colibri bridge.
//
// Surface today:
//   - GET  /health           liveness check
//   - POST /slack/events     Slack Events API receiver, HMAC-verified
//
// HMAC verification is conditional on SLACK_SIGNING_SECRET being set. If it
// isn't (initial deploy before the secret has been pushed via
// `wrangler secret put`), we skip the check so url_verification still works
// during app bring-up. As soon as the secret is configured, every request
// must carry a valid v0= signature within Slack's 5-minute timestamp window.
//
// Real-event processing (enqueue -> consume -> atproto publish) lands once
// the queue binding is created and the consumer is implemented.

export interface Env {
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  BSKY_HANDLE?: string;
  BSKY_APP_PASSWORD?: string;
}

interface SlackUrlVerification {
  type: "url_verification";
  token: string;
  challenge: string;
}

interface SlackEventCallback {
  type: "event_callback";
  team_id?: string;
  event_id?: string;
  event_time?: number;
  event?: { type?: string; channel?: string; user?: string; ts?: string };
}

type SlackEnvelope = SlackUrlVerification | SlackEventCallback;

// Slack signs each request with HMAC-SHA256 over `v0:{timestamp}:{rawBody}`,
// keyed by the app's signing secret, hex-encoded. We reject anything older
// than 5 minutes to block replays.
async function verifySlackSignature(
  rawBody: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  signingSecret: string,
): Promise<boolean> {
  if (!timestampHeader || !signatureHeader) return false;
  if (!signatureHeader.startsWith("v0=")) return false;

  const ts = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 60 * 5) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`v0:${timestampHeader}:${rawBody}`),
  );
  const computed =
    "v0=" +
    Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  // constant-time compare
  if (computed.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
    }

    if (request.method === "POST" && url.pathname === "/slack/events") {
      const rawBody = await request.text();

      // Verify Slack signature when the secret has been configured. Until
      // then (pre-`wrangler secret put`), accept unsigned requests so the
      // first url_verification check during app setup can pass.
      if (env.SLACK_SIGNING_SECRET) {
        const ok = await verifySlackSignature(
          rawBody,
          request.headers.get("X-Slack-Request-Timestamp"),
          request.headers.get("X-Slack-Signature"),
          env.SLACK_SIGNING_SECRET,
        );
        if (!ok) {
          console.warn("rejected: bad slack signature");
          return new Response("invalid signature", { status: 401 });
        }
      }

      let envelope: SlackEnvelope;
      try {
        envelope = JSON.parse(rawBody) as SlackEnvelope;
      } catch {
        return new Response("invalid json", { status: 400 });
      }

      if (envelope.type === "url_verification") {
        return new Response(envelope.challenge, {
          headers: { "Content-Type": "text/plain" },
        });
      }

      if (envelope.type === "event_callback") {
        const ev = envelope.event;
        console.log(
          "event",
          envelope.event_id ?? "?",
          ev?.type ?? "?",
          "channel=" + (ev?.channel ?? "?"),
          "user=" + (ev?.user ?? "?"),
          "ts=" + (ev?.ts ?? "?"),
        );
        return new Response("ok");
      }

      return new Response("unknown envelope type", { status: 400 });
    }

    return new Response("not found", { status: 404 });
  },
};
