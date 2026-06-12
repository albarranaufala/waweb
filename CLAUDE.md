# WhatsApp Multi-Profile Service

HTTP service that manages multiple WhatsApp accounts ("profiles") and sends messages on their behalf.

## Stack
- Node.js + TypeScript.
- WhatsApp: **whatsapp-web.js** — drives the real WhatsApp Web client in headless Chromium. **Never use Baileys** (it gets devices restricted).
- Auth: whatsapp-web.js **LocalAuth**, one `clientId` per profile (handles session persistence on disk).
- HTTP server: Express/Fastify. Accepts `application/json` and `multipart/form-data`.
- Storage: SQLite for profile metadata.

## Architecture (don't change without discussion)
- One long-running HTTP server is the entire app — **no separate CLI**.
- The server keeps every WhatsApp `Client` alive in memory in a registry keyed by profile id. This is required: WhatsApp Web needs a persistent connection, so short-lived processes can't hold a session.
- On boot, reload all profiles from SQLite and reconnect their clients.
- All operations are REST endpoints. Bind to localhost only.

## Running
- `npm run start` — boots the server and reconnects saved profiles.
- For persistent/background running: `pm2 start npm -- run start`.

## Conventions
- **Connection states**: use the enum `connecting | qr-pending | authenticated | connected | disconnected | logged-out | conflict`.
- **chatId**: normalize phone input to `<number>@c.us` (person) / `<id>@g.us` (group). Reject malformed input. Verify the target is a registered WhatsApp user before sending.
- **Sending**: one message is exactly one of text / media(+caption) / poll. Always send a typing indicator first, then a small randomized delay, then send.
- **Mentions**: the displayed text must contain an `@<number>` token AND the resolved contact id must be in the `mentions` option — both, or the tag won't render.
- **Media**: `MessageMedia` from upload/URL/base64; auto-detect image/video/file by mimetype; support an `asDocument` flag.
- **Polls**: use the `Poll` class; pin a recent whatsapp-web.js version and fail gracefully if a poll send breaks.

## Anti-ban (important)
Automating WhatsApp can get numbers restricted. Restriction risk is mostly about behavior, not the library. Keep per-message delays + jitter and the typing simulation configurable, and never bulk-blast unknown numbers.

## Out of scope (v1)
Receiving/reading incoming messages and group management. Leave clearly-marked extension points; don't build these unless asked.