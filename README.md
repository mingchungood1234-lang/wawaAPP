# WhatsApp Mobile

Two ways to get a good WhatsApp experience in a phone browser:

1. **Self-hosted web app (`server/` + `web/`)**: runs on your VPS. You open it from any phone
   browser (iPhone or Android) with no extensions, add it to the home screen, and get push
   notifications.
2. **Phone layer for WhatsApp Web (`src/`)**: a userscript that reshapes `web.whatsapp.com`
   itself. Nothing to host, but you need a userscript extension on the phone.

---

# 1. Self-hosted web app

```
Phone (PWA, password-protected)
     │  HTTPS + WebSocket
     ▼
VPS: Node server ── whatsapp-web.js ── headless Chromium running real WhatsApp Web
                                              │
                                              ▼
                                        WhatsApp servers
```

Your WhatsApp account is linked to the server like any other WhatsApp Web session, under
*Linked devices* on your phone. The server keeps that session running and serves its own
mobile-first UI:

- chat list with search, unread badges, pinned and muted chats
- conversations: text with WhatsApp formatting and links; photos, video, voice notes, stickers,
  documents and locations; replies (long-press or double-tap a message); read ticks; live updates
- sending text, replies, photos and files
- push notifications when no tab is open; a tap opens the chat
- installable PWA, light and dark mode, hardware or gesture back

> **Read this first**
> - **Unofficial.** This automates WhatsApp Web, which WhatsApp's terms don't allow. Accounts
>   can be banned for automation. A real browser session used by one person is low-risk, but
>   it isn't zero. Consider testing with a secondary number first.
> - **Your messages pass through your server.** Anyone with the app password or root on the
>   VPS can read them. Use a long random password, HTTPS only, and a VPS you trust.
> - Calls, status updates, and creating groups are not supported.

## Deploy on a VPS (Docker)

Requirements:
- a Linux VPS with at least 1 GB RAM (2 GB is comfortable; Chromium is the heavy part)
- Docker with the Compose plugin
- a domain or subdomain whose DNS A record points to the VPS
- nginx and certbot on the VPS

On a 1 GB VPS, add swap first. Chromium uses 400–700 MB, and spikes (WhatsApp Web loading
history, or a large upload) get the process OOM-killed without swap:

```sh
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf && sudo sysctl --system
```

Also keep the VPS lean (no other heavy services). Check usage with `docker stats`.

```sh
git clone <this repo> whatsapp && cd whatsapp      # or copy the folder over with scp/rsync
cp .env.example .env
nano .env        # set a long APP_PASSWORD and PUSH_CONTACT
docker compose up -d --build
docker compose logs -f app                          # wait for "[wa] status: qr"
```

The app listens only on `127.0.0.1:3000`. nginx serves your domain over HTTPS and forwards
to it:

```sh
sudo cp deploy/nginx.conf /etc/nginx/sites-available/whatsapp   # or /etc/nginx/conf.d/whatsapp.conf
sudo nano /etc/nginx/sites-available/whatsapp       # replace chat.example.com with your domain
sudo ln -s /etc/nginx/sites-available/whatsapp /etc/nginx/sites-enabled/   # skip for conf.d
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d your-domain                 # free HTTPS certificate
```

Open `https://your-domain` on your phone, enter the app password, then link WhatsApp:
- **from another device:** scan the QR code in WhatsApp under *Settings → Linked devices →
  Link a device*, or
- **from the same phone:** enter your number under "Link with your number instead". Then in
  WhatsApp choose *Link a device → Link with phone number instead* and type the code.

The WhatsApp session, push keys and app secret live in the `wa_data` volume, so they survive
restarts and rebuilds.

Update: `git pull && docker compose up -d --build`.

## Install on the phone

- **iPhone:** Safari → Share → **Add to Home Screen**. Open the app from the home screen,
  then ⋮ → **Enable notifications**. iOS only allows web push for home-screen apps (iOS 16.4+).
- **Android:** Chrome → ⋮ → **Install app** (or *Add to Home screen*), then ⋮ →
  **Enable notifications**.

## Run locally (Windows, macOS or Linux)

```sh
npm install
APP_PASSWORD=some-long-password npm start      # http://localhost:3000
```

PowerShell: `$env:APP_PASSWORD='some-long-password'; npm start`.

| Env var | Default | |
|---|---|---|
| `APP_PASSWORD` | required | at least 8 characters |
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | session and keys. On Windows keep this path short: Chrome's storage paths inside it break past 260 characters |
| `PUSH_CONTACT` | `mailto:admin@localhost` | contact sent to push services |
| `WA_NO_SANDBOX` | unset | `1` inside containers |
| `MEDIA_CACHE_MB` | `24` | RAM for caching downloaded media; files over a quarter of this aren't cached |
| `UPLOAD_LIMIT_MB` | `64` | max size of a sent file. An upload briefly needs about 3–4× its size in RAM, so use 16–32 on 1 GB |

### Status

- **Tested locally:** the server starts WhatsApp Web, reaches the QR state, and serves the QR
  code. Password login and the 401s on the API and WebSocket work. The chat list,
  conversation view, sending, replies, live incoming messages and back navigation were tested
  against mocked data on an iPhone-sized viewport.
- **Not yet tested:** a real linked account (real chats, media download, sending to WhatsApp,
  push delivery), the pairing-code flow, and the Docker image build.

Code map: [server/wa.mjs](server/wa.mjs) (WhatsApp session and serialisation),
[server/index.mjs](server/index.mjs) (REST API, WebSocket, push trigger),
[server/auth.mjs](server/auth.mjs) (password and signed cookie, brute-force lockout),
[web/app.js](web/app.js) (the whole UI, no build step).

---

# 2. Phone layer for WhatsApp Web (userscript)

A phone-optimised layer on top of desktop WhatsApp Web. You develop it in Chromium with phone
emulation on your PC, then run the same code on the phone as a userscript.

## How it works

WhatsApp Web turns away mobile user agents. So the page runs with a **desktop user agent** and a
**phone-sized, touch-enabled viewport**. On top of that, one script (`src/mobile.js` + `src/mobile.css`)
reshapes the UI:

- **Single pane:** the chat list fills the screen. An open chat (and its contact info or search
  drawer) slides in as a full-screen sheet.
- **Back navigation:** an injected back button in the chat header, swipe-back from the left
  edge, and the phone's back button/gesture (each view pushes a history entry).
- **Fit to width:** removes desktop min-widths, uses `100dvh` so the keyboard resizes the
  layout, and uses a 16px composer font so iOS doesn't zoom in.
- **Desktop untouched:** the layer only activates at widths of 820px or less.

WhatsApp's CSS class names are obfuscated and change with every release, so the layer avoids
them. It anchors on stable ids (`#app`, `#side`, `#main`), finds the column layout by
structure and geometry, and tags it with its own `data-wam-*` attributes. The CSS targets
only those attributes.

## Develop (PC, Chromium)

```sh
npm install
npx playwright install chromium
npm run dev                               # Pixel 7 emulation, headed
npm run dev -- --device "iPhone 15"       # any Playwright device name
npm run dev -- --channel chrome           # use installed Chrome
npm run dev -- --raw                      # without the layer, for comparison
npm run dev -- --headless --screenshot shot.png
```

- Your login is kept in `.profile/`. Scan the QR code once with your phone.
- Edit anything in `src/` and it **hot-reloads** into the open page.
- In the page console, `__wam.view`, `__wam.layout` and `__wam.refresh()` help with debugging.
  The console also logs `[wam] layout tagged` when the chat layout has been found.

## Use on the phone

```sh
npm run build   # -> dist/whatsapp-mobile.user.js
```

**Android (recommended): Firefox for Android + Violentmonkey (or Tampermonkey)**

1. Install the extension and add `dist/whatsapp-mobile.user.js`.
2. Make `web.whatsapp.com` see a desktop user agent. Either:
   - use a per-site user-agent switcher extension (best, because the page keeps the mobile
     viewport), or
   - use Firefox's "Desktop site" toggle. Some versions also force a desktop-width viewport,
     which the layer tries to override with its own `<meta viewport>`.
3. Logging in on the same phone: you can't scan your own screen, so choose
   **"Log in with phone number"**. It gives you a code to enter in WhatsApp under
   *Linked devices*.

**iPhone: Safari + the "Userscripts" extension** (free, App Store; Tampermonkey or "Stay" also work)

1. Install **Userscripts**. In *Settings → Apps → Safari → Extensions → Userscripts*, turn it
   on and allow it on `web.whatsapp.com`.
2. Open the Userscripts app and pick a scripts folder in Files. Copy
   `dist/whatsapp-mobile.user.js` into it, for example with iCloud Drive or AirDrop.
3. In Safari, open `web.whatsapp.com`. Tap **aA → Request Desktop Website**. Safari remembers
   this per site, and it gets past WhatsApp's mobile block.
4. Log in with **"Log in with phone number"** and enter the code in WhatsApp under
   *Settings → Linked Devices*.

iOS notes:
- Safari's own edge swipe works as "back" (the layer listens for history changes), so its
  custom swipe is turned off on iOS.
- The keyboard: the layer sizes the page from `visualViewport`, so the composer stays above
  the keyboard.
- Don't use *Add to Home Screen*. Safari extensions don't run in home-screen web apps, so you'd
  get the unmodified desktop page.
- iOS suspends background tabs, so there are **no message notifications**. WhatsApp
  reconnects when you return to the tab.

**Native app wrapper (later):** for a home-screen app with full control over the user agent,
viewport and notifications, load `web.whatsapp.com` in an Android WebView, set a desktop user
agent, and inject the built payload (`scripts/payload.mjs`) with `evaluateJavascript` on page
load. No other changes are needed.

## Status / limits

- Verified: WhatsApp Web accepts the emulated session, and the login/QR screen fits phone
  width and scrolls.
- **Not yet verified after login:** column detection, sheet transitions and back handling.
  These rely on WhatsApp's current DOM. Run `npm run dev`, log in, and tune `src/` live.
- Some rules are best guesses to check after login: the `.message-in/out` bubble width and the
  hover-chevron `data-icon` names.
- Some features stay desktop-only: calls, and anything WhatsApp limits to the desktop app.
