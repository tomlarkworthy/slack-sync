// Cloudflare Worker entry for the FoC Slack -> Colibri bridge.
//
// First-deploy goals: respond to Slack's URL-verification challenge so the
// app manifest passes validation, and accept (and discard) real event
// callbacks with 200. HMAC verification, queueing, and atproto publish all
// land in follow-ups; this file is intentionally the smallest thing that
// gets us a public request_url for the Slack app.

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
  event?: unknown;
}

type SlackEnvelope = SlackUrlVerification | SlackEventCallback;

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
    }

    if (request.method === "POST" && url.pathname === "/slack/events") {
      const rawBody = await request.text();
      let envelope: SlackEnvelope;
      try {
        envelope = JSON.parse(rawBody) as SlackEnvelope;
      } catch {
        return new Response("invalid json", { status: 400 });
      }

      // URL verification fires once when the app's Request URL is set or
      // changed. Respond with the challenge string in plain text. No HMAC
      // check here — Slack does sign url_verification requests, but on first
      // configuration the signing-secret-to-app coupling is exactly what
      // we're proving, so it's fine to short-circuit.
      if (envelope.type === "url_verification") {
        return new Response(envelope.challenge, {
          headers: { "Content-Type": "text/plain" },
        });
      }

      // Real event: log + ack. HMAC verify + enqueue lands in the next pass.
      if (envelope.type === "event_callback") {
        console.log(
          "event_callback",
          envelope.event_id ?? "?",
          envelope.team_id ?? "?",
          (envelope.event as { type?: string } | undefined)?.type ?? "?",
        );
        return new Response("ok");
      }

      return new Response("unknown envelope type", { status: 400 });
    }

    return new Response("not found", { status: 404 });
  },
};
