# Claude Code Prompt — WhatsApp Multi-Profile Service

Build an HTTP service to manage multiple WhatsApp accounts ("profiles") and run messaging operations against them via REST endpoints.

## Stack
- Node.js + TypeScript.
- WhatsApp library: **whatsapp-web.js** — it drives the real WhatsApp Web client in headless Chromium, so it behaves like a genuine linked device. Do NOT use Baileys.
- Use the library's **LocalAuth** strategy with a unique `clientId` per profile for automatic session persistence.
- HTTP server: Express or Fastify. Support `multipart/form-data` (for file uploads) and `application/json`.
- Storage: **SQLite** for profile metadata; LocalAuth handles per-profile session files on disk.

## Architecture
A single long-running HTTP server is the whole thing — no separate CLI process.
- `npm run start` boots the server. On boot it reloads every saved profile and reconnects its WhatsApp client.
- The server keeps all live WhatsApp clients in memory for the lifetime of the process (this is required — WhatsApp Web needs a persistent connection).
- Each profile is one whatsapp-web.js `Client` instance (its own Chromium). Manage them in a registry keyed by profile id.
- All operations are REST endpoints. Bind to localhost only.
- Provide an npm script note: for background/persistent running, the user can wrap it with `pm2 start npm -- run start`.

## Endpoints
1. `GET /profiles` — all profiles: id, name/label, phone number (if known), connection state.
2. `GET /profiles/:id` — detailed state: connection state, last connected time, linked device info, last error.
3. `POST /profiles` — create a profile and start a new client. Return the **QR as a data URL / ASCII** so the caller can scan it; refresh/replace the QR as it expires; persist creds on success so no re-scan is needed later. Expose a way to poll QR + auth status (e.g. `GET /profiles/:id/qr`).
4. `DELETE /profiles/:id?logout=true` — remove local profile data. With `logout=true`, call the client's logout first to unlink the device from WhatsApp before deleting.
5. `POST /profiles/:id/messages` — unified send endpoint. Body fields:
   - `target` (required) — person (phone number) or group id; normalize to chatId.
   - `text` (optional) — message body, or caption when sending media.
   - `mentions` (optional array of phone numbers) — tag people. The displayed `text` must contain an `@<number>` token for each mention; resolve each number to its contact id and pass them via the library's `mentions` option. (Mentions render in groups.)
   - `media` (optional) — an attachment, provided as a `multipart/form-data` file upload OR a URL OR base64. Build a `MessageMedia`; image/video/file is auto-detected by mimetype. Support an `asDocument` flag to force sending as a plain file/document.
   - `poll` (optional) — `{ question, options[], allowMultipleAnswers }`, sent via the `Poll` class.
   - **Validation**: exactly one of `text` / `media` / `poll` is the primary content (media+caption counts as one; mentions may accompany text or a caption). Reject combinations that aren't valid as a single WhatsApp message.
   - Before sending: verify the target is registered on WhatsApp, send a **typing indicator**, apply a small randomized delay, then return the send result.
6. `GET /profiles/:id/chats` — all chats (people + groups): type, name, last-message timestamp.
7. `GET /profiles/:id/chats?q=<query>` — search chats by name/number across people and groups.

## Connection states
Explicit enum surfaced in the profile endpoints: `connecting`, `qr-pending`, `authenticated`, `connected`, `disconnected`, `logged-out`, `conflict`.

## Cross-cutting requirements
- **Session persistence**: reload and reconnect all profiles on server start (LocalAuth + SQLite metadata).
- **Reconnect / logout**: handle disconnects with backoff; if WhatsApp forces logout, mark `logged-out` and require a fresh QR (don't loop forever).
- **Number / chatId handling**: normalize phone input to whatsapp-web.js chat ids (`<number>@c.us` for people, `<id>@g.us` for groups); reject malformed input clearly; use the library's registered-user check before sending.
- **Anti-ban**: configurable per-message delay + jitter, typing simulation, and a hard warning in the README that automating WhatsApp can get numbers restricted — restriction risk is mostly about behavior (volume, speed, messaging unknown numbers), not just the library.
- **Logging**: structured logs per profile.
- **Config**: single config file / env for data dir, port, delays, max upload size.
- **Graceful shutdown**: destroy all clients cleanly on server stop.

## Deliverables
- Project scaffold with server, client-registry, and storage layers separated.
- README: setup, `npm run start`, the pm2 note, all endpoints with example curl calls (including a multipart media-send example and a poll example), and the restriction-risk warning.
- `.env.example` / config sample.

## Out of scope (v1)
Receiving/reading incoming messages and group management (creating/editing groups) — leave clearly-marked extension points in the code so they're easy to add later.