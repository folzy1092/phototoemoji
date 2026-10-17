// Premium (custom) emoji in everything the bot sends, like lengubot's
// emojis.py: the same ids, applied automatically by a wrapper around `api`.
//   - plain text / captions: custom_emoji entities over known emoji
//   - HTML (log cards): <tg-emoji> tags, outside <code>/<pre>
//   - inline buttons: a leading known emoji becomes icon_custom_emoji_id
// Messages that already carry entities (the emoji-art previews) are left alone.
//
// Modules import `api` from here instead of from 'sdk'.

import { api as raw } from 'sdk';

// Symbol -> custom emoji id (from lengubot/emojis.py).
const IDS = {
  '🆕': '5352801244035444565', '🎁': '5472147707902567316', '📖': '5472410705929971383', '📚': '5373098009640836781',
  '📝': '5334882760735598374', '🌐': '5447410659077661506', '👋': '5472055112702629499', '👤': '6271782623127803146',
  '🎓': '5258334872878980409', '❌': '5352909795038880233', '⏰': '5348289410955754971', '🎉': '5436040291507247633',
  '📅': '5967412305338568701', '🔔': '5352874632141628924', '⚠️': '5447644880824181073', '✏️': '5956143844457189176',
  '✍️': '5470060791883374114', '📢': '5771695636411847302', '⛔️': '5260293700088511294', '🚫': '5350496629008917458',
  '🔑': '5352761996624292287', '🔒': '5258476306152038031', '⚙️': '6032742198179532882', '📭': '5352896944496728039',
  '🗓': '5258105663359294787', '📈': '5373001317042101552', '✅': '5350342542762209455', '☑️': '5454096630372379732',
  '🔙': '5352759161945867747', '◀️': '5877629862306385808', '🏆': '5409008750893734809', '💝': '5465263910414195580',
  '🧸': '5397915559037785261', '🌹': '5440911110838425969', '🎂': '5370999492914976897', '💐': '5190661263629243818',
  '🚀': '5445284980978621387', '💍': '5402100905883488232', '💎': '5427168083074628963', '🍾': '5370900768796711127',
  '👥': '5942877472163892475', '📊': '5431577498364158238', '⭐': '5435957248314579621', '😴': '5470082021906720301',
  '🌙': '5298841216253699814', '☀️': '5469947168523558652', '🏫': '5265002646397285605', '🌍': '5399898266265475100',
  '📺': '5373330964372004748', '🎯': '5310278924616356636', '⏳': '5352940967911517739', '💡': '5350603376126094305',
  '🔗': '5350790374707191566', '↗️': '5224694451338759997', '💬': '5260535596941582167', '🎧': '5197226421788904367',
  '🎞': '5775981206319402773', '📁': '5257969839313526622', '🎬': '5375464961822695044', '🗄': '5967456680940671207',
  '🎶': '5197220645057889072', '🎵': '5255944749348562622', '🔧': '5258023599419171861', '🟢': '5818711397860642669',
  '🔴': '5818665600624365278', '🟡': '5819028847483423716', '🔌': '5406622862201074988', '📦': '5256094480498436162',
  '📋': '5956561916573782596', '⏱️': '5981043230160981261', '🗑': '5258130763148172425', '🖼': '5255917867148257511',
  '📸': '5258205968025525531', '🔓': '5350482584465860714', '⚡️': '5456140674028019486', '🎮': '5258508428212445001',
  '🧪': '5913787972200698358', '👀': '5424885441100782420', '➖': '5197365071923131506', '➕': '5274008024585871702',
  '🤖': '5258093637450866522', '📨': '5967456680940671207', '🔐': '5258476306152038031', '📣': '5771695636411847302',
  '👁': '5253959125838090076', '🔥': '5420315771991497307', '🕐': '5197176724722319448', '🔍': '5350776428948381533',
  '🚨': '5258249368670073225', '📬': '5350421256627838238', '❗': '5274099962655816924', '🛠': '5359299744302639114',
  '🏠': '5988023995125993550', '📄': '5257963315258204021', '✉️': '5877301185639091664', '💻': '5253742260054409879',
  '🎨': '5244683263494069880', '🛡️': '5814690801665446789', '👑': '5931409969613116639', '✨': '5807868868886009920',
  '🧹': '5222108309795908493', '▶️': '6007942490076745785', '🔚': '5264919878082509254',
  // lengubot had this id on its gear by mistake; it is the reload arrows.
  '🔄': '5264727218734524899', '🔁': '5264727218734524899',
};

const stripVs = (s) => s.replace(/️/g, '');
const BY_BASE = Object.fromEntries(Object.entries(IDS).map(([k, v]) => [stripVs(k), v]));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Longest first; optional VS16; not part of a ZWJ sequence (🧑‍💻 stays as is).
const RE = new RegExp(
  `(?<!\\u200D)(?:${Object.keys(BY_BASE).sort((a, b) => b.length - a.length).map(esc).join('|')})\\uFE0F?(?!\\u200D)`,
  'gu',
);
const MAX_ENTITIES = 100;

/** custom_emoji entities for every known emoji in a plain text. */
export function premiumEntities(text) {
  const out = [];
  if (!text) return out;
  RE.lastIndex = 0;
  for (const m of text.matchAll(RE)) {
    out.push({ type: 'custom_emoji', offset: m.index, length: m[0].length, custom_emoji_id: BY_BASE[stripVs(m[0])] });
    if (out.length >= MAX_ENTITIES) break;
  }
  return out;
}

/** HTML: wrap known emoji in <tg-emoji>, except inside tags, <code>, <pre>, <tg-emoji>. */
export function premiumHtml(html) {
  if (!html) return html;
  let protectedDepth = 0;
  return html.split(/(<[^>]*>)/).map((part) => {
    if (part.startsWith('<') && part.endsWith('>')) {
      if (/^<(code|pre|tg-emoji)\b/i.test(part)) protectedDepth++;
      else if (/^<\/(code|pre|tg-emoji)>/i.test(part)) protectedDepth = Math.max(0, protectedDepth - 1);
      return part;
    }
    if (protectedDepth) return part;
    return part.replace(RE, (e) => `<tg-emoji emoji-id="${BY_BASE[stripVs(e)]}">${e}</tg-emoji>`);
  }).join('');
}

/** A leading known emoji on a button becomes its icon (the text keeps the rest). */
function iconize(keyboard) {
  return keyboard.map((row) => row.map((b) => {
    if (!b || b.icon_custom_emoji_id || typeof b.text !== 'string') return b;
    RE.lastIndex = 0;
    const m = RE.exec(b.text);
    if (!m || m.index !== 0) return b;
    const rest = b.text.slice(m[0].length).trim();
    if (!rest) return b; // a button that is only an emoji (➖ / ➕) keeps it as text
    return { ...b, text: rest, icon_custom_emoji_id: BY_BASE[stripVs(m[0])] };
  }));
}

function decorate(params) {
  if (!params || typeof params !== 'object') return params;
  const p = { ...params };
  const html = p.parse_mode === 'HTML';
  if (typeof p.text === 'string') {
    if (html) p.text = premiumHtml(p.text);
    else if (!p.parse_mode && !p.entities) {
      const e = premiumEntities(p.text);
      if (e.length) p.entities = e;
    }
  }
  if (typeof p.caption === 'string') {
    if (html) p.caption = premiumHtml(p.caption);
    else if (!p.parse_mode && !p.caption_entities) {
      const e = premiumEntities(p.caption);
      if (e.length) p.caption_entities = e;
    }
  }
  if (p.media && typeof p.media === 'object' && typeof p.media.caption === 'string' && !p.media.parse_mode && !p.media.caption_entities) {
    const e = premiumEntities(p.media.caption);
    if (e.length) p.media = { ...p.media, caption_entities: e };
  }
  if (p.reply_markup && Array.isArray(p.reply_markup.inline_keyboard)) {
    p.reply_markup = { ...p.reply_markup, inline_keyboard: iconize(p.reply_markup.inline_keyboard) };
  }
  return p;
}

const DECORATED = new Set([
  'sendMessage', 'editMessageText', 'sendPhoto', 'editMessageCaption', 'editMessageMedia',
  'editMessageReplyMarkup', 'sendSticker', 'sendDocument', 'copyMessage',
]);

/** Drop-in for the SDK's `api` with premium emoji applied. */
export const api = new Proxy(raw, {
  get(target, method) {
    const fn = target[method];
    if (typeof method !== 'string' || !DECORATED.has(method)) return fn;
    return (params) => target[method](decorate(params));
  },
});
