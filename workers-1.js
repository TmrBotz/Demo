/**
 * ============================================================
 *  Telegram File Store Bot — Cloudflare Workers
 *  Based on TeleBot-style multi-file sharing system
 *  Features: /start, /upload, auto-delete, forward protection
 * ============================================================
 */

// ─── Config (set these in wrangler.toml [vars] or Dashboard) ─────────────────

const CUSTOM_CAPTION_PREFIX = ""; // e.g. "@YourChannel "
const CUSTOM_CAPTION_SUFFIX = ""; // e.g. "\n\nJoin @YourChannel"
const FORWARD_PROTECT       = false; // true = prevent forwarding
const AUTO_DELETE_SECONDS   = 900;  // 15 minutes = 900 seconds

// ─── Telegram API Base ────────────────────────────────────────────────────────

const TG   = (token) => `https://api.telegram.org/bot${token}`;
const TGFILE = (token) => `https://api.telegram.org/file/bot${token}`;

// ─── Main Entry ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    try {
      const url  = new URL(request.url);
      const path = url.pathname;

      if (request.method === "POST" && path === "/webhook") {
        return await handleWebhook(request, env);
      }

      if (request.method === "GET" && path.startsWith("/file/")) {
        return await serveFilePage(path.replace("/file/", ""), env);
      }

      if (path === "/ping") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error(err);
      return new Response("Error", { status: 500 });
    }
  },
};

// ─── Webhook ──────────────────────────────────────────────────────────────────

async function handleWebhook(request, env) {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update;
  try { update = await request.json(); }
  catch { return new Response("Bad Request", { status: 400 }); }

  await processUpdate(update, env);
  return new Response("OK");
}

// ─── Update Router ────────────────────────────────────────────────────────────

async function processUpdate(update, env) {
  try {
    if (update.message)         await handleMessage(update.message, env);
    if (update.callback_query)  await handleCallback(update.callback_query, env);
  } catch (e) {
    console.error("processUpdate:", e);
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

async function handleMessage(msg, env) {
  const chatId  = msg.chat.id;
  const userId  = msg.from.id;
  const text    = msg.text || "";

  // Register user
  await registerUser(msg.from, env);

  // ── /start (force sub check happens inside handleStart)
  if (text.startsWith("/start")) {
    const parts  = text.split(" ");
    const params = parts[1] || null;
    return await handleStart(chatId, userId, params, env);
  }

  // ── Force Subscribe check for all other commands
  if (!(await checkForceSub(userId, env))) {
    return await sendForceSubMsg(chatId, userId, null, env);
  }

  // ── /upload (admin only)
  if (text === "/upload" || text === `/upload@${env.BOT_USERNAME}`) {
    return await handleUpload(msg, env);
  }

  // ── /stats (admin only)
  if (text === "/stats" || text === `/stats@${env.BOT_USERNAME}`) {
    return await handleStats(msg, env);
  }

  // ── /broadcast (admin only)
  if (text.startsWith("/broadcast")) {
    return await handleBroadcast(msg, env);
  }

  // ── /cancel
  if (text === "/cancel" || text === `/cancel@${env.BOT_USERNAME}`) {
    await clearSession(userId, env);
    return await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "❌ Cancelled.",
    });
  }

  // ── ✅ Done button (finish upload)
  if (text === "✅") {
    return await handleDoneUpload(msg, env);
  }

  // ── File received during upload session
  if (hasMedia(msg)) {
    return await handleMediaReceive(msg, env);
  }
}

// ─── /start ───────────────────────────────────────────────────────────────────

async function handleStart(chatId, userId, params, env) {

  // No param → welcome screen (force sub check still applies)
  if (!params || params === "None") {
    // Force sub check
    if (!(await checkForceSub(userId, env))) {
      return await sendForceSubMsg(chatId, userId, null, env);
    }
    return await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "<b>Welcome to Secure File Storage Bot!</b>\n\n" +
        "⚡ <b>How to use:</b>\n" +
        "1. Send <code>/upload</code> and forward any file, photo, video, audio or sticker.\n" +
        "2. When done press ✅ to get a shareable link.\n\n" +
        "🚀 Start sharing your files now!",
      parse_mode: "html",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📤 Start Uploading", callback_data: "cmd_upload" }],
          [{ text: "📞 Contact", url: `https://t.me/${env.BOT_USERNAME}` }],
        ],
      },
    });
  }

  // Has param → serve the media bundle
  // Force sub check before showing files
  if (!(await checkForceSub(userId, env))) {
    return await sendForceSubMsg(chatId, userId, params, env);
  }

  const mediaId = params;
  const files   = await getMediaBundle(mediaId, env);

  if (!files || files.length === 0) {
    return await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "❌ No media found for this link. It may have been deleted.",
    });
  }

  const sentMsgIds = [];

  for (const f of files) {
    let caption = (f.caption || "").trim();
    caption = CUSTOM_CAPTION_PREFIX + caption + CUSTOM_CAPTION_SUFFIX;

    let result = null;
    const base = {
      chat_id: chatId,
      caption,
      parse_mode: "html",
      protect_content: FORWARD_PROTECT,
    };

    if      (f.type === "photo")     result = await tg(env, "sendPhoto",     { ...base, photo:     f.file_id });
    else if (f.type === "video")     result = await tg(env, "sendVideo",     { ...base, video:     f.file_id });
    else if (f.type === "audio")     result = await tg(env, "sendAudio",     { ...base, audio:     f.file_id });
    else if (f.type === "voice")     result = await tg(env, "sendVoice",     { ...base, voice:     f.file_id });
    else if (f.type === "document")  result = await tg(env, "sendDocument",  { ...base, document:  f.file_id });
    else if (f.type === "animation") result = await tg(env, "sendAnimation", { ...base, animation: f.file_id });
    else if (f.type === "sticker")   result = await tg(env, "sendSticker",   { chat_id: chatId, sticker: f.file_id, protect_content: FORWARD_PROTECT });

    if (result?.ok && result.result?.message_id) {
      sentMsgIds.push(result.result.message_id);
    }
  }

  // Auto-delete note
  const note = await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      `⚠️ <b>Note:</b> Files will be auto-deleted after <b>${Math.floor(AUTO_DELETE_SECONDS / 60)} minutes</b> to prevent spam.`,
    parse_mode: "html",
    reply_markup: {
      inline_keyboard: [[
        { text: "🔗 Share Bot", url: `https://t.me/${env.BOT_USERNAME}` },
      ]],
    },
  });

  if (note?.ok && note.result?.message_id) {
    sentMsgIds.push(note.result.message_id);
  }

  // Schedule auto-delete via KV delayed task
  if (sentMsgIds.length > 0) {
    await scheduleDelete(chatId, sentMsgIds, mediaId, env);
  }
}

// ─── /upload ──────────────────────────────────────────────────────────────────

async function handleUpload(msg, env) {
  const { chat, from } = msg;

  if (!isAdmin(from.id, env)) {
    return await tg(env, "sendMessage", {
      chat_id: chat.id,
      text: "🚫 You are not authorized to use this command!",
    });
  }

  const mediaId = generateUID();
  await setSession(from.id, { state: "uploading", mediaId, files: [] }, env);

  await tg(env, "sendMessage", {
    chat_id: chat.id,
    text:
      "📤 <b>Upload Mode Active!</b>\n\n" +
      "Send me files one by one (photos, videos, documents, audio, stickers).\n\n" +
      "When done, tap <b>✅</b> or send <code>/done</code>.",
    parse_mode: "html",
    reply_markup: {
      keyboard: [["✅"]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

// ─── Receive Media During Upload ──────────────────────────────────────────────

async function handleMediaReceive(msg, env) {
  const { chat, from } = msg;
  const session = await getSession(from.id, env);

  if (!session || session.state !== "uploading") {
    // Not in upload mode — ignore silently
    return;
  }

  const fileMeta = extractFileMeta(msg);
  if (!fileMeta) return;

  session.files.push(fileMeta);
  await setSession(from.id, session, env);

  await tg(env, "sendMessage", {
    chat_id: chat.id,
    text: `✅ File <b>${session.files.length}</b> received: <code>${escapeHtml(fileMeta.file_name)}</code>\n\nSend more or tap ✅ when done.`,
    parse_mode: "html",
    reply_markup: {
      keyboard: [["✅"]],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  });
}

// ─── ✅ Done — Finalize Upload ─────────────────────────────────────────────────

async function handleDoneUpload(msg, env) {
  const { chat, from } = msg;
  const session = await getSession(from.id, env);

  if (!session || session.state !== "uploading") {
    return await tg(env, "sendMessage", {
      chat_id: chat.id,
      text: "⚠️ You are not in upload mode. Use /upload first.",
    });
  }

  if (!session.files || session.files.length === 0) {
    return await tg(env, "sendMessage", {
      chat_id: chat.id,
      text: "⚠️ No files received yet! Send some files first.",
    });
  }

  // Save media bundle
  await saveMediaBundle(session.mediaId, session.files, env);
  await clearSession(from.id, env);
  await incrementCounter("total_files", env);

  const shareLink = `https://t.me/${env.BOT_USERNAME}?start=${session.mediaId}`;
  const workerLink = `${env.WORKER_URL || "https://yourbot.workers.dev"}/file/${session.mediaId}`;

  await tg(env, "sendMessage", {
    chat_id: chat.id,
    text:
      `✅ <b>Upload Complete!</b>\n\n` +
      `📦 Files: <b>${session.files.length}</b>\n` +
      `🆔 Media ID: <code>${session.mediaId}</code>\n\n` +
      `🔗 <b>Share Link (Telegram):</b>\n<code>${shareLink}</code>\n\n` +
      `🌐 <b>Web Link:</b>\n<code>${workerLink}</code>`,
    parse_mode: "html",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📲 Share Link", url: `https://t.me/share/url?url=${encodeURIComponent(shareLink)}` }],
        [{ text: "🌐 Web Preview", url: workerLink }],
      ],
      remove_keyboard: true,
    },
  });
}

// ─── Callback Handler ─────────────────────────────────────────────────────────

async function handleCallback(query, env) {
  await tg(env, "answerCallbackQuery", { callback_query_id: query.id });

  if (query.data === "cmd_upload") {
    const fakeMsg = { chat: query.message.chat, from: query.from, text: "/upload" };
    return await handleUpload(fakeMsg, env);
  }
}

// ─── Admin: Stats ─────────────────────────────────────────────────────────────

async function handleStats(msg, env) {
  if (!isAdmin(msg.from.id, env)) {
    return await tg(env, "sendMessage", { chat_id: msg.chat.id, text: "⛔ Admin only." });
  }

  const totalFiles = (await env.KV.get("counter:total_files")) || "0";
  const totalUsers = (await env.KV.get("counter:total_users")) || "0";

  await tg(env, "sendMessage", {
    chat_id: msg.chat.id,
    text:
      `📊 <b>Bot Statistics</b>\n\n` +
      `👥 Users: <b>${totalUsers}</b>\n` +
      `📁 Files Uploaded: <b>${totalFiles}</b>\n` +
      `🤖 Bot: @${env.BOT_USERNAME}`,
    parse_mode: "html",
  });
}

// ─── Admin: Broadcast ─────────────────────────────────────────────────────────

async function handleBroadcast(msg, env) {
  if (!isAdmin(msg.from.id, env)) {
    return await tg(env, "sendMessage", { chat_id: msg.chat.id, text: "⛔ Admin only." });
  }

  const text = msg.text.replace("/broadcast", "").trim();
  if (!text) return await tg(env, "sendMessage", { chat_id: msg.chat.id, text: "Usage: /broadcast <message>" });

  const users = await getAllUsers(env);
  let sent = 0, failed = 0;

  for (const uid of users) {
    try {
      await tg(env, "sendMessage", { chat_id: uid, text, parse_mode: "html" });
      sent++;
    } catch { failed++; }
  }

  await tg(env, "sendMessage", {
    chat_id: msg.chat.id,
    text: `📢 Broadcast done!\n✅ Sent: ${sent}\n❌ Failed: ${failed}`,
  });
}

// ─── Auto Delete (KV-based delayed delete) ───────────────────────────────────

async function scheduleDelete(chatId, messageIds, mediaId, env) {
  // Store delete task with expiry
  const task = { chatId, messageIds, mediaId, deleteAt: Date.now() + AUTO_DELETE_SECONDS * 1000 };
  await env.KV.put(
    `deletetask:${chatId}:${Date.now()}`,
    JSON.stringify(task),
    { expirationTtl: AUTO_DELETE_SECONDS + 60 }
  );
  // Note: Cloudflare Workers doesn't support true background timers.
  // Auto-delete executes on next webhook request using checkPendingDeletes().
}

async function checkPendingDeletes(env) {
  try {
    const list = await env.KV.list({ prefix: "deletetask:" });
    const now  = Date.now();

    for (const key of list.keys) {
      const raw = await env.KV.get(key.name);
      if (!raw) continue;

      const task = JSON.parse(raw);
      if (now >= task.deleteAt) {
        // Delete messages
        for (const msgId of task.messageIds) {
          try {
            await tg(env, "deleteMessage", { chat_id: task.chatId, message_id: msgId });
          } catch {}
        }
        await env.KV.delete(key.name);
      }
    }
  } catch (e) {
    console.error("checkPendingDeletes:", e);
  }
}

// ─── Web File Preview Page ────────────────────────────────────────────────────

async function serveFilePage(mediaId, env) {
  const files = await getMediaBundle(mediaId, env);

  if (!files || files.length === 0) {
    return new Response(errorHtml("Not Found", "This link is invalid or has expired."), {
      status: 404,
      headers: { "Content-Type": "text/html;charset=utf-8" },
    });
  }

  const botUser   = env.BOT_USERNAME || "filebot";
  const shareLink = `https://t.me/${botUser}?start=${mediaId}`;

  const fileCards = files.map((f, i) => {
    const icon = { photo:"🖼️", video:"🎬", audio:"🎵", document:"📄", sticker:"🎭", voice:"🎙️", animation:"🎞️" }[f.type] || "📁";
    return `
    <div class="card">
      <div class="card-icon">${icon}</div>
      <div class="card-info">
        <div class="card-name">${escapeHtml(f.file_name)}</div>
        <div class="card-meta">
          <span class="tag">${f.type.toUpperCase()}</span>
          <span class="tag">${humanSize(f.file_size)}</span>
        </div>
      </div>
    </div>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>File Bundle — ${mediaId}</title>
<style>
:root{--bg:#0d0d0f;--surface:#16161a;--border:#2a2a35;--accent:#7c3aed;--accent2:#a855f7;--text:#e2e2e8;--muted:#8888a0}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:2rem 1rem}
.wrap{max-width:600px;margin:0 auto}
.header{text-align:center;margin-bottom:2rem}
.logo{font-size:3rem;margin-bottom:.5rem}
h1{font-size:1.6rem;font-weight:700;margin-bottom:.3rem}
.sub{color:var(--muted);font-size:.9rem}
.card{display:flex;align-items:center;gap:1rem;padding:1rem;background:var(--surface);border:1px solid var(--border);border-radius:12px;margin-bottom:.8rem}
.card-icon{font-size:2rem;flex-shrink:0}
.card-name{font-weight:600;margin-bottom:.3rem;word-break:break-all}
.card-meta{display:flex;gap:.4rem;flex-wrap:wrap}
.tag{background:#1e1e24;border:1px solid var(--border);border-radius:6px;padding:.2rem .5rem;font-size:.75rem;color:var(--muted)}
.btn{display:block;width:100%;padding:.9rem;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer;text-align:center;text-decoration:none;margin-top:1.5rem}
.btn:hover{opacity:.85}
.note{text-align:center;color:var(--muted);font-size:.8rem;margin-top:1rem}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="logo">📦</div>
    <h1>Shared Files</h1>
    <p class="sub">${files.length} file${files.length !== 1 ? "s" : ""} · Open in Telegram to download</p>
  </div>
  ${fileCards}
  <a href="${shareLink}" class="btn">📲 Open in Telegram Bot</a>
  <p class="note">Files auto-delete after ${Math.floor(AUTO_DELETE_SECONDS / 60)} minutes of viewing</p>
</div>
</body></html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=utf-8" },
  });
}

function errorHtml(title, msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>
  <style>body{font-family:system-ui;background:#0d0d0f;color:#e2e2e8;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
  h1{font-size:3rem;color:#a855f7}p{color:#8888a0;margin-top:.5rem}</style></head>
  <body><div><h1>404</h1><h2>${title}</h2><p>${msg}</p></div></body></html>`;
}

// ─── Force Subscribe ──────────────────────────────────────────────────────────

/**
 * FORCE_SUB_CHANNELS env var format (set in Cloudflare Dashboard):
 * Single:   -1001234567890
 * Multiple: -1001234567890,-1009876543210,-1001122334455
 *
 * Bot must be admin in each channel.
 */

async function checkForceSub(userId, env) {
  // Admins bypass force sub
  if (isAdmin(userId, env)) return true;

  const raw = env.FORCE_SUB_CHANNELS || "";
  const channels = raw.split(",").map((c) => c.trim()).filter(Boolean);

  // No channels configured → allow all
  if (channels.length === 0) return true;

  for (const channelId of channels) {
    try {
      const res    = await tg(env, "getChatMember", { chat_id: channelId, user_id: userId });
      const status = res?.result?.status;
      if (!["member", "administrator", "creator"].includes(status)) {
        return false; // not joined this channel
      }
    } catch {
      return false; // API error = treat as not joined
    }
  }

  return true; // joined all channels
}

async function sendForceSubMsg(chatId, userId, pendingParam, env) {
  const raw      = env.FORCE_SUB_CHANNELS || "";
  const channels = raw.split(",").map((c) => c.trim()).filter(Boolean);

  // Build join buttons — one per channel
  const joinButtons = [];
  for (const channelId of channels) {
    // Try to get channel invite link / username
    let btnText = `📢 Join Channel`;
    let btnUrl  = null;

    try {
      const info = await tg(env, "getChat", { chat_id: channelId });
      if (info?.result) {
        const chat = info.result;
        if (chat.username) {
          btnText = `📢 Join @${chat.username}`;
          btnUrl  = `https://t.me/${chat.username}`;
        } else if (chat.invite_link) {
          btnText = `📢 Join ${chat.title || "Channel"}`;
          btnUrl  = chat.invite_link;
        } else {
          // No public link — create invite link
          const inv = await tg(env, "exportChatInviteLink", { chat_id: channelId });
          btnUrl  = inv?.result || null;
          btnText = `📢 Join ${chat.title || "Channel"}`;
        }
      }
    } catch {}

    if (btnUrl) {
      joinButtons.push([{ text: btnText, url: btnUrl }]);
    }
  }

  // "I've Joined" button — re-triggers /start with same param
  const checkData = pendingParam
    ? `fsub_check_${pendingParam}`
    : `fsub_check_none`;

  joinButtons.push([{ text: "✅ I've Joined — Check Again", callback_data: checkData }]);

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      "🔒 <b>Access Restricted</b>\n\n" +
      "You must join the following channel(s) to use this bot:\n\n" +
      channels.map((_, i) => `${i + 1}. Channel ${i + 1}`).join("\n") +
      "\n\nAfter joining, tap <b>✅ I've Joined</b> below.",
    parse_mode: "html",
    reply_markup: { inline_keyboard: joinButtons },
  });
}

// ─── KV Helpers ───────────────────────────────────────────────────────────────

async function saveMediaBundle(mediaId, files, env) {
  await env.KV.put(`media:${mediaId}`, JSON.stringify(files));
}

async function getMediaBundle(mediaId, env) {
  const raw = await env.KV.get(`media:${mediaId}`);
  return raw ? JSON.parse(raw) : null;
}

async function setSession(userId, data, env) {
  await env.KV.put(`session:${userId}`, JSON.stringify(data), { expirationTtl: 3600 });
}

async function getSession(userId, env) {
  const raw = await env.KV.get(`session:${userId}`);
  return raw ? JSON.parse(raw) : null;
}

async function clearSession(userId, env) {
  await env.KV.delete(`session:${userId}`);
}

async function registerUser(from, env) {
  const key = `user:${from.id}`;
  const ex  = await env.KV.get(key);
  if (!ex) {
    await env.KV.put(key, JSON.stringify({ id: from.id, username: from.username || null, first_name: from.first_name || null, joined: Date.now() }));
    await incrementCounter("total_users", env);
  }
}

async function getAllUsers(env) {
  const list = await env.KV.list({ prefix: "user:" });
  return list.keys.map((k) => k.name.replace("user:", ""));
}

async function incrementCounter(name, env) {
  const key = `counter:${name}`;
  const cur = parseInt((await env.KV.get(key)) || "0", 10);
  await env.KV.put(key, String(cur + 1));
}

// ─── Telegram API ─────────────────────────────────────────────────────────────

async function tg(env, method, params = {}) {
  const res = await fetch(`${TG(env.BOT_TOKEN)}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

// ─── Utility Helpers ──────────────────────────────────────────────────────────

function extractFileMeta(msg) {
  if (msg.document)  return { type: "document",  file_id: msg.document.file_id,  file_name: msg.document.file_name  || "file",      file_size: msg.document.file_size  || 0, caption: msg.caption || "" };
  if (msg.video)     return { type: "video",     file_id: msg.video.file_id,     file_name: msg.video.file_name     || "video.mp4",  file_size: msg.video.file_size     || 0, caption: msg.caption || "" };
  if (msg.audio)     return { type: "audio",     file_id: msg.audio.file_id,     file_name: msg.audio.file_name     || "audio.mp3",  file_size: msg.audio.file_size     || 0, caption: msg.caption || "" };
  if (msg.voice)     return { type: "voice",     file_id: msg.voice.file_id,     file_name: "voice.ogg",                            file_size: msg.voice.file_size     || 0, caption: msg.caption || "" };
  if (msg.animation) return { type: "animation", file_id: msg.animation.file_id, file_name: "animation.mp4",                        file_size: msg.animation.file_size || 0, caption: msg.caption || "" };
  if (msg.sticker)   return { type: "sticker",   file_id: msg.sticker.file_id,   file_name: "sticker.webp",                         file_size: msg.sticker.file_size   || 0, caption: "" };
  if (msg.photo) {
    const p = msg.photo[msg.photo.length - 1];
    return { type: "photo", file_id: p.file_id, file_name: "photo.jpg", file_size: p.file_size || 0, caption: msg.caption || "" };
  }
  return null;
}

function hasMedia(msg) {
  return !!(msg.document || msg.video || msg.audio || msg.voice || msg.animation || msg.sticker || msg.photo);
}

function generateUID() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const arr   = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => chars[b % chars.length]).join("");
}

function humanSize(bytes) {
  if (!bytes) return "Unknown";
  const u = ["B","KB","MB","GB"];
  let i = 0, s = bytes;
  while (s >= 1024 && i < u.length - 1) { s /= 1024; i++; }
  return `${s.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function escapeHtml(t) {
  return String(t || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function isAdmin(userId, env) {
  if (!env.ADMINS) return false;
  return env.ADMINS.split(",").map((a) => a.trim()).includes(String(userId));
}
