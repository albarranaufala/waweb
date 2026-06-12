# waweb — WhatsApp Multi-Profile Service

A single long-running HTTP service that manages multiple WhatsApp accounts
("profiles") and sends messages on their behalf. Each profile is a real linked
device driven by [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)
in headless Chromium.

> ## ⚠️ Read this first — automating WhatsApp can get your number restricted
>
> WhatsApp does not permit unofficial automation. **Numbers can be temporarily or
> permanently banned.** The risk is driven mostly by *behaviour*, not the library:
>
> - **Volume & speed** — bursts of messages look like spam. Keep it slow.
> - **Messaging unknown numbers** — sending to people who never contacted you is
>   the single biggest trigger.
> - **Identical / bulk content** — vary messages; never blast.
>
> This service applies a randomized per-message delay and a typing indicator by
> default (configurable), but **that is not a guarantee**. Use a number you can
> afford to lose, message only people who expect to hear from you, and start slow.
> You are responsible for compliance with WhatsApp's Terms of Service.

---

## Stack

- **Node.js + TypeScript**
- **whatsapp-web.js** with **LocalAuth** — one `clientId` per profile; sessions
  persist on disk so you only scan a QR once.
- **Express** HTTP server (accepts `application/json` and `multipart/form-data`).
- **SQLite** (`better-sqlite3`) for profile metadata.

## Architecture

```
src/
  config.ts            env / config (port, data dir, delays, upload size, ...)
  logger.ts            pino structured logging (per-profile child loggers)
  types.ts             ConnectionState enum + shared types
  errors.ts            ApiError (HTTP status-carrying error)
  store.ts             SQLite profile-metadata layer
  wa/
    chatId.ts          phone/group → chatId normalization
    profileClient.ts   one whatsapp-web.js Client: events, QR, reconnect, send, chats
    registry.ts        in-memory client registry keyed by profile id
  server/
    app.ts             Express app + route mounting
    middleware.ts      async handler + error middleware
    routes/
      profiles.ts      profile lifecycle + QR
      messages.ts      unified send endpoint (json + multipart)
      chats.ts         list / search chats
  index.ts             boot: reload profiles, listen, graceful shutdown
```

The server keeps **every WhatsApp client alive in memory** for the lifetime of
the process (WhatsApp Web needs a persistent connection). On boot it reloads all
profiles from SQLite and reconnects them. There is **no separate CLI** — the HTTP
server is the whole app. It binds to **localhost only** and has **no auth**; do
not expose it to the network.

## Setup

```bash
npm install          # also downloads a Chromium for puppeteer (~first run only)
cp .env.example .env # tweak if you like; defaults are sane
npm run start        # builds, then boots the server
```

Requirements: Node.js 18+. On Linux you may need the usual Chromium system
libraries; on macOS the bundled Chromium works out of the box. To use a system
Chrome instead of the bundled one, set `PUPPETEER_EXECUTABLE_PATH` in `.env`.

### Scripts

| Script            | What it does                                   |
| ----------------- | ---------------------------------------------- |
| `npm run start`   | Compile to `dist/` then run the server         |
| `npm run dev`     | Run from source with reload (`tsx watch`)      |
| `npm run build`   | Type-check + compile to `dist/`                |
| `npm run typecheck` | Type-check only                              |

### Running persistently (pm2)

```bash
npm run build
pm2 start npm --name waweb -- run start
pm2 logs waweb
pm2 save
```

## Configuration

All config comes from environment variables (see [`.env.example`](.env.example)):

| Variable               | Default       | Description                                         |
| ---------------------- | ------------- | --------------------------------------------------- |
| `HOST`                 | `127.0.0.1`   | Bind address (keep on localhost).                   |
| `PORT`                 | `3000`        | HTTP port.                                          |
| `DATA_DIR`             | `./data`      | SQLite DB + LocalAuth session files.                |
| `MESSAGE_DELAY_MIN_MS` | `800`         | Min pre-send delay (anti-ban jitter floor).         |
| `MESSAGE_DELAY_MAX_MS` | `2500`        | Max pre-send delay.                                 |
| `TYPING_SIMULATION`    | `true`        | Send a typing indicator before each message.        |
| `MAX_UPLOAD_MB`        | `32`          | Max multipart upload size.                          |
| `QR_WAIT_MS`           | `25000`       | How long `POST /profiles` waits for the first QR.   |
| `RECONNECT_BASE_MS`    | `2000`        | Reconnect backoff base.                             |
| `RECONNECT_MAX_MS`     | `60000`       | Reconnect backoff cap.                              |
| `RECONNECT_MAX_RETRIES`| `10`          | Give up after this many attempts (no infinite loop).|
| `LOG_LEVEL`            | `info`        | pino level.                                         |
| `LOG_PRETTY`           | `true`        | Pretty logs (`false` = JSON).                       |
| `PUPPETEER_EXECUTABLE_PATH` | *(unset)* | Use a system Chrome/Chromium instead of bundled.    |

## Connection states

Surfaced on the profile endpoints:

`connecting` · `qr-pending` · `authenticated` · `connected` · `disconnected` ·
`logged-out` · `conflict`

- **disconnected** → transient; the service reconnects with backoff.
- **logged-out** → WhatsApp unlinked the device; create/scan a fresh QR (the
  service does *not* loop forever).
- **conflict** → the session was opened elsewhere (another WhatsApp Web).

---

## Endpoints

Base URL in examples: `http://127.0.0.1:3000`.

### `GET /profiles` — list all profiles

```bash
curl -s http://127.0.0.1:3000/profiles
```

```json
{ "profiles": [
  { "id": "9f1c...", "name": "Sales", "phoneNumber": "628123456789", "state": "connected" }
] }
```

### `GET /profiles/:id` — detailed state

```bash
curl -s http://127.0.0.1:3000/profiles/9f1c...
```

```json
{
  "id": "9f1c...", "name": "Sales", "phoneNumber": "628123456789",
  "state": "connected", "lastConnectedAt": 1718200000000, "lastError": null,
  "device": { "pushname": "Sales", "platform": "android", "wid": "628123456789@c.us" },
  "hasQr": false
}
```

### `POST /profiles` — create a profile and start a client

Returns the QR (as a data URL **and** ASCII) so you can scan it. Persists creds
on success, so later restarts reconnect without a re-scan.

```bash
curl -s -X POST http://127.0.0.1:3000/profiles \
  -H 'Content-Type: application/json' \
  -d '{"name":"Sales"}'
```

The response includes `qr.dataUrl` (paste into a browser to render the PNG) and
`qr.ascii` (printable in a terminal). Then poll until connected:

### `GET /profiles/:id/qr` — poll QR + auth status

```bash
curl -s http://127.0.0.1:3000/profiles/9f1c.../qr
```

```json
{ "state": "qr-pending", "dataUrl": "data:image/png;base64,iVBOR...", "ascii": "█▀▀▀...", "phoneNumber": null }
```

Render the ASCII QR straight from the terminal:

```bash
curl -s http://127.0.0.1:3000/profiles/9f1c.../qr | python3 -c 'import sys,json;print(json.load(sys.stdin)["ascii"])'
```

When `state` becomes `connected`, you're linked.

### `DELETE /profiles/:id` — remove a profile

Without `logout`, removes local profile data (DB row + session files). With
`?logout=true`, unlinks the device from WhatsApp first.

```bash
curl -s -X DELETE 'http://127.0.0.1:3000/profiles/9f1c...?logout=true'
```

### `POST /profiles/:id/messages` — unified send

Exactly **one** primary content per message: `text`, `media` (+ optional
caption), or `poll`. `mentions` may accompany `text` or a caption.

Fields:

| Field        | Type             | Notes                                                                 |
| ------------ | ---------------- | --------------------------------------------------------------------- |
| `target`     | string (req.)    | Phone (`+62…`/`628…`) or group id (`…@g.us`). Normalized to a chatId.  |
| `text`       | string           | Message body, or caption when sending media.                          |
| `mentions`   | string[]         | Phone numbers to tag. The text must contain an `@<number>` token for each. |
| `media`      | file/url/base64  | See below. Image/video/file auto-detected by mimetype.                |
| `asDocument` | boolean          | Force-send media as a plain file/document.                            |
| `poll`       | object           | `{ question, options[], allowMultipleAnswers }`.                       |

Before sending, the service verifies the target is registered on WhatsApp, sends
a typing indicator, and applies the randomized delay.

**Plain text:**

```bash
curl -s -X POST http://127.0.0.1:3000/profiles/9f1c.../messages \
  -H 'Content-Type: application/json' \
  -d '{"target":"+62 812-3456-789","text":"Hello from waweb 👋"}'
```

**Mention in a group** (note the matching `@<number>` token in the text):

```bash
curl -s -X POST http://127.0.0.1:3000/profiles/9f1c.../messages \
  -H 'Content-Type: application/json' \
  -d '{
    "target":"120363012345678901@g.us",
    "text":"Welcome @628123456789 🎉",
    "mentions":["628123456789"]
  }'
```

**Media via multipart file upload** (image/video/file auto-detected; `text`
becomes the caption):

```bash
curl -s -X POST http://127.0.0.1:3000/profiles/9f1c.../messages \
  -F 'target=+62812345678' \
  -F 'text=Here is the invoice' \
  -F 'asDocument=true' \
  -F 'media=@/path/to/invoice.pdf'
```

**Media via URL (JSON):**

```bash
curl -s -X POST http://127.0.0.1:3000/profiles/9f1c.../messages \
  -H 'Content-Type: application/json' \
  -d '{"target":"+62812345678","text":"Logo","media":{"url":"https://example.com/logo.png"}}'
```

**Media via base64 (JSON):**

```bash
curl -s -X POST http://127.0.0.1:3000/profiles/9f1c.../messages \
  -H 'Content-Type: application/json' \
  -d '{"target":"+62812345678","media":{"mimetype":"image/png","base64":"iVBORw0KGgo...","filename":"pic.png"}}'
```

**Poll:**

```bash
curl -s -X POST http://127.0.0.1:3000/profiles/9f1c.../messages \
  -H 'Content-Type: application/json' \
  -d '{
    "target":"120363012345678901@g.us",
    "poll":{"question":"Lunch?","options":["Pizza","Sushi","Salad"],"allowMultipleAnswers":false}
  }'
```

### `GET /profiles/:id/chats` — list / search chats

```bash
curl -s http://127.0.0.1:3000/profiles/9f1c.../chats
curl -s 'http://127.0.0.1:3000/profiles/9f1c.../chats?q=sales'
```

```json
{ "count": 2, "query": "sales", "chats": [
  { "id": "628...@c.us", "name": "Sales Lead", "type": "person", "isGroup": false,
    "number": "628...", "unreadCount": 0, "lastMessageAt": 1718200000000 }
] }
```

---

## Out of scope (v1)

Receiving/reading incoming messages and group management (create/edit). These are
left as clearly-marked extension points in `src/wa/profileClient.ts`
(`bindEvents`) so they're easy to add later.

## Troubleshooting

- **Chromium fails to launch** — install system Chromium libs, or point
  `PUPPETEER_EXECUTABLE_PATH` at an existing Chrome.
- **Stuck on `qr-pending`** — the QR expires and refreshes automatically; re-poll
  `GET /profiles/:id/qr` to get the latest.
- **`logged-out`** — the device was unlinked from the phone; the profile needs a
  fresh QR scan.
- **Poll send fails** — polls are sensitive to the WhatsApp Web build; the
  endpoint returns a clear `502` rather than crashing. The whatsapp-web.js
  version is pinned (`1.34.7`) for this reason.
```
