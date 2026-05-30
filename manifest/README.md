# Slack app manifest

`slack-app.yaml` is the manifest for the bridge's bot. It's separate from the existing "FoC Conversation Archiver" (which is a user-token archiver, not modified by this work).

## Create the app

1. Visit https://api.slack.com/apps and click **Create New App** -> **From an app manifest**.
2. Pick the Feeling of Computing workspace.
3. Paste the contents of `slack-app.yaml`.
4. Click through, then **Install to Workspace** (needs workspace admin approval).
5. Copy the **Bot User OAuth Token** (`xoxb-...`) into the worker's secrets:
   ```sh
   cd ../packages/worker
   wrangler secret put SLACK_BOT_TOKEN
   wrangler secret put SLACK_SIGNING_SECRET
   ```
6. After the worker is deployed and reachable, return to the app config and set **Event Subscriptions -> Request URL** to `https://<your-worker-domain>/slack/events`. Slack will verify the URL with a challenge; the worker handles it.

## Inviting the bot into channels

The bot only sees messages in channels it has been invited to. From the FoC workspace, in each channel to bridge:

```
/invite @focbridge
```

You can script this with `conversations.invite` against the bot token if there are many channels.

## Updating the manifest

To change scopes or events later: edit `slack-app.yaml`, then in the Slack app UI go to **App Manifest** and paste the updated YAML. Slack will re-prompt for any new scopes on next install.
