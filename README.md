# 🔑 License Key Server — Setup Guide

## Quick Start

### 1. Fill in your `.env` file
```
TELEGRAM_BOT_TOKEN=   ← from @BotFather on Telegram
ADMIN_TELEGRAM_ID=    ← your Telegram user ID (get from @userinfobot)
MONGODB_URI=          ← MongoDB Atlas connection string
PORT=3000
API_SECRET=           ← any random string
```

### 2. Install & Run
```bash
npm install
npm start
```

### 3. Deploy (Render.com — Free)
1. Push this folder to GitHub
2. Go to render.com → New Web Service → connect your repo
3. Set environment variables in Render dashboard
4. Your server URL will be: `https://your-app.onrender.com`

---

## Telegram Bot Commands

| Command | Description |
|---|---|
| `/getToken 30m` | Generate 30-minute key |
| `/getToken 1h` | Generate 1-hour key |
| `/getToken 1d` | Generate 1-day key |
| `/getToken 7d` | Generate 7-day key |
| `/list` | Show all keys (last 30) |
| `/listActive` | Show only active keys |
| `/listUnused` | Show only unused keys |
| `/check <key>` | Check status of a specific key |
| `/revoke <key>` | Revoke/disable a key immediately |

---

## Chrome Extension Setup

In the extension's `license.js`, set:
```js
const LICENSE_SERVER = 'https://your-app.onrender.com';
```

---

## How it works

1. Admin sends `/getToken 1d` to bot
2. Bot creates key in MongoDB, sends key back to admin
3. Admin gives key to user
4. User enters key in Chrome extension
5. Extension calls `/api/validate` → key activates, timer starts
6. Extension polls `/api/status` every 60 seconds
7. When expired or revoked → extension locks out automatically
