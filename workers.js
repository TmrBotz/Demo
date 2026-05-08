const CUSTOM_CAPTION_PREFIX = "@Zozo_Boss ";
const CUSTOM_CAPTION_SUFFIX = "\n\n𝖩𝗈𝗂𝗇  ➥ 「 @Zozo_Boss 」";
const FORWARD_PROTECT = true;
const AUTO_DELETE_SECONDS = 900;
const TG = (token) => `https://api.telegram.org/bot${token}`;

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method === "POST" && path === "/webhook") {
        return await handleWebhook(request, env);
      }
      if (path === "/ping") {
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error(err);
      return new Response("Error", { status: 500 });
    }
  },
};

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

async function processUpdate(update, env) {
  try {
    await checkPendingDeletes(env);
    if (update.message) await handleMessage(update.message, env);
    if (update.callback_query) await handleCallback(update.callback_query, env);
  } catch (e) {
    console.error("processUpdate:", e);
  }
}

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || "";

  await registerUser(message.from, env);

  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    const params = parts[1] || null;
    if (!(await checkForceSub(userId, env))) {
      return await sendForceSubMsg(chatId, userId, params, env);
    }
    return await handleStart(message, params, env);
  }

  if (!(await checkForceSub(userId, env))) {
    return await sendForceSubMsg(chatId, userId, null, env);
  }

  if (text === "/upload" || text === `/upload@${env.BOT_USERNAME}`) {
    return await handleUpload(message, env);
  }

  if (text === "/stats" || text === `/stats@${env.BOT_USERNAME}`) {
    return await handleStats(message, env);
  }

  if (text.startsWith("/broadcast")) {
    return await handleBroadcast(message, env);
  }

  if (text === "/cancel" || text === `/cancel@${env.BOT_USERNAME}`) {
    await clearSession(userId, env);
    return await tg(env, "sendMessage", { chat_id: chatId, text: "❌ Cancelled.", reply_markup: { remove_keyboard: true } });
  }

  if (text === "✅") {
    return await handleDoneUpload(message, env);
  }

  if (hasMedia(message)) {
    return await handleMedia(message, env);
  }
}

async function handleStart(message, params, env) {
  const chatId = message.chat.id;

  if (!params || params === "None") {
    return await tg(env, "sendMessage", {
      chat_id: chatId,
      text: (
        "<b>Welcome to Secure File Storage Bot!</b>\n\n" +
        "⚡ <b>How to use:</b>\n" +
        "1. Send <code>/upload</code> and forward any file, photo, video, or sticker.\n\n" +
        "🚀 Start sharing your files now!"
      ),
      parse_mode: "html",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📤 Start Uploading", callback_data: "cmd_upload" }],
          [{ text: "📞 Contact", url: `https://t.me/${env.BOT_USERNAME}` }],
        ],
      },
    });
  }

  const media_id = params;
  const files = await getData(media_id, env);

  if (!files || files.length === 0) {
    return await tg(env, "sendMessage", { chat_id: chatId, text: "❌ No media found for this link." });
  }

  const sent_msgs = [];

  for (const f of files) {
    let m = null;
    let caption = (f.caption || "") ;
    caption = CUSTOM_CAPTION_PREFIX + caption.trim() + CUSTOM_CAPTION_SUFFIX;

    const base = { chat_id: chatId, caption, parse_mode: "html", protect_content: FORWARD_PROTECT };

    if      (f.type === "photo")     m = await tg(env, "sendPhoto",     { ...base, photo:     f.file_id });
    else if (f.type === "video")     m = await tg(env, "sendVideo",     { ...base, video:     f.file_id });
    else if (f.type === "audio")     m = await tg(env, "sendAudio",     { ...base, audio:     f.file_id });
    else if (f.type === "voice")     m = await tg(env, "sendVoice",     { ...base, voice:     f.file_id });
    else if (f.type === "document")  m = await tg(env, "sendDocument",  { ...base, document:  f.file_id });
    else if (f.type === "animation") m = await tg(env, "sendAnimation", { ...base, animation: f.file_id });
    else if (f.type === "sticker")   m = await tg(env, "sendSticker",   { chat_id: chatId, sticker: f.file_id, protect_content: FORWARD_PROTECT });

    if (m && m.result && m.result.message_id) {
      sent_msgs.push(m.result.message_id);
    }
  }

  const note = await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "⚠️ <b>Note:</b> Files will be auto-deleted after <b>15 minutes</b> to prevent spam.",
    parse_mode: "html",
    reply_markup: {
      inline_keyboard: [[
        { text: "🔗 Join Channel", url: "https://t.me/Zozo_Boss" },
      ]],
    },
  });

  if (note && note.result && note.result.message_id) {
    sent_msgs.push(note.result.message_id);
  }

  if (sent_msgs.length > 0) {
    const deleteAt = Date.now() + AUTO_DELETE_SECONDS * 1000;
    await env.KV.put(
      `deletetask:${chatId}:${Date.now()}`,
      JSON.stringify({ chatId, messageIds: sent_msgs, media_id, deleteAt }),
      { expirationTtl: AUTO_DELETE_SECONDS + 120 }
    );
  }
}

async function handleUpload(message, env) {
  const chatId = message.chat.id;
  const userId = message.from.id;

  const ADMIN_IDS = (env.ADMINS || "").split(",").map((a) => a.trim());

  if (!ADMIN_IDS.includes(String(userId))) {
    return await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "🚫 You are not authorized to use this command!",
      parse_mode: "html",
    });
  }

  const media_id = genId();
  await setSession(userId, { state: "uploading", media_id, files: [] }, env);

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "👉 Send me the files you want to upload. When you are done, tap ✅.",
    reply_markup: {
      keyboard: [["✅"]],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  });
}

async function handleMedia(message, env) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const session = await getSession(userId, env);

  if (!session || session.state !== "uploading") return;

  const fileMeta = extractFileMeta(message);
  if (!fileMeta) return;

  session.files.push(fileMeta);
  await setSession(userId, session, env);

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `✅ File <b>${session.files.length}</b> added: <code>${escHtml(fileMeta.file_name)}</code>\n\nSend more or tap ✅ when done.`,
    parse_mode: "html",
    reply_markup: {
      keyboard: [["✅"]],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  });
}

async function handleDoneUpload(message, env) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const session = await getSession(userId, env);

  if (!session || session.state !== "uploading") {
    return await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ You are not in upload mode. Use /upload first.",
      reply_markup: { remove_keyboard: true },
    });
  }

  if (!session.files || session.files.length === 0) {
    return await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ No files received yet! Send some files first.",
    });
  }

  await saveData(session.media_id, session.files, env);
  await clearSession(userId, env);
  await incrementCounter("total_files", env);

  const shareLink = `https://t.me/${env.BOT_USERNAME}?start=${session.media_id}`;

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      `✅ <b>Upload Complete!</b>\n\n` +
      `📦 Files: <b>${session.files.length}</b>\n` +
      `🆔 Media ID: <code>${session.media_id}</code>\n\n` +
      `🔗 <b>Share Link:</b>\n<code>${shareLink}</code>`,
    parse_mode: "html",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📲 Share Link", url: `https://t.me/share/url?url=${encodeURIComponent(shareLink)}` }],
      ],
      remove_keyboard: true,
    },
  });
}

async function handleCallback(query, env) {
  await tg(env, "answerCallbackQuery", { callback_query_id: query.id });
  const data = query.data;
  const fakeMsg = { chat: query.message.chat, from: query.from, text: "" };

  if (data === "cmd_upload") {
    fakeMsg.text = "/upload";
    return await handleUpload(fakeMsg, env);
  }

  if (data.startsWith("fsub_check_")) {
    const pendingParam = data.replace("fsub_check_", "");
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    if (!(await checkForceSub(userId, env))) {
      return await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "❌ You have not joined all required channels yet. Please join and try again.",
      });
    }
    const param = pendingParam === "none" ? null : pendingParam;
    return await handleStart({ chat: { id: chatId }, from: query.from }, param, env);
  }
}

async function handleStats(message, env) {
  const ADMIN_IDS = (env.ADMINS || "").split(",").map((a) => a.trim());
  if (!ADMIN_IDS.includes(String(message.from.id))) {
    return await tg(env, "sendMessage", { chat_id: message.chat.id, text: "⛔ Admin only." });
  }
  const totalFiles = (await env.KV.get("counter:total_files")) || "0";
  const totalUsers = (await env.KV.get("counter:total_users")) || "0";
  await tg(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `📊 <b>Bot Statistics</b>\n\n👥 Users: <b>${totalUsers}</b>\n📁 Files Uploaded: <b>${totalFiles}</b>`,
    parse_mode: "html",
  });
}

async function handleBroadcast(message, env) {
  const ADMIN_IDS = (env.ADMINS || "").split(",").map((a) => a.trim());
  if (!ADMIN_IDS.includes(String(message.from.id))) {
    return await tg(env, "sendMessage", { chat_id: message.chat.id, text: "⛔ Admin only." });
  }
  const text = message.text.replace("/broadcast", "").trim();
  if (!text) return await tg(env, "sendMessage", { chat_id: message.chat.id, text: "Usage: /broadcast <message>" });
  const users = await getAllUsers(env);
  let sent = 0, failed = 0;
  for (const uid of users) {
    try { await tg(env, "sendMessage", { chat_id: uid, text, parse_mode: "html" }); sent++; }
    catch { failed++; }
  }
  await tg(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `📢 Broadcast done!\n✅ Sent: ${sent}\n❌ Failed: ${failed}`,
  });
}

async function checkForceSub(userId, env) {
  const ADMIN_IDS = (env.ADMINS || "").split(",").map((a) => a.trim());
  if (ADMIN_IDS.includes(String(userId))) return true;
  const raw = env.FORCE_SUB_CHANNELS || "";
  const channels = raw.split(",").map((c) => c.trim()).filter(Boolean);
  if (channels.length === 0) return true;
  for (const channelId of channels) {
    try {
      const res = await tg(env, "getChatMember", { chat_id: channelId, user_id: userId });
      const status = res?.result?.status;
      if (!["member", "administrator", "creator"].includes(status)) return false;
    } catch { return false; }
  }
  return true;
}

async function sendForceSubMsg(chatId, userId, pendingParam, env) {
  const raw = env.FORCE_SUB_CHANNELS || "";
  const channels = raw.split(",").map((c) => c.trim()).filter(Boolean);
  const joinButtons = [];

  for (const channelId of channels) {
    let btnText = "📢 Join Channel";
    let btnUrl = null;
    try {
      const info = await tg(env, "getChat", { chat_id: channelId });
      if (info?.result) {
        const chat = info.result;
        if (chat.username) {
          btnText = `📢 Join @${chat.username}`;
          btnUrl = `https://t.me/${chat.username}`;
        } else if (chat.invite_link) {
          btnText = `📢 Join ${chat.title || "Channel"}`;
          btnUrl = chat.invite_link;
        } else {
          const inv = await tg(env, "exportChatInviteLink", { chat_id: channelId });
          btnUrl = inv?.result || null;
          btnText = `📢 Join ${chat.title || "Channel"}`;
        }
      }
    } catch {}
    if (btnUrl) joinButtons.push([{ text: btnText, url: btnUrl }]);
  }

  const checkData = pendingParam ? `fsub_check_${pendingParam}` : `fsub_check_none`;
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

async function checkPendingDeletes(env) {
  try {
    const list = await env.KV.list({ prefix: "deletetask:" });
    const now = Date.now();
    for (const key of list.keys) {
      const raw = await env.KV.get(key.name);
      if (!raw) continue;
      const task = JSON.parse(raw);
      if (now >= task.deleteAt) {
        for (const msgId of task.messageIds) {
          try { await tg(env, "deleteMessage", { chat_id: task.chatId, message_id: msgId }); } catch {}
        }
        await env.KV.delete(key.name);
      }
    }
  } catch (e) { console.error("checkPendingDeletes:", e); }
}

async function saveData(media_id, files, env) {
  await env.KV.put(`media:${media_id}`, JSON.stringify(files));
}

async function getData(media_id, env) {
  const raw = await env.KV.get(`media:${media_id}`);
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
  const ex = await env.KV.get(key);
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

async function tg(env, method, params = {}) {
  const res = await fetch(`${TG(env.BOT_TOKEN)}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

function extractFileMeta(msg) {
  if (msg.document)  return { type: "document",  file_id: msg.document.file_id,  file_name: msg.document.file_name  || "file",     file_size: msg.document.file_size  || 0, caption: msg.caption || "" };
  if (msg.video)     return { type: "video",     file_id: msg.video.file_id,     file_name: msg.video.file_name     || "video.mp4", file_size: msg.video.file_size     || 0, caption: msg.caption || "" };
  if (msg.audio)     return { type: "audio",     file_id: msg.audio.file_id,     file_name: msg.audio.file_name     || "audio.mp3", file_size: msg.audio.file_size     || 0, caption: msg.caption || "" };
  if (msg.voice)     return { type: "voice",     file_id: msg.voice.file_id,     file_name: "voice.ogg",                           file_size: msg.voice.file_size     || 0, caption: msg.caption || "" };
  if (msg.animation) return { type: "animation", file_id: msg.animation.file_id, file_name: "animation.mp4",                       file_size: msg.animation.file_size || 0, caption: msg.caption || "" };
  if (msg.sticker)   return { type: "sticker",   file_id: msg.sticker.file_id,   file_name: "sticker.webp",                        file_size: msg.sticker.file_size   || 0, caption: "" };
  if (msg.photo) {
    const p = msg.photo[msg.photo.length - 1];
    return { type: "photo", file_id: p.file_id, file_name: "photo.jpg", file_size: p.file_size || 0, caption: msg.caption || "" };
  }
  return null;
}

function hasMedia(msg) {
  return !!(msg.document || msg.video || msg.audio || msg.voice || msg.animation || msg.sticker || msg.photo);
}

function genId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => chars[b % chars.length]).join("");
}

function escHtml(t) {
  return String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
                             }
      
