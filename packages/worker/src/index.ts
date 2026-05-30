// Cloudflare Worker entry point for the FoC Slack -> Colibri bridge.
//
// Two roles in one script:
//   - HTTP producer:  /slack/events handler. Verifies Slack's HMAC signature,
//                     enqueues the raw event payload, acks within Slack's 3s
//                     budget. Also handles the one-shot URL verification
//                     challenge during app setup.
//   - Queue consumer: drains EVENTS, derives Colibri records, putRecord on
//                     the bot's atproto repo. See packages/backfill/src/index.ts
//                     for the derivation logic that will be extracted into
//                     packages/shared/ once both surfaces need it.
//
// See feelingofcomputing/wiki PR #20 for the design.

export interface Env {
  // EVENTS: Queue<SlackEnvelope>;  // enable in wrangler.toml first
  // CACHE: D1Database;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  BSKY_HANDLE: string;
  BSKY_APP_PASSWORD: string;
}

interface SlackEnvelope {
  type: "event_callback" | "url_verification";
  challenge?: string;
  event_id?: string;
  team_id?: string;
  event?: unknown;
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/slack/events") {
      // TODO: verify X-Slack-Signature against env.SLACK_SIGNING_SECRET using
      // HMAC-SHA256 over `v0:${timestamp}:${rawBody}`.
      // TODO: handle url_verification challenge (respond with challenge string).
      // TODO: env.EVENTS.send(envelope) and return 200 within 3s.
      return new Response("not implemented", { status: 501 });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },

  async queue(
    batch: MessageBatch<SlackEnvelope>,
    _env: Env,
  ): Promise<void> {
    // TODO: for each message in batch:
    //   1. putRecord com.feelingof.bridge.slackRaw (lossless capture)
    //   2. derive social.colibri.message text+facets via the blocks walker
    //   3. putRecord social.colibri.message + slackOrigin
    //   4. for reactions: putRecord social.colibri.reaction
    //   5. for files: uploadBlob + reference in message.attachments[]
    // Ack the message on success; throw on transient failure so CF redelivers.
    for (const _msg of batch.messages) {
      // _msg.ack() / _msg.retry()
    }
  },
};
