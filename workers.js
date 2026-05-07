/*
============================================================
 TELEGRAM FILE STORE BOT — CLOUDFLARE WORKERS
 Advanced Multi Force Subscribe Version
============================================================
*/

const CUSTOM_CAPTION_PREFIX = "";
const CUSTOM_CAPTION_SUFFIX = "";
const FORWARD_PROTECT       = false;
const AUTO_DELETE_SECONDS   = 900;

const TG = (token) => `https://api.telegram.org/bot${token}`;

export default {
  async fetch(request, env) {

    try {

      await checkPendingDeletes(env);

      const url  = new URL(request.url);
      const path = url.pathname;

      if (request.method === "POST" && path === "/webhook") {
        return await handleWebhook(request, env);
      }

      if (request.method === "GET" && path.startsWith("/file/")) {
        return await serveFilePage(
          path.replace("/file/", ""),
          env
        );
      }

      return new Response("OK");

    } catch (e) {

      return new Response("Error", {
        status: 500,
      });

    }
  },
};



// ============================================================
// WEBHOOK
// ============================================================

async function handleWebhook(request, env) {

  const update = await request.json();

  if (update.message) {
    await handleMessage(update.message, env);
  }

  if (update.callback_query) {
    await handleCallback(update.callback_query, env);
  }

  return new Response("OK");
}



// ============================================================
// MESSAGE HANDLER
// ============================================================

async function handleMessage(msg, env) {

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text   = msg.text || "";

  await registerUser(msg.from, env);



  // ============================================================
  // START
  // ============================================================

  if (text.startsWith("/start")) {

    const param = text.split(" ")[1] || null;

    return await handleStart(
      chatId,
      userId,
      param,
      env
    );
  }



  // ============================================================
  // FORCE SUB CHECK
  // ============================================================

  if (!(await checkForceSub(userId, env))) {

    return await sendForceSubMsg(
      chatId,
      userId,
      null,
      env
    );
  }



  // ============================================================
  // ADMIN COMMANDS
  // ============================================================

  if (text === "/upload") {
    return await handleUpload(msg, env);
  }

  if (text === "/stats") {
    return await handleStats(msg, env);
  }

  if (text.startsWith("/broadcast")) {
    return await handleBroadcast(msg, env);
  }



  // ============================================================
  // FSUB COMMANDS
  // ============================================================

  if (text.startsWith("/addfsub")) {
    return await handleAddFsub(msg, env);
  }

  if (text.startsWith("/removefsub")) {
    return await handleRemoveFsub(msg, env);
  }

  if (text.startsWith("/fsubon")) {
    return await handleFsubToggle(msg, env, true);
  }

  if (text.startsWith("/fsuboff")) {
    return await handleFsubToggle(msg, env, false);
  }

  if (text === "/fsublist") {
    return await handleFsubList(msg, env);
  }



  // ============================================================
  // CANCEL
  // ============================================================

  if (text === "/cancel") {

    await clearSession(userId, env);

    return await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "❌ Cancelled",
    });
  }



  // ============================================================
  // DONE
  // ============================================================

  if (text === "✅") {
    return await handleDoneUpload(msg, env);
  }



  // ============================================================
  // MEDIA
  // ============================================================

  if (hasMedia(msg)) {
    return await handleMediaReceive(msg, env);
  }
}



// ============================================================
// START
// ============================================================

async function handleStart(chatId, userId, param, env) {

  if (!(await checkForceSub(userId, env))) {

    return await sendForceSubMsg(
      chatId,
      userId,
      param,
      env
    );
  }

  if (!param) {

    return await tg(env, "sendMessage", {

      chat_id: chatId,

      text:
        "📦 File Store Bot\n\n" +
        "/upload - upload files",

    });
  }

  const files = await getMediaBundle(param, env);

  if (!files) {

    return await tg(env, "sendMessage", {

      chat_id: chatId,
      text: "❌ Invalid Link",

    });
  }

  let ids = [];

  for (const f of files) {

    let result;

    const base = {

      chat_id: chatId,
      protect_content: FORWARD_PROTECT,

    };

    if (f.type === "document") {

      result = await tg(env, "sendDocument", {

        ...base,
        document: f.file_id,
        caption:
          CUSTOM_CAPTION_PREFIX +
          (f.caption || "") +
          CUSTOM_CAPTION_SUFFIX,

      });
    }

    if (f.type === "photo") {

      result = await tg(env, "sendPhoto", {

        ...base,
        photo: f.file_id,
        caption:
          CUSTOM_CAPTION_PREFIX +
          (f.caption || "") +
          CUSTOM_CAPTION_SUFFIX,

      });
    }

    if (f.type === "video") {

      result = await tg(env, "sendVideo", {

        ...base,
        video: f.file_id,
        caption:
          CUSTOM_CAPTION_PREFIX +
          (f.caption || "") +
          CUSTOM_CAPTION_SUFFIX,

      });
    }

    if (result?.result?.message_id) {
      ids.push(result.result.message_id);
    }
  }

  await scheduleDelete(
    chatId,
    ids,
    param,
    env
  );
}



// ============================================================
// UPLOAD
// ============================================================

async function handleUpload(msg, env) {

  if (!isAdmin(msg.from.id, env)) {

    return await tg(env, "sendMessage", {

      chat_id: msg.chat.id,
      text: "⛔ Admin only",

    });
  }

  const mediaId = generateUID();

  await setSession(msg.from.id, {

    state: "uploading",
    mediaId,
    files: [],

  }, env);

  await tg(env, "sendMessage", {

    chat_id: msg.chat.id,

    text:
      "📤 Upload Mode Started\n\n" +
      "Send files now\n" +
      "Press ✅ when done",

    reply_markup: {

      keyboard: [["✅"]],
      resize_keyboard: true,

    },

  });
}



// ============================================================
// RECEIVE MEDIA
// ============================================================

async function handleMediaReceive(msg, env) {

  const session = await getSession(
    msg.from.id,
    env
  );

  if (!session) return;

  const file = extractFileMeta(msg);

  if (!file) return;

  session.files.push(file);

  await setSession(
    msg.from.id,
    session,
    env
  );

  await tg(env, "sendMessage", {

    chat_id: msg.chat.id,

    text:
      `✅ Saved ${session.files.length} file(s)`,

  });
}



// ============================================================
// DONE
// ============================================================

async function handleDoneUpload(msg, env) {

  const session = await getSession(
    msg.from.id,
    env
  );

  if (!session) {

    return await tg(env, "sendMessage", {

      chat_id: msg.chat.id,
      text: "❌ Upload not started",

    });
  }

  await saveMediaBundle(
    session.mediaId,
    session.files,
    env
  );

  await clearSession(
    msg.from.id,
    env
  );

  const link =
    `https://t.me/${env.BOT_USERNAME}?start=${session.mediaId}`;

  await tg(env, "sendMessage", {

    chat_id: msg.chat.id,

    text:
      "✅ Upload Complete\n\n" +
      `${link}`,

  });
}



// ============================================================
// CALLBACK
// ============================================================

async function handleCallback(query, env) {

  await tg(env, "answerCallbackQuery", {

    callback_query_id: query.id,

  });

  if (query.data.startsWith("fsub_check_")) {

    const param =
      query.data.replace("fsub_check_", "");

    if (!(await checkForceSub(query.from.id, env))) {

      return await tg(env, "answerCallbackQuery", {

        callback_query_id: query.id,
        text: "❌ Join channels first",
        show_alert: true,

      });
    }

    return await handleStart(

      query.message.chat.id,
      query.from.id,
      param === "none" ? null : param,
      env

    );
  }
}



// ============================================================
// FORCE SUB SYSTEM
// ============================================================

async function handleAddFsub(msg, env) {

  if (!isAdmin(msg.from.id, env)) return;

  const args = msg.text.split(" ");

  if (args.length < 3) {

    return await tg(env, "sendMessage", {

      chat_id: msg.chat.id,

      text:
        "/addfsub -100xxxx req\n" +
        "/addfsub -100xxxx normal",

    });
  }

  const channelId = args[1];

  const mode =
    args[2].toLowerCase() === "req"
      ? "req"
      : "normal";

  let channels = await getFsubChannels(env);

  channels.push({

    id: channelId,
    mode,
    enabled: true,

  });

  await saveFsubChannels(channels, env);

  await tg(env, "sendMessage", {

    chat_id: msg.chat.id,

    text:
      `✅ Added\n${channelId}\nMode: ${mode}`,

  });
}



async function handleRemoveFsub(msg, env) {

  if (!isAdmin(msg.from.id, env)) return;

  const args = msg.text.split(" ");

  const channelId = args[1];

  let channels = await getFsubChannels(env);

  channels =
    channels.filter(c => c.id !== channelId);

  await saveFsubChannels(channels, env);

  await tg(env, "sendMessage", {

    chat_id: msg.chat.id,
    text: "❌ Removed",

  });
}



async function handleFsubToggle(msg, env, state) {

  if (!isAdmin(msg.from.id, env)) return;

  const args = msg.text.split(" ");

  const channelId = args[1];

  let channels = await getFsubChannels(env);

  channels = channels.map(c => {

    if (c.id === channelId) {
      c.enabled = state;
    }

    return c;
  });

  await saveFsubChannels(channels, env);

  await tg(env, "sendMessage", {

    chat_id: msg.chat.id,

    text:
      `${state ? "✅ Enabled" : "❌ Disabled"}`,

  });
}



async function handleFsubList(msg, env) {

  if (!isAdmin(msg.from.id, env)) return;

  const channels = await getFsubChannels(env);

  let text = "📢 FORCE SUB LIST\n\n";

  if (!channels.length) {
    text += "No channels";
  }

  channels.forEach((c, i) => {

    text +=
      `${i + 1}. ${c.id}\n` +
      `Mode: ${c.mode}\n` +
      `Status: ${c.enabled ? "ON" : "OFF"}\n\n`;

  });

  await tg(env, "sendMessage", {

    chat_id: msg.chat.id,
    text,

  });
}



async function checkForceSub(userId, env) {

  if (isAdmin(userId, env)) return true;

  const channels = await getFsubChannels(env);

  const enabled =
    channels.filter(c => c.enabled);

  for (const channel of enabled) {

    if (channel.mode === "normal") {
      continue;
    }

    try {

      const res = await tg(env, "getChatMember", {

        chat_id: channel.id,
        user_id: userId,

      });

      const status =
        res?.result?.status;

      if (
        ![
          "member",
          "administrator",
          "creator",
        ].includes(status)
      ) {
        return false;
      }

    } catch {

      return false;

    }
  }

  return true;
}



async function sendForceSubMsg(
  chatId,
  userId,
  param,
  env
) {

  const channels = await getFsubChannels(env);

  const enabled =
    channels.filter(c => c.enabled);

  let buttons = [];

  for (const channel of enabled) {

    try {

      const info = await tg(env, "getChat", {

        chat_id: channel.id,

      });

      const chat = info.result;

      let url;

      if (chat.username) {
        url = `https://t.me/${chat.username}`;
      }

      else if (chat.invite_link) {
        url = chat.invite_link;
      }

      if (url) {

        buttons.push([{

          text:
            `📢 ${chat.title || "Channel"}`,

          url,

        }]);
      }

    } catch {}
  }

  buttons.push([{

    text: "✅ I've Joined",

    callback_data:
      param
        ? `fsub_check_${param}`
        : "fsub_check_none",

  }]);

  await tg(env, "sendMessage", {

    chat_id: chatId,

    text:
      "🔒 Join required channels first",

    reply_markup: {

      inline_keyboard: buttons,

    },

  });
}



// ============================================================
// FSUB KV
// ============================================================

async function getFsubChannels(env) {

  const raw =
    await env.KV.get("fsub_channels");

  if (!raw) return [];

  try {

    return JSON.parse(raw);

  } catch {

    return [];

  }
}

async function saveFsubChannels(data, env) {

  await env.KV.put(
    "fsub_channels",
    JSON.stringify(data)
  );
}



// ============================================================
// STATS
// ============================================================

async function handleStats(msg, env) {

  if (!isAdmin(msg.from.id, env)) return;

  const users =
    await env.KV.get("counter:users");

  const files =
    await env.KV.get("counter:files");

  await tg(env, "sendMessage", {

    chat_id: msg.chat.id,

    text:
      `👥 Users: ${users || 0}\n` +
      `📦 Files: ${files || 0}`,

  });
}



// ============================================================
// BROADCAST
// ============================================================

async function handleBroadcast(msg, env) {

  if (!isAdmin(msg.from.id, env)) return;

  const text =
    msg.text.replace("/broadcast", "").trim();

  if (!text) return;

  const users = await getAllUsers(env);

  for (const id of users) {

    try {

      await tg(env, "sendMessage", {

        chat_id: id,
        text,

      });

    } catch {}

  }

  await tg(env, "sendMessage", {

    chat_id: msg.chat.id,
    text: "✅ Broadcast done",

  });
}



// ============================================================
// DELETE SYSTEM
// ============================================================

async function scheduleDelete(
  chatId,
  ids,
  mediaId,
  env
) {

  const task = {

    chatId,
    ids,
    mediaId,
    deleteAt:
      Date.now() +
      AUTO_DELETE_SECONDS * 1000,

  };

  await env.KV.put(

    `delete:${Date.now()}`,

    JSON.stringify(task),

    {
      expirationTtl:
        AUTO_DELETE_SECONDS + 60,
    }

  );
}



async function checkPendingDeletes(env) {

  const list =
    await env.KV.list({
      prefix: "delete:",
    });

  const now = Date.now();

  for (const key of list.keys) {

    const raw =
      await env.KV.get(key.name);

    if (!raw) continue;

    const task = JSON.parse(raw);

    if (now >= task.deleteAt) {

      for (const id of task.ids) {

        try {

          await tg(env, "deleteMessage", {

            chat_id: task.chatId,
            message_id: id,

          });

        } catch {}

      }

      await env.KV.delete(key.name);
    }
  }
}



// ============================================================
// WEB PAGE
// ============================================================

async function serveFilePage(mediaId, env) {

  return new Response(
    `<h1>Open in Telegram Bot</h1>`,
    {
      headers: {
        "Content-Type": "text/html",
      },
    }
  );
}



// ============================================================
// KV HELPERS
// ============================================================

async function saveMediaBundle(id, files, env) {

  await env.KV.put(
    `media:${id}`,
    JSON.stringify(files)
  );
}

async function getMediaBundle(id, env) {

  const raw =
    await env.KV.get(`media:${id}`);

  return raw
    ? JSON.parse(raw)
    : null;
}



async function setSession(id, data, env) {

  await env.KV.put(

    `session:${id}`,

    JSON.stringify(data),

    {
      expirationTtl: 3600,
    }

  );
}

async function getSession(id, env) {

  const raw =
    await env.KV.get(`session:${id}`);

  return raw
    ? JSON.parse(raw)
    : null;
}

async function clearSession(id, env) {

  await env.KV.delete(`session:${id}`);

}



async function registerUser(user, env) {

  const key = `user:${user.id}`;

  const ex =
    await env.KV.get(key);

  if (!ex) {

    await env.KV.put(
      key,
      JSON.stringify(user)
    );

    const cur = parseInt(
      (await env.KV.get("counter:users")) || "0"
    );

    await env.KV.put(
      "counter:users",
      String(cur + 1)
    );
  }
}



async function getAllUsers(env) {

  const list =
    await env.KV.list({
      prefix: "user:",
    });

  return list.keys.map(
    k => k.name.replace("user:", "")
  );
}



// ============================================================
// TELEGRAM API
// ============================================================

async function tg(env, method, params = {}) {

  const res = await fetch(

    `${TG(env.BOT_TOKEN)}/${method}`,

    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify(params),
    }
  );

  return res.json();
}



// ============================================================
// UTILITIES
// ============================================================

function extractFileMeta(msg) {

  if (msg.document) {

    return {

      type: "document",
      file_id: msg.document.file_id,
      caption: msg.caption || "",

    };
  }

  if (msg.photo) {

    return {

      type: "photo",

      file_id:
        msg.photo[msg.photo.length - 1].file_id,

      caption: msg.caption || "",

    };
  }

  if (msg.video) {

    return {

      type: "video",
      file_id: msg.video.file_id,
      caption: msg.caption || "",

    };
  }

  return null;
}



function hasMedia(msg) {

  return !!(
    msg.document ||
    msg.photo ||
    msg.video
  );
}



function generateUID() {

  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  const arr = new Uint8Array(16);

  crypto.getRandomValues(arr);

  return Array.from(arr)
    .map(b => chars[b % chars.length])
    .join("");
}



function isAdmin(id, env) {

  return env.ADMINS
    .split(",")
    .includes(String(id));
}