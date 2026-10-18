# Hosting Casino Arena (so friends can play from anywhere)

Solo play needs no server: it is a static web app. **Party mode** (multiplayer) needs one running
process, because the game state is held by the server and pushed to players over a long-lived stream.

`npm run party:server` can serve the built app **and** the multiplayer API from one address, so
hosting is one process:

```bash
npm ci
npm run build                      # produces dist/
STATIC_DIR=dist HOST=0.0.0.0 PORT=8787 npx vite-node scripts/party-server.ts
# open http://<your-host>:8787 and use the Party tab
```

## What the host must provide

| Need | Why |
| --- | --- |
| A long-running process (not serverless functions) | Party games live in memory and stream to players; a function that sleeps between requests cannot hold a table. |
| **Exactly one instance** | State is in one process and one file. Two instances would each hold different parties and players would be sent to the wrong one. |
| A persistent, private volume for `PARTY_FILE` | Live parties survive a restart by replaying the saved file. Without a volume a redeploy ends every table. |
| HTTPS in front | Players' secret tokens travel in a request header; serve over TLS (any host's built-in certificate is fine). |
| Streaming responses not buffered | Updates are Server-Sent Events. If your proxy buffers responses, tables will appear frozen. (nginx: `proxy_buffering off;` for `/api/party/events`.) |

Containers on Fly.io, Render, Railway, a small VM or a home server all fit. A `Dockerfile` is included.
**It has not been built here** (no Docker daemon was available while it was written), so build and run it
once yourself: `docker build -t casino-arena .` then
`docker run -p 8787:8787 -v casino-data:/data casino-arena`.

## Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on. |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` inside a container or on a VM. |
| `STATIC_DIR` | unset | Folder of the built app (`dist`). Unset means API only (the dev setup). |
| `PARTY_FILE` | `.party-state.json` | Where live parties are saved. **Treat it like a secret key**: it contains every live player's cards. |
| `TRUST_PROXY` | unset | Set to `1` only when exactly one reverse proxy is in front. Without it, rate limits see every player as the proxy's address and are shared by everyone. With it, the address is the last `X-Forwarded-For` entry, which the proxy itself adds. Do **not** set it if the server is reachable directly. |

## What the static server will and will not serve

Only `GET`/`HEAD`; nothing outside the app folder (symlinks are followed and checked); no dotfile, so the
saved state, `.env` and `.git` are unreachable even if placed in the folder; no file type it does not know;
unknown extension-less paths return the app (so reloading on any screen and `?party=CODE` links work);
`/api/...` never falls through to the app. These rules are tested in `party-static.test.ts`.

## Limits worth knowing

- **One instance, one file.** This is built for friends and small groups, not thousands of concurrent
  rooms. Idle parties expire.
- **A redeploy while a hand is live** pauses play until the process is back; players reconnect to the same
  seat automatically. A *corrupt* state file is set aside and never half-loaded.
- **Rate limits** (10 parties and 30 joins per minute per address) slow flooding and invite-code guessing.
- **Back up** `PARTY_FILE` only if you want to keep live tables across a disaster; finished sessions keep
  just their standings.

## How this was checked

The one-process setup (build, then a single server serving the app and the API) was started and played
with two real browser tabs on one address; see the final report in the pull request. The Docker image and
a real cloud deploy were **not** exercised.
