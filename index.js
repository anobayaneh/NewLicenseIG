// ═══════════════════════════════════════════════════════════════════════════
// LICENSE SERVER — index.js
// Telegram Bot + REST API for Chrome Extension License System
// Supports multiple products (instagram, tiktok) with separate key prefixes
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const mongoose    = require('mongoose');
const TelegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');

const app   = express();
const PORT  = process.env.PORT || 3000;
const ADMIN = String(process.env.ADMIN_TELEGRAM_ID);

// ── Product config ────────────────────────────────────────────────────────
const PRODUCTS = {
  instagram: { prefix: 'IG',  emoji: '📸', label: 'Instagram Scraper' },
  tiktok:    { prefix: 'TIK', emoji: '🎵', label: 'TikTok Scraper'    },
};

function getProduct(name) {
  return PRODUCTS[name?.toLowerCase()] || null;
}

// ── Middleware ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── MongoDB Schema ────────────────────────────────────────────────────────
const licenseSchema = new mongoose.Schema({
  key:           { type: String, unique: true, required: true },
  product:       { type: String, required: true },   // 'instagram' | 'tiktok'
  duration:      { type: Number, required: true },   // in minutes
  durationLabel: { type: String },
  createdAt:     { type: Date, default: Date.now },
  activatedAt:   { type: Date, default: null },
  expiresAt:     { type: Date, default: null },
  status:        { type: String, enum: ['unused','active','expired','revoked'], default: 'unused' },
  usedBy:        { type: String, default: null },
});

const License = mongoose.model('License', licenseSchema);

// ── Telegram Bot ──────────────────────────────────────────────────────────
// Render's free tier stops the process after ~15 min with no inbound HTTP.
// With polling, a stopped process simply isn't asking Telegram for updates, so
// the bot goes silent — while /api/validate still "works" because an HTTP
// request wakes the service back up. That mismatch is the bug.
//
// Setting PUBLIC_URL switches to webhook mode: Telegram POSTs to us, and that
// POST is itself inbound HTTP, so it wakes the service and the bot answers.
// Without PUBLIC_URL we fall back to polling, which is right for local dev.
const TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const USE_WEBHOOK = Boolean(PUBLIC_URL);

if (!TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN is not set — the bot will not run.');
}

const bot = TOKEN
  ? new TelegramBot(TOKEN, USE_WEBHOOK ? {} : { polling: true })
  : null;

// Without these, every bot failure is invisible: no crash, no log, no reply.
if (bot) {
  bot.on('polling_error', e => console.error('❌ Telegram polling error:', e.code, e.message));
  bot.on('webhook_error', e => console.error('❌ Telegram webhook error:', e.code, e.message));
  bot.on('error',         e => console.error('❌ Telegram error:', e.message));
}

// Registers a command handler that can't die silently on a thrown error.
function onCommand(pattern, handler) {
  if (!bot) return;
  bot.onText(pattern, async (msg, match) => {
    try {
      await handler(msg, match);
    } catch (err) {
      console.error(`❌ Command failed (${msg.text}):`, err.message);
      try {
        await bot.sendMessage(msg.chat.id, `⚠️ Command failed: ${err.message}`);
      } catch (_) {}
    }
  });
}

function isAdmin(chatId) {
  return String(chatId) === ADMIN;
}

function parseDuration(input) {
  const s = input.trim().toLowerCase();
  const match = s.match(/^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|day|days?)$/);
  if (!match) return null;
  const num  = parseInt(match[1]);
  const unit = match[2][0];
  if (unit === 'm') return { minutes: num,         label: `${num} minute${num !== 1 ? 's' : ''}` };
  if (unit === 'h') return { minutes: num * 60,    label: `${num} hour${num !== 1 ? 's' : ''}`   };
  if (unit === 'd') return { minutes: num * 1440,  label: `${num} day${num !== 1 ? 's' : ''}`    };
  return null;
}

function formatTimeLeft(expiresAt) {
  const ms = new Date(expiresAt) - Date.now();
  if (ms <= 0) return 'Expired';
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function licenseStatusEmoji(status) {
  return { unused: '🟡', active: '🟢', expired: '🔴', revoked: '⛔' }[status] || '❓';
}

// ── Bot Commands ──────────────────────────────────────────────────────────

// /start or /help
onCommand(/^\/(start|help)$/, (msg) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Unauthorized.');
  bot.sendMessage(msg.chat.id,
`🔑 *License Key Manager*

*Generate Keys:*
/getToken instagram 1d — IG key, 1 day
/getToken tiktok 7d — TikTok key, 7 days
/getToken instagram 30m — IG key, 30 mins

*Durations:* m/min=minutes, h/hr=hours, d/day=days

*Manage Keys:*
/list — All keys (last 30)
/list instagram — IG keys only
/list tiktok — TikTok keys only
/listActive — Active keys
/listUnused — Unused keys
/check <key> — Check key status
/revoke <key> — Revoke a key`,
    { parse_mode: 'Markdown' }
  );
});

// /getToken <product> <duration>
onCommand(/^\/getToken\s+(\S+)\s+(\S+)$/i, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Unauthorized.');

  const product = getProduct(match[1]);
  if (!product) {
    return bot.sendMessage(msg.chat.id,
      `❌ Unknown product: \`${match[1]}\`\n\nValid options: \`instagram\`, \`tiktok\``,
      { parse_mode: 'Markdown' }
    );
  }

  const parsed = parseDuration(match[2]);
  if (!parsed) {
    return bot.sendMessage(msg.chat.id,
      '❌ Invalid duration.\n\nExamples: `30m`, `1h`, `1d`, `7d`',
      { parse_mode: 'Markdown' }
    );
  }

  const key = `${product.prefix}-` + uuidv4().replace(/-/g, '').toUpperCase().slice(0, 20);
  const license = new License({
    key,
    product: match[1].toLowerCase(),
    duration: parsed.minutes,
    durationLabel: parsed.label,
    status: 'unused',
  });

  await license.save();

  bot.sendMessage(msg.chat.id,
`✅ *License Key Generated*

${product.emoji} Product: *${product.label}*
\`${key}\`

⏱ Duration: *${parsed.label}*
📅 Created: ${new Date().toLocaleString()}
🟡 Status: Unused (activates on first use)

_Share this key with the user. Timer starts when first entered in the extension._`,
    { parse_mode: 'Markdown' }
  );
});

// Handle old /getToken <duration> format (no product)
onCommand(/^\/getToken\s+(\S+)$/i, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Unauthorized.');
  bot.sendMessage(msg.chat.id,
    `❌ Please specify a product.\n\nUsage: \`/getToken instagram 1d\` or \`/getToken tiktok 7d\``,
    { parse_mode: 'Markdown' }
  );
});

// /list [product]
onCommand(/^\/list(\s+\S+)?$/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Unauthorized.');

  const filterArg = match[1]?.trim().toLowerCase();
  const filter    = filterArg ? { product: filterArg } : {};
  const label     = filterArg ? (PRODUCTS[filterArg]?.label || filterArg) : 'All Products';

  const licenses = await License.find(filter).sort({ createdAt: -1 }).limit(30);
  if (!licenses.length) return bot.sendMessage(msg.chat.id, `📭 No keys found for ${label}.`);

  let text = `📋 *License Keys — ${label}* (last 30)\n\n`;
  for (const lic of licenses) {
    const emoji    = licenseStatusEmoji(lic.status);
    const prod     = PRODUCTS[lic.product];
    const timeLeft = lic.status === 'active' ? ` | ⏳ ${formatTimeLeft(lic.expiresAt)} left` : '';
    text += `${emoji} ${prod?.emoji || ''} \`${lic.key}\`\n`;
    text += `   ${lic.durationLabel} | ${lic.status.toUpperCase()}${timeLeft}\n\n`;
  }

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// /listActive
onCommand(/^\/listActive$/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Unauthorized.');

  await License.updateMany(
    { status: 'active', expiresAt: { $lt: new Date() } },
    { $set: { status: 'expired' } }
  );

  const licenses = await License.find({ status: 'active' }).sort({ expiresAt: 1 });
  if (!licenses.length) return bot.sendMessage(msg.chat.id, '📭 No active keys.');

  let text = `🟢 *Active Keys* (${licenses.length})\n\n`;
  for (const lic of licenses) {
    const prod = PRODUCTS[lic.product];
    text += `${prod?.emoji || ''} \`${lic.key}\`\n`;
    text += `   ⏳ ${formatTimeLeft(lic.expiresAt)} remaining\n`;
    text += `   Expires: ${new Date(lic.expiresAt).toLocaleString()}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// /listUnused
onCommand(/^\/listUnused$/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Unauthorized.');

  const licenses = await License.find({ status: 'unused' }).sort({ createdAt: -1 });
  if (!licenses.length) return bot.sendMessage(msg.chat.id, '📭 No unused keys.');

  let text = `🟡 *Unused Keys* (${licenses.length})\n\n`;
  for (const lic of licenses) {
    const prod = PRODUCTS[lic.product];
    text += `${prod?.emoji || ''} \`${lic.key}\`\n`;
    text += `   ${prod?.label} | ${lic.durationLabel}\n`;
    text += `   Created: ${new Date(lic.createdAt).toLocaleString()}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// /check <key>
onCommand(/^\/check\s+(.+)$/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Unauthorized.');

  const key = match[1].trim().toUpperCase();
  const lic = await License.findOne({ key });

  if (!lic) return bot.sendMessage(msg.chat.id, `❌ Key not found: \`${key}\``, { parse_mode: 'Markdown' });

  if (lic.status === 'active' && lic.expiresAt < new Date()) {
    lic.status = 'expired';
    await lic.save();
  }

  const prod  = PRODUCTS[lic.product];
  const emoji = licenseStatusEmoji(lic.status);
  let text = `${emoji} *Key Status*\n\n\`${lic.key}\`\n\n`;
  text += `${prod?.emoji || ''} Product: *${prod?.label || lic.product}*\n`;
  text += `📌 Status: *${lic.status.toUpperCase()}*\n`;
  text += `⏱ Duration: ${lic.durationLabel}\n`;
  text += `📅 Created: ${new Date(lic.createdAt).toLocaleString()}\n`;
  if (lic.activatedAt) text += `🚀 Activated: ${new Date(lic.activatedAt).toLocaleString()}\n`;
  if (lic.expiresAt)   text += `📆 Expires: ${new Date(lic.expiresAt).toLocaleString()}\n`;
  if (lic.status === 'active') text += `⏳ Time Left: *${formatTimeLeft(lic.expiresAt)}*\n`;

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// /revoke <key>
onCommand(/^\/revoke\s+(.+)$/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '❌ Unauthorized.');

  const key = match[1].trim().toUpperCase();
  const lic = await License.findOneAndUpdate(
    { key },
    { $set: { status: 'revoked' } },
    { new: true }
  );

  if (!lic) return bot.sendMessage(msg.chat.id, `❌ Key not found: \`${key}\``, { parse_mode: 'Markdown' });

  const prod = PRODUCTS[lic.product];
  bot.sendMessage(msg.chat.id,
    `⛔ *Key Revoked*\n\n${prod?.emoji || ''} \`${key}\`\n\nThis key will no longer work in the extension.`,
    { parse_mode: 'Markdown' }
  );
});

// ── REST API ──────────────────────────────────────────────────────────────

// POST /api/validate
app.post('/api/validate', async (req, res) => {
  const { key, product } = req.body;
  if (!key) return res.json({ valid: false, reason: 'No key provided' });

  const lic = await License.findOne({ key: key.toUpperCase().trim() });
  if (!lic) return res.json({ valid: false, reason: 'invalid' });

  // Reject if key is for a different product
  if (product && lic.product !== product.toLowerCase()) {
    return res.json({ valid: false, reason: 'wrong_product' });
  }

  if (lic.status === 'revoked') return res.json({ valid: false, reason: 'revoked' });
  if (lic.status === 'expired') return res.json({ valid: false, reason: 'expired' });

  if (lic.status === 'unused') {
    lic.activatedAt = new Date();
    lic.expiresAt   = new Date(Date.now() + lic.duration * 60 * 1000);
    lic.status      = 'active';
    await lic.save();
  }

  if (lic.status === 'active' && lic.expiresAt < new Date()) {
    lic.status = 'expired';
    await lic.save();
    return res.json({ valid: false, reason: 'expired' });
  }

  const msLeft = new Date(lic.expiresAt) - Date.now();
  return res.json({
    valid: true,
    key:   lic.key,
    product: lic.product,
    status: lic.status,
    expiresAt: lic.expiresAt,
    msLeft,
    durationLabel: lic.durationLabel,
  });
});

// POST /api/status
app.post('/api/status', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.json({ valid: false, reason: 'No key provided' });

  const lic = await License.findOne({ key: key.toUpperCase().trim() });
  if (!lic)                     return res.json({ valid: false, reason: 'invalid' });
  if (lic.status === 'revoked') return res.json({ valid: false, reason: 'revoked' });

  if (lic.status === 'active' && lic.expiresAt < new Date()) {
    lic.status = 'expired';
    await lic.save();
    return res.json({ valid: false, reason: 'expired' });
  }

  if (lic.status === 'expired') return res.json({ valid: false, reason: 'expired' });
  if (lic.status === 'unused')  return res.json({ valid: false, reason: 'not_activated' });

  const msLeft = new Date(lic.expiresAt) - Date.now();
  return res.json({ valid: true, status: 'active', expiresAt: lic.expiresAt, msLeft });
});

// Health check
app.get('/', (req, res) => res.json({ status: 'License Server Online ✅', products: Object.keys(PRODUCTS) }));

// ── Connect & Start ───────────────────────────────────────────────────────
// Telegram delivers updates here in webhook mode. The token is in the path so
// nobody but Telegram can guess it.
if (bot && USE_WEBHOOK) {
  app.post(`/bot${TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

async function startBot() {
  if (!bot) return;

  if (USE_WEBHOOK) {
    const url = `${PUBLIC_URL}/bot${TOKEN}`;
    try {
      await bot.setWebHook(url, { drop_pending_updates: false });
      const info = await bot.getWebHookInfo();
      console.log('✅ Telegram webhook set');
      console.log(`   pending updates: ${info.pending_update_count}`);
      if (info.last_error_message) {
        console.warn(`   ⚠️ last delivery error: ${info.last_error_message}`);
      }
    } catch (err) {
      console.error('❌ Could not set webhook:', err.message);
    }
  } else {
    // A webhook left over from an earlier deploy makes getUpdates fail with
    // 409 forever, so clear it before polling.
    try { await bot.deleteWebHook(); } catch (_) {}
    console.log('✅ Telegram bot polling started (local mode)');
  }

  try {
    const me = await bot.getMe();
    console.log(`✅ Bot connected: @${me.username}`);
  } catch (err) {
    console.error('❌ Bot token rejected by Telegram:', err.message);
  }
}

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB connected');
    app.listen(PORT, () => {
      console.log(`✅ License API running on port ${PORT}`);
      console.log(`   mode: ${USE_WEBHOOK ? 'webhook (' + PUBLIC_URL + ')' : 'polling'}`);
      if (!process.env.ADMIN_TELEGRAM_ID) {
        console.warn('   ⚠️ ADMIN_TELEGRAM_ID is not set — every command will answer "Unauthorized".');
      } else {
        console.log(`   admin id: ${ADMIN}`);
      }
      startBot();
    });
  })
  .catch(err => {
    console.error('❌ MongoDB error:', err.message);
    process.exit(1);
  });