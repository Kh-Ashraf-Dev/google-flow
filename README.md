# Studio · AI video & image platform (MVP)

A proof of concept for the Ministry of Awqaf: Vertex AI models (Veo 3.1 and Omni Flash for video, Nano Banana 2 for images, Gemini Flash for prompt checks), behind the Ministry's own accounts, credits, content policy and admin controls.

What the demo shows:

- Employees sign in with a Studio account, not a personal Google account.
- Prompts can be written in Arabic. Generate sends right away: Gemini Flash checks the prompt against the content policy, and an Arabic prompt is translated into English word for word. Prompts are not rewritten or "improved".
- The cost is shown before generating. Credits are reserved when a job starts, committed when it succeeds, and refunded automatically when it fails or Google's safety filter stops it.
- Blocked prompts (blocklist or AI policy check) never reach the video model and never cost credits.
- Each employee can have a daily limit; admins see who used what today, this week or this month.
- Scenes, like Flow's Scenebuilder: put clips on a timeline, play them back as one video, drag to reorder, and download the whole scene as one MP4. **Extend** makes the next shot starting from the last frame of a clip; **Use in video** selects generated images for separate animations or one clip from two or three references using Omni 1.2 Flash, Omni 1.1 Flash Preview, or Veo 3.1 Quality.
- Admins approve credit requests, give credits from the monthly pool, turn policy rules on and off, edit the blocklist, and see every action in the audit log.

## Run it

Needs Node 24 or newer.

```bash
npm install --legacy-peer-deps
npm run dev
```

Open http://localhost:5173. Demo accounts (password `demo1234`):

| Account | Role |
|---|---|
| saif@awqaf.demo | Employee · Media |
| mona@awqaf.demo | Employee · Social |
| omar@awqaf.demo | Admin · Media |

Without Vertex credentials the app runs in **mock mode**: no Google calls, no cost, and generations return a placeholder after a few seconds.

## Use the real Google models

1. Enable Vertex AI and billing in Google Cloud and configure a service account with permission to invoke Vertex AI.
2. Copy `.env.example` to `.env.local` and set `VERTEX_KEY_FILE` to the service account JSON file. Veo defaults to `us-central1`. Omni, prompt checks, and image generation use global endpoints.
3. Keep `DAILY_SPEND_CAP_USD` low while testing. The app refuses new jobs once the day's estimated Google cost reaches it.

Credits: 1 credit = $0.08. Per second at 720p: Omni 1.2 Flash 1, Omni 1.1 Flash Preview 2, Veo 3.1 Lite 1, Veo 3.1 Fast 2, Veo 3.1 Quality 5. Images are Google's price ÷ $0.08, rounded up. (On 2026-11-11 credits briefly matched Google Flow's numbers at $0.04 each; `scripts/rescale-credits.ts` doubled balances for that and `scripts/revert-credit-rescale.ts` halved them back.) Credits are reserved for the chosen length and the real length is billed when the video arrives. Video prices live in `server/pricing.ts` (`VIDEO_RATES`), image prices in `server/db.ts`.

## Deploy (Fly.io)

Live at https://awqaf-studio.fly.dev (app `awqaf-studio`, region `fra`). One machine with a 1 GB volume `studio_data` at `/data` holding the SQLite database and media, so there must only ever be one machine. The machine never auto-stops, because videos finish in the background.

```bash
flyctl deploy --app awqaf-studio --ha=false
```

Secrets: `VERTEX_KEY_JSON`, `DAILY_SPEND_CAP_USD` (`flyctl secrets set ...`). Vercel can't run this server (long-running process, local SQLite and files).

## Demo recording with voice-over

With `npm run dev` running:

```bash
node scripts/narrate.mjs --only intro   # one line first, to check the voice
node scripts/narrate.mjs                # all lines in scripts/narration.json
node scripts/record-demo.mjs            # records the flow and mixes the voice in
```

`narrate.mjs` needs `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` in `.env.local` (optionally `ELEVENLABS_MODEL`). The recording drives the real app, so it spends real Google credit: one image and one 4-second 720p video. Output goes to `recordings/`.

## How it's built

- `server/`: Hono on Node with Postgres on Neon (`pg`). Runs `.ts` directly, no build step.
  - `db.ts`: schema, demo seed and a small query wrapper (`?` placeholders, `tx()` for transactions). Needs `DATABASE_URL`: a Neon dev branch locally, the `main` branch in production (Fly secret).
  - `provider.ts`: prompt review and media generation using the shared Vertex AI client in `vertex.ts`.
  - `ledger.ts`: append-only credit ledger. Balances are always the sum of entries.
  - `policy.ts`: blocklist, then the Gemini policy check.
  - `jobs.ts`: reserve → start → poll → commit or refund. Extend/animate jobs read their start frame before credits are reserved.
  - `media.ts`: ffmpeg (`ffmpeg-static`) for a clip's last frame and for joining a scene into one MP4.
- `src/`: React + Vite. Studio, Usage & credits, Admin.
- `data/media/`: generated media (on the Fly volume in production). The database is in Neon; to start from fresh demo data, reset the Neon dev branch from `main` or empty its tables.
- `scripts/sqlite-to-neon.ts`: one-off copy of the old SQLite database into Postgres, keeping ids.

Not in the MVP: departments hierarchy and caps, review queue, SSO, S3/MinIO storage, a background worker (the studio page polls instead), and the Fekra House platform console. These are designed in the Figma file.
