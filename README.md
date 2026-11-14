# Anik’s Ludo

```
anik-ludo/
  frontend/   the game (index.html + config.js), static files, no build step
  server/     Node.js + Socket.IO realtime server (rooms, dice, rules)
```

## Run on a computer
```
cd server
npm install
npm start          # http://localhost:3000 (also serves ../frontend)
```

## Deploy
**Server (Render, free)**: New Web Service, Root Directory `server`, Build `npm install`, Start `npm start`.
**Frontend (Vercel, free)**: Import the repo, Root Directory `frontend`, Framework Preset `Other`.
Then edit `frontend/config.js` and set `window.LUDO_SERVER` to your Render URL.

Single-link option: skip Vercel, leave `config.js` empty, and share the Render URL
(the server also serves the frontend folder).

## Keep the free Render server awake
`GET /healthz` returns `{ok, uptime, rooms, players, time}`.

- **Built in**: on Render the server calls its own `/healthz` every 14 minutes
  (it reads `RENDER_EXTERNAL_URL`, which Render sets itself). Change with `KEEP_ALIVE_MINUTES`,
  turn off with `KEEP_ALIVE=off`.
- **Backup (recommended)**: a free external cron such as cron-job.org or UptimeRobot calling
  `https://YOUR-SERVER.onrender.com/healthz` every 10 to 14 minutes. It also wakes the server
  again after a deploy or crash, which the built-in ping cannot do.
