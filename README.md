# 📦 Telegram File Store Bot — Cloudflare Workers

TeleBot-style multi-file sharing bot with Force Subscribe, auto-delete, forward protection, and a web preview page.

---

## ✨ Features

| Feature | Details |
|---|---|
| `/start` | Welcome screen |
| `/start?start=ID` | Delivers all files of that bundle |
| `/upload` | Admin — collect multiple files |
| `✅` button | Finalize upload → get shareable link |
| Force Subscribe | Multiple channels via Channel IDs |
| Auto Delete | Files deleted after 15 minutes |
| Forward Protection | Optional — prevent forwarding |
| Custom Caption | Prefix/suffix on every file |
| Web Preview | `/file/ID` — dark themed file list |
| `/stats` | Admin — users & files count |
| `/broadcast` | Admin — message all users |

---

## 📁 File Structure

```
workers.js      ← Main Cloudflare Worker
wrangler.toml   ← Config file
README.md       ← This file
```

---

## 🚀 Deployment Steps

### Step 1 — Prerequisites
```bash
npm install -g wrangler
wrangler login
```

### Step 2 — KV Namespace
Already created. ID is in wrangler.toml:
```
6cde3daaf348409aa8513ec82c53b791
```

### Step 3 — Update wrangler.toml

```toml
[vars]
BOT_USERNAME       = "your_actual_bot_username"
WORKER_URL         = "https://jag.tmrbotz.workers.dev"
FORCE_SUB_CHANNELS = "-1001234567890,-1009876543210"
```

**FORCE_SUB_CHANNELS format:**
- Single channel:   `-1001234567890`
- Multiple channels: `-1001234567890,-1009876543210,-1001122334455`
- Leave empty `""` to disable force subscribe

**How to get Channel ID:**
1. Add @userinfobot to your channel
2. Forward any channel message to @userinfobot
3. It will show the numeric ID like `-1001234567890`

### Step 4 — Set Secrets (Cloudflare Dashboard)

Go to:
```
https://dash.cloudflare.com → Workers & Pages → jag → Settings → Variables & Secrets
```

Add these as **Secrets (Encrypted)**:

| Secret Name | Value |
|---|---|
| `BOT_TOKEN` | Your bot token from @BotFather |
| `ADMINS` | Your Telegram user ID (e.g. `123456789`) |
| `WEBHOOK_SECRET` | Any random string (e.g. `mybot_secret_2024`) |

### Step 5 — Deploy
```bash
wrangler deploy
```

Or push to GitHub — auto deploys via Cloudflare Workers Builds.

### Step 6 — Set Webhook

Open this URL in browser (replace values):
```
https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook?url=https://jag.tmrbotz.workers.dev/webhook&secret_token=YOUR_WEBHOOK_SECRET
```

Expected response:
```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

---

## ⚙️ Bot Configuration

Edit top of `workers.js`:

```js
const CUSTOM_CAPTION_PREFIX = "@YourChannel ";       // added before every caption
const CUSTOM_CAPTION_SUFFIX = "\n\nJoin @YourChannel"; // added after every caption
const FORWARD_PROTECT       = true;   // true = users can't forward files
const AUTO_DELETE_SECONDS   = 900;    // 900 = 15 minutes, 0 = never delete
```

---

## 🔒 Force Subscribe Setup

### 1. Create your channel(s)
### 2. Add your bot as Admin with these permissions:
- ✅ Post Messages
- ✅ Invite Users via Link

### 3. Get Channel ID
Forward any message from the channel to [@userinfobot](https://t.me/userinfobot)

### 4. Add to wrangler.toml
```toml
FORCE_SUB_CHANNELS = "-1001234567890"
```

### Multiple channels:
```toml
FORCE_SUB_CHANNELS = "-1001234567890,-1009876543210,-1001122334455"
```

---

## 🤖 Bot Commands

### User Commands
| Command | Description |
|---|---|
| `/start` | Welcome + buttons |
| `/start ID` | Receive all files of a bundle |

### Admin Commands
| Command | Description |
|---|---|
| `/upload` | Start file upload session |
| `/stats` | View total users & files |
| `/broadcast msg` | Send message to all users |
| `/cancel` | Cancel current session |

---

## 🔗 URL Routes

| Route | Description |
|---|---|
| `POST /webhook` | Telegram webhook |
| `GET /file/:id` | Web preview page for file bundle |
| `GET /ping` | Health check |

---

## 📊 KV Data Structure

```
media:<id>        → JSON array of files in bundle
session:<userId>  → Upload session state (TTL: 1hr)
user:<userId>     → User info
counter:total_files → Total files uploaded
counter:total_users → Total registered users
deletetask:...    → Pending auto-delete tasks
```

---

## ❓ Troubleshooting

**Force sub not working:**
- Bot must be Admin in each force sub channel
- Channel IDs must be negative numbers starting with `-100`
- Check with: `https://api.telegram.org/botTOKEN/getChatMember?chat_id=-100xxx&user_id=YOUR_ID`

**Files not sending:**
- Check BOT_TOKEN secret is set correctly
- Verify webhook is registered: `https://api.telegram.org/botTOKEN/getWebhookInfo`

**Auto delete not working:**
- Cloudflare Workers has no background timer
- Delete runs on next incoming webhook request
- For exact timing, upgrade to Cloudflare Workers Cron Triggers (paid plan)

**ADMINS not working:**
- Set as secret in Dashboard: `123456789` (just the number, no spaces)
- Multiple admins: `123456789,987654321`

---

## 📦 Quick Checklist

- [ ] `wrangler.toml` — KV ID updated
- [ ] `wrangler.toml` — BOT_USERNAME updated
- [ ] `wrangler.toml` — WORKER_URL updated
- [ ] `wrangler.toml` — FORCE_SUB_CHANNELS set
- [ ] Dashboard Secret — BOT_TOKEN set
- [ ] Dashboard Secret — ADMINS set
- [ ] Dashboard Secret — WEBHOOK_SECRET set
- [ ] Bot is Admin in storage channel
- [ ] Bot is Admin in all force sub channels
- [ ] Webhook registered via URL
- [ ] Test `/start` in bot ✅

