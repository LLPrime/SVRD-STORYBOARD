# Storyboard Search Proxy

Wraps the GIPHY search API behind one endpoint so the API key never touches the client.

## Local test

```
cp .env.example .env   # fill in GIPHY_KEY
npm install
npm start
curl "http://localhost:3000/api/search?q=coffee"
```

`nextCursor` in the response — pass it back as `?cursor=...` on the next request for "load more."

## Deploy to the Hetzner VPS (CPX31)

```bash
# on the VPS, one-time setup
apt update && apt install -y nodejs npm ffmpeg
npm install -g pm2

# grab this code (once it's in a GitHub repo)
git clone <repo-url> storyboard-server
cd storyboard-server
cp .env.example .env
nano .env              # fill in real keys, set CLIENT_ORIGIN to your Vercel/Netlify domain
npm install

pm2 start server.js --name storyboard-proxy
pm2 save
pm2 startup            # follow the printed instructions so it survives reboots
```

Then put Caddy in front for free auto-HTTPS — a `Caddyfile` with just:

```
your-domain.com {
    reverse_proxy localhost:3000
}
```

`systemctl enable caddy` and you're done — no manual cert renewal.

## Story-to-beats (`/api/expand`)

`POST /api/expand` with `{ "text": "your paragraph or line" }` splits it into beats (one per sentence), pulls the meaningful anchor words out of each beat (pronouns included — "I", "you" etc. are kept on purpose), and looks each one up against **GIPHY's related-tags endpoint** (`/v1/tags/related/{term}`) — terms people actually associate with that word on GIPHY, mined from real tag/search co-occurrence, not AI.

No AI model, no extra API key — rides on the same `GIPHY_KEY` used for search. The client's Story Mode calls this, then searches GIPHY with the returned phrases.

This is closer to a thesaurus than true "read the subtext" understanding — it finds what people already searched alongside a word, not what a sentence implies. It'll do well on individual loaded words (pronouns, emotions, slang) and less well on long, unusual sentences with no single strong anchor word.

## Notes

- **Tenor removed as of July 2026.** Google shut down third-party access to the Tenor API on June 30, 2026 — this affected every app that used it (Discord, X, WhatsApp, Bluesky included), not just this project. GIPHY is now the only source. If a comparable second source is ever wanted, Klipy is the provider several major apps migrated to post-shutdown — worth checking if it still has a free tier when/if that's needed.
- Rate limited: 60 req/min on `/api/search`, 30 req/min on `/api/expand`.
- `rating=pg-13` on GIPHY — tune if needed.
- This is Phase 1 piece 1 of 5. `/render` (ffmpeg export) comes later, once search + client playback are working end to end.
