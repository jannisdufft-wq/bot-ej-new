require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Collection
} = require('discord.js');
const Database = require('better-sqlite3');

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel, Partials.GuildMember]
});

// Config from env
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || null;
const MANAGE_ROLE_ID = process.env.MANAGE_ROLE_ID || null; 
const SHIFT_ROLE_ID = process.env.SHIFT_ROLE_ID || null;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null;
const LOA_ROLE_ID = process.env.LOA_ROLE_ID || '1284507089191964763';

if (!TOKEN || !CLIENT_ID) {
  console.error('ERROR: TOKEN and CLIENT_ID must be set in .env');
  process.exit(1);
}

// DB init - synchronous with better-sqlite3
let db;
try {
  db = new Database('./data.sqlite');
  db.pragma('journal_mode = WAL');
  
  // existing tables
  db.exec(`CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    start_ts INTEGER,
    pause_ts INTEGER,
    resume_ts INTEGER,
    end_ts INTEGER,
    total_seconds INTEGER DEFAULT 0,
    type TEXT,
    status TEXT
  )`);
  
  db.exec(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    guild_id TEXT,
    actor_id TEXT,
    action TEXT,
    data TEXT,
    ts INTEGER
  )`);
  
  db.exec(`CREATE TABLE IF NOT EXISTS loa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    guild_id TEXT,
    start_ts INTEGER,
    end_ts INTEGER,
    reason TEXT,
    status TEXT,
    actor_id TEXT
  )`);
  
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  
  db.exec(`CREATE TABLE IF NOT EXISTS shift_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    role_id TEXT
  )`);
  
  // prepopulate shift types if empty
  const types = db.prepare('SELECT * FROM shift_types').all();
  if (!types.length) {
    const defaultTypes = ['Customer Worker','Delivery Worker','Security Worker','Supervisor'];
    const stmt = db.prepare('INSERT OR IGNORE INTO shift_types (name, role_id) VALUES (?, ?)');
    for (const t of defaultTypes) {
      stmt.run(t, null);
    }
  }
  
  db.prepare(`
CREATE TABLE IF NOT EXISTS admin_settings (
    guild_id TEXT PRIMARY KEY,
    shift_log_channel TEXT
)
`).run();

  console.log('✓ Database initialized successfully');
} catch (err) {
  console.error('✗ DB init error:', err.message);
  process.exit(1);
}

// Helpers
const now = () => Math.floor(Date.now() / 1000);
const LOA_MAX_SECONDS = 60 * 60 * 24 * 30 * 6; // 6 months
const secsToHMS = s => {
  s = Number(s) || 0;
  const h = Math.floor(s / 3600);
  s = s % 3600;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${h} hours, ${m} minutes, ${sec} seconds`;
};
function smallHMS(s) {
  s = Number(s) || 0;
  const h = Math.floor(s / 3600);
  s = s % 3600;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}
function logAction(userId, guildId, actorId, action, data = '') {
  try {
    db.prepare('INSERT INTO logs (user_id,guild_id,actor_id,action,data,ts) VALUES (?,?,?,?,?,?)').run(userId, guildId, actorId, action, data, now());
  } catch (e) {
    console.warn('logAction failed', e.message);
  }
}
function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? JSON.parse(r.value) : null;
}
function setSetting(key, value) {
  const v = JSON.stringify(value);
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, v);
}
async function assignShiftRole(member) {
  if (!SHIFT_ROLE_ID || !member) return;
  try {
    const role = member.guild.roles.cache.get(SHIFT_ROLE_ID);
    if (role) await member.roles.add(role);
  } catch (e) { console.warn('assignShiftRole failed:', e.message); }
}
async function removeShiftRole(member) {
  if (!SHIFT_ROLE_ID || !member) return;
  try {
    const role = member.guild.roles.cache.get(SHIFT_ROLE_ID);
    if (role) await member.roles.remove(role);
  } catch (e) { console.warn('removeShiftRole failed:', e.message); }
}
function isAdmin(member) {
  if (!member) return false;
  try {
    if (MANAGE_ROLE_ID) return member.roles.cache.has(MANAGE_ROLE_ID) || member.permissions.has(PermissionFlagsBits.ManageGuild) || (ADMIN_ROLE_ID && member.roles.cache.has(ADMIN_ROLE_ID));
    if (ADMIN_ROLE_ID) return member.roles.cache.has(ADMIN_ROLE_ID) || member.permissions.has(PermissionFlagsBits.ManageGuild);
    return member.permissions.has(PermissionFlagsBits.ManageGuild);
  } catch { return false; }
}
// embed defaults and icons
const EMBED_COLOR = 0x0b1020;
const ICONS = {
  user: '👤',
  time: '⏱',
  type: '🏷',
  start: '▶',
  end: '⏹',
  pause: '⏸',
  loa: '📝'
};
function footerTextForLocale(guild, date = new Date()) {
  // We want: ELBE Juwelier | Shifts • HH:mm in user's format
  // default to en
  const locale = 'en';
  const time = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return `ELBE Juwelier | Shifts • ${time}`;
}

// Build shift display embed (new style)
function buildDetailedShiftEmbed(userObj, shiftRow, options = {}) {
  // options: actor, actionLabel
  const status = shiftRow.status || 'unknown';
  let color = EMBED_COLOR;
  if (status === 'active') color = 0x2ecc71;
  if (status === 'paused') color = 0x3498db;
  if (status === 'ended') color = 0xe74c3c;

  const fields = [
    { name: `${ICONS.user} User`, value: `${userObj.tag}`, inline: false },
    { name: `${ICONS.type} Type`, value: `${shiftRow.type || '—'}`, inline: true },
    { name: `${ICONS.time} Total`, value: shiftRow.total_seconds ? secsToHMS(shiftRow.total_seconds) : '0 hours, 0 minutes, 0 seconds', inline: true }
  ];
  fields.push({ name: `${ICONS.start} Start`, value: shiftRow.start_ts ? `<t:${shiftRow.start_ts}:f>` : '—', inline: true });
  fields.push({ name: `${ICONS.end} End`, value: shiftRow.end_ts ? `<t:${shiftRow.end_ts}:f>` : '—', inline: true });

  const embed = new EmbedBuilder()
    .setTitle(`${ICONS.time} Shift`)
    .setColor(color)
    .setAuthor({ name: userObj.tag, iconURL: userObj.displayAvatarURL() })
    .addFields(fields)
    .setTimestamp()
    .setFooter({ text: footerTextForLocale() });

  if (options.actor && options.actionLabel) {
    embed.addFields({ name: '\u200B', value: `**${options.actionLabel}**: ${options.actor.username} · Shift ID: #${shiftRow.id}` });
  }
  return embed;
}

// Build logs embed (trident-like)
function buildLogEmbed(actionTitle, actionType, actorUser, targetUser, totalSeconds, shiftId, guild) {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setAuthor({ name: actorUser.username, iconURL: typeof actorUser.displayAvatarURL === 'function' ? actorUser.displayAvatarURL() : actorUser.displayAvatarURL })
    .setTitle(`${actionTitle} • ${actionType}`)
    .addFields(
      { name: 'Staff Member', value: `<@${targetUser.id}>`, inline: false },
      { name: 'Total Time', value: secsToHMS(totalSeconds || 0), inline: false }
    )
    .setFooter({ text: footerTextForLocale(guild) })
    .setTimestamp();
  embed.addFields({ name: '\u200B', value: `# Shift ID • ${shiftId} • Ended by <@${actorUser.id}>` });
  return embed;
}

// send to configured shift log channel (from settings) or fallback LOG_CHANNEL_ID
async function sendLogChannelEmbed(guild, embed) {
  try {
    const cfg = getSetting(`guild_${guild.id}_settings`) || {};
    const chId = cfg.shift_log_channel || LOG_CHANNEL_ID;
    if (!chId) return;
    const ch = await guild.channels.fetch(chId).catch(() => null);
    if (ch && ch.send) await ch.send({ embeds: [embed] });
  } catch (e) {
    console.warn('sendLogChannelEmbed error:', e.message);
  }
}

// Buttons builder updated (admin extra buttons preserved)
function buildShiftButtons(shiftId, status, forAdmin = false) {
  const row = new ActionRowBuilder();
  row.addComponents(
    new ButtonBuilder().setCustomId(`shift_start_${shiftId || 'new'}`).setLabel('Start').setStyle(ButtonStyle.Success).setDisabled(status === 'active'),
    new ButtonBuilder().setCustomId(`shift_pause_${shiftId || 'none'}`).setLabel('Pause').setStyle(ButtonStyle.Secondary).setDisabled(!(status === 'active')),
    new ButtonBuilder().setCustomId(`shift_resume_${shiftId || 'none'}`).setLabel('Resume').setStyle(ButtonStyle.Primary).setDisabled(!(status === 'paused')),
    new ButtonBuilder().setCustomId(`shift_end_${shiftId || 'none'}`).setLabel('End').setStyle(ButtonStyle.Danger).setDisabled(!(status === 'active' || status === 'paused'))
  );
  if (forAdmin) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`shift_forceend_${shiftId || 'none'}`).setLabel('Force End').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`shift_edit_${shiftId || 'none'}`).setLabel('Edit').setStyle(ButtonStyle.Secondary)
    );
  }
  return row;
}

// Build LoA embed for lists and admin
function buildLoAListEmbed(guild, rows) {
  const embed = new EmbedBuilder()
    .setTitle('Latest Leaves')
    .setColor(EMBED_COLOR)
    .setFooter({ text: footerTextForLocale(guild) })
    .setTimestamp();
  const lines = rows.slice(0,7).map((r, i) => `#${i+1} | ${new Date(r.start_ts*1000).toLocaleDateString('en-GB')} - ${new Date(r.end_ts*1000).toLocaleDateString('en-GB')}`);
  embed.setDescription(lines.join('\n'));
  return embed;
}

// -------------------- COMMANDS REGISTER --------------------
const commands = [
  new SlashCommandBuilder()
    .setName('shift')
    .setDescription('Shift commands')
    .addSubcommandGroup(group =>
      group.setName('type')
        .setDescription('Manage shift types')
        .addSubcommand(sub =>
          sub.setName('list')
            .setDescription('List all shift types')
        )
    )
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('Start a shift')
        .addStringOption(o => o.setName('type').setDescription('Shift type').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand(sub => sub.setName('pause').setDescription('Pause your active shift'))
    .addSubcommand(sub => sub.setName('resume').setDescription('Resume a paused shift'))
    .addSubcommand(sub => sub.setName('end').setDescription('End your active shift'))
    .addSubcommand(sub =>
      sub.setName('logs')
        .setDescription('View your shift logs')
        .addIntegerOption(o => o.setName('limit').setDescription('Max lines'))
    )
    .addSubcommand(sub => sub.setName('leaderboard').setDescription('View shift leaderboard').addStringOption(o => o.setName('type').setDescription('Filter by shift type').setAutocomplete(true)))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('shift-manage')
    .setDescription('Admin shift manager')
    .addSubcommand(sub => sub.setName('bulk_end').setDescription('End multiple shifts').addUserOption(o => o.setName('user').setDescription('Filter by user')).addStringOption(o => o.setName('before').setDescription('Before date YYYY-MM-DD')))
    .addSubcommand(sub => sub.setName('bulk_delete').setDescription('Delete multiple shifts').addUserOption(o => o.setName('user').setDescription('Filter by user')).addStringOption(o => o.setName('before').setDescription('Before date YYYY-MM-DD')).addStringOption(o => o.setName('ids').setDescription('Comma-separated IDs')))
    .addSubcommand(sub => sub.setName('menu').setDescription('Open admin shift menu for a specific shift').addIntegerOption(o => o.setName('id').setDescription('Shift ID')))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('loa')
    .setDescription('Leave of Absence commands')
    .addSubcommand(sub =>
      sub.setName('request')
        .setDescription('Request LoA')
        .addStringOption(o => o.setName('duration').setDescription('e.g. 3d, 2w').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason for LoA'))
    )
    .addSubcommand(sub => sub.setName('list').setDescription('List your LoAs'))
    .addSubcommand(sub => sub.setName('status').setDescription('Check your LoA status'))
    .addSubcommand(sub => sub.setName('manage').setDescription('Open LoA management menu (start/end/extend)'))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('loa-manage')
    .setDescription('Admin LoA management')
    .addSubcommand(sub => sub.setName('approve').setDescription('Approve LoA').addIntegerOption(o => o.setName('id').setDescription('LoA ID').setRequired(true)).addStringOption(o => o.setName('note').setDescription('Optional note')))
    .addSubcommand(sub => sub.setName('deny').setDescription('Deny LoA').addIntegerOption(o => o.setName('id').setDescription('LoA ID').setRequired(true)).addStringOption(o => o.setName('note').setDescription('Optional note')))
    .addSubcommand(sub => sub.setName('list').setDescription('List pending LoAs').addIntegerOption(o => o.setName('limit').setDescription('Maximum number of entries')))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('bot-manage')
    .setDescription('Manage bot settings (admin)')
    .addSubcommand(s => s.setName('view').setDescription('View current bot settings'))
    .addSubcommand(s => s.setName('set-shift-log').setDescription('Set shift log channel').addStringOption(o => o.setName('channel').setDescription('channel id').setRequired(true)))
    .addSubcommand(s => s.setName('set-admin-shift-logs').setDescription('Set admin shift change log channel').addStringOption(o => o.setName('channel').setDescription('channel id').setRequired(true)))
    .addSubcommand(s => s.setName('set-report-channel').setDescription('Set report channel').addStringOption(o => o.setName('channel').setDescription('channel id').setRequired(true)))
    .addSubcommand(s => s.setName('set-role').setDescription('Set role for shift type').addStringOption(o => o.setName('type').setDescription('Shift type').setRequired(true).setAutocomplete(true)).addStringOption(o => o.setName('role-id').setDescription('Role ID').setRequired(true)))
    .addSubcommand(s => s.setName('toggle-one-shift').setDescription('Toggle single-active-shift (on/off)').addStringOption(o => o.setName('value').setDescription('on/off').setRequired(true)))
    .addSubcommand(s => s.setName('set-requirement').setDescription('Set requirement time in minutes').addIntegerOption(o => o.setName('minutes').setDescription('minutes').setRequired(true)))
    .addSubcommand(s => s.setName('set-report-schedule').setDescription('Set automatic report schedule').addStringOption(o => o.setName('time').setDescription('HH:MM in 24h').setRequired(true)).addIntegerOption(o => o.setName('interval-days').setDescription('7/14/21').setRequired(true)))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('report')
    .setDescription('Manage reports')
    .addSubcommand(s => s.setName('setup').setDescription('Setup automatic report').addStringOption(o => o.setName('time').setDescription('HH:MM in 24h').setRequired(true)).addIntegerOption(o => o.setName('interval-days').setDescription('Interval in days').setRequired(true)))
    .addSubcommand(s => s.setName('run').setDescription('Run a manual report').addIntegerOption(o => o.setName('days').setDescription('7/14/21 days').setRequired(true)).addStringOption(o => o.setName('type').setDescription('Shift type (optional)').setAutocomplete(true)))
    .toJSON()
];

module.exports = commands;

// ---------- Scheduler for LoA expiry and report triggering ----------
const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
setInterval(async () => {
  try {
    // 1) LoA expiry check
    const nowTs = now();
    const rows = db.prepare('SELECT * FROM loa WHERE status = ? AND end_ts <= ?').all('approved', nowTs);
    for (const r of rows) {
      // mark ended
      db.prepare('UPDATE loa SET status = ? WHERE id = ?').run('ended', r.id);
      // remove role
      try {
        const guild = client.guilds.cache.get(r.guild_id) || (await client.guilds.fetch(r.guild_id).catch(()=>null));
        if (guild) {
          const member = await guild.members.fetch(r.user_id).catch(()=>null);
          if (member && LOA_ROLE_ID) {
            const role = guild.roles.cache.get(LOA_ROLE_ID);
            if (role) await member.roles.remove(role).catch(()=>null);
          }
          // DM the user
          const u = await client.users.fetch(r.user_id).catch(()=>null);
          if (u) {
            const embed = new EmbedBuilder()
              .setAuthor({ name: guild.name, iconURL: guild.iconURL() })
              .setTitle('Leave of Absence Ended')
              .setDescription(`Your Leave of Absence (ID: ${r.id}) has ended.`)
              .setFooter({ text: footerTextForLocale(guild) })
              .setTimestamp();
            await u.send({ embeds: [embed] }).catch(()=>null);
          }
        }
      } catch(e){ console.warn('LoA expiry handler error', e.message); }
      await logAction(r.user_id, r.guild_id, 'system', 'loa_expired', JSON.stringify({ id: r.id }));
    }

    // 2) Reports scheduling - find guild settings that have report schedule set
    const settingKeys = db.prepare("SELECT key,value FROM settings WHERE key LIKE 'guild_%_settings'").all();
    for (const s of settingKeys) {
      const key = s.key; // guild_<id>_settings
      const cfg = JSON.parse(s.value);
      if (cfg && cfg.report_schedule && cfg.report_schedule.time && cfg.report_schedule.interval_days && cfg.report_channel) {
        try {
          // determine if now matches schedule (rounded to minute)
          const tzNow = new Date();
          const [hh,mm] = cfg.report_schedule.time.split(':').map(x=>parseInt(x,10));
          if (typeof hh !== 'number' || typeof mm !== 'number') continue;
          // check if current time (UTC) equals schedule time in guild timezone? We'll use server time for now
          if (tzNow.getHours() === hh && tzNow.getMinutes() === mm) {
            const m = s.key.match(/^guild_(.+)_settings$/);
            const guildIdFromKey = m ? m[1] : null;
            if (!guildIdFromKey) continue;
            const lastRunKey = `guild_${guildIdFromKey}_last_report`;
            const last = getSetting(lastRunKey);
            const todayKey = new Date().toISOString().slice(0, 16);
            if (last === todayKey) continue;
            await generateAndSendReport(guildIdFromKey, cfg.report_channel, cfg.report_schedule.interval_days, null, cfg.included_roles || []);
            setSetting(lastRunKey, todayKey);
          }
        } catch (e) { console.warn('report schedule error', e.message); }
      }
    }

  } catch (e) {
    console.warn('scheduler error', e.message);
  }
}, SCHEDULER_INTERVAL_MS);

// ---------- Report generation ----------
async function generateAndSendReport(guildId, channelId, days = 7, typeFilter = null, includedRoles = []) {
  try {
    const guild = await client.guilds.fetch(guildId).catch(()=>null);
    if (!guild) return;
    const endTs = now();
    const startTs = endTs - (days * 86400);
    // gather shifts during period
    let q = 'SELECT user_id, SUM(total_seconds) as total FROM shifts WHERE guild_id = ? AND (status = ? OR status = ?) AND start_ts >= ? AND start_ts <= ?';
    const params = [guildId, 'active', 'ended', startTs, endTs];
    if (typeFilter) { q += ' AND type = ?'; params.push(typeFilter); }
    q += ' GROUP BY user_id ORDER BY total DESC';
    const rows = db.prepare(q).all(...params);
    // Collect ALL users from the included roles (even with 0 minutes)
let membersToCheck = [];

if (includedRoles.length) {
  // All members that have ANY of the included roles
  for (const roleId of includedRoles) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;

    for (const mem of role.members.values()) {
      if (!membersToCheck.some(m => m.id === mem.id)) {
        membersToCheck.push(mem);
      }
    }
  }
} else {
  // No roles selected → include ALL guild members
  membersToCheck = [...(await guild.members.fetch()).values()];
}

// Map DB results by user
const userTimes = new Map();
for (const row of rows) {
  userTimes.set(row.user_id, row.total || 0);
}

// Build eligible list
const eligible = membersToCheck.map(mem => ({
  user: mem.user,
  total: userTimes.get(mem.id) || 0  
}));

    const cfg = getSetting(`guild_${guildId}_settings`) || {};
    const requirementMin = (cfg.requirement_minutes || 60);
    const requirementSeconds = requirementMin * 60;
    const met = [], notmet = [];
    for (const e of eligible) {
      if ((e.total || 0) >= requirementSeconds) met.push(e);
      else notmet.push(e);
    }
    // on leave - find approved LoAs active
    const loaRows = db.prepare('SELECT * FROM loa WHERE guild_id = ? AND status = ?').all(guildId, 'approved');
    const onLeave = [];
    for (const l of loaRows) {
      const usr = await client.users.fetch(l.user_id).catch(()=>null);
      if (usr) onLeave.push({ user: usr, end_ts: l.end_ts });
    }
    // build embeds
    const reportChannel = await guild.channels.fetch(channelId).catch(()=>null);
    if (!reportChannel || !reportChannel.send) return;
    const header = new EmbedBuilder().setAuthor({ name: guild.name, iconURL: guild.iconURL() }).setTitle(`${guild.name} Activity Report • ${typeFilter || 'All Shift Types'}`).setColor(0x2ecc71).setFooter({ text: footerTextForLocale(guild) }).setTimestamp();
    await reportChannel.send({ embeds: [header] });
    // Requirement Met embed (green)
    if (met.length) {
      const lines = met.map(m => `${m.user} • ${secsToHMS(m.total || 0)}`);
      const chunkLines = chunkArray(lines, 1000);
      for (const c of chunkLines) {
        const e = new EmbedBuilder().setTitle('Requirement Met').setColor(0x2ecc71).setDescription(c.join('\n')).setFooter({ text: footerTextForLocale(guild) }).setTimestamp();
        await reportChannel.send({ embeds: [e] });
      }
    } else {
      const e = new EmbedBuilder().setTitle('Requirement Met').setColor(0x2ecc71).setDescription('No members met the requirement.').setFooter({ text: footerTextForLocale(guild) }).setTimestamp();
      await reportChannel.send({ embeds: [e] });
    }
    // Requirements Not Met (red) - max 16 per embed (we'll put 16 lines)
    if (notmet.length) {
      const lines = notmet.map(m => `${m.user} • ${secsToHMS(m.total || 0)}`);
      const pages = chunkArray(lines, 16);
      for (const [i, p] of pages.entries()) {
        const e = new EmbedBuilder().setTitle(i===0 ? 'Requirements Not Met' : '').setColor(0xe74c3c).setDescription(p.join('\n')).setFooter({ text: footerTextForLocale(guild) }).setTimestamp();
        await reportChannel.send({ embeds: [e] });
      }
    }
    // On Leave (yellow)
    if (onLeave.length) {
      const lines = onLeave.map(l => `${l.user} • ends <t:${l.end_ts}:R>`);
      const e = new EmbedBuilder().setTitle('On Leave').setColor(0xf1c40f).setDescription(lines.join('\n')).setFooter({ text: footerTextForLocale(guild) }).setTimestamp();
      await reportChannel.send({ embeds: [e] });
    }
    // Included Roles
    if (includedRoles.length) {
      const mentions = includedRoles.map(id => `<@&${id}>`).join(', ');
      const e = new EmbedBuilder().setTitle('Included Roles').setColor(EMBED_COLOR).setDescription(mentions).setFooter({ text: footerTextForLocale(guild) }).setTimestamp();
      await reportChannel.send({ embeds: [e] });
    }
  } catch (e) {
    console.warn('generateAndSendReport error', e.message);
  }
}

function chunkArray(arr, size) {
  const result = [];
  for (let i=0;i<arr.length;i+=size) result.push(arr.slice(i,i+size));
  return result;
}

// ---------- Interaction handler ----------
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isAutocomplete()) {
      const focused = interaction.options.getFocused(true);

      const valid =
        (interaction.commandName === 'shift' &&
         ['start', 'leaderboard'].includes(interaction.options.getSubcommand()) &&
         (focused.name === 'type')) ||

         (interaction.commandName === 'report' &&
         (focused.name === 'type')) ||

        (interaction.commandName === 'bot-manage' &&
         ['set-role'].includes(interaction.options.getSubcommand()) &&
         (focused.name === 'type'));

      if (!valid) return;

      const types = db.prepare('SELECT name FROM shift_types').all();
      const value = focused.value.toLowerCase();

      const list = types 
        .map(t => t.name)
        .filter(n => n.toLowerCase().includes(value))
        .slice(0, 25);

        await interaction.respond(list.map(n => ({ name: n, value: n })));
    }

    // ------------------ BUTTONS ------------------
    if (interaction.isButton()) {
      await interaction.deferReply({ ephemeral: true }).catch(()=>{});
      const parts = interaction.customId.split('_');
      if (parts[0] === 'leaderboard') {
        const page = parseInt(parts[2]) || 1;
        const type = parts[3] && parts.length>3 ? decodeURIComponent(parts.slice(3).join('_')) : null;
        await sendLeaderboard(interaction, type, page);
        return;
      }
      
      if (parts[0] === 'shift') {
        // e.g. shift_pause_12
        if (parts.length < 3) return interaction.reply({ content: 'Unknown button action.', ephemeral: true });
        const [, action, idStr] = parts;
        const id = parseInt(idStr);
        if (isNaN(id)) return interaction.reply({ content: 'Invalid action.', ephemeral: true });
        const guild = interaction.guild;
        const member = interaction.member;
        const user = interaction.user;
        const row = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
        if (!row) return interaction.reply({ content: 'Shift not found.', ephemeral: true });

        // PAUSE
        if (action === 'pause') {
          if (row.user_id !== user.id && !isAdmin(member)) return interaction.reply({ content: 'This is not your Shift. You may not pause Shifts of others.', ephemeral: true });
          const pauseTs = now();
          const elapsed = Math.max(0, pauseTs - row.start_ts);
          const total = (row.total_seconds || 0) + elapsed;
          db.prepare('UPDATE shifts SET pause_ts=?, status=?, total_seconds=? WHERE id=?').run(pauseTs, 'paused', total, id);
          await logAction(row.user_id, guild.id, user.id, 'shift_pause_button', JSON.stringify({ id }));
          const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
          const embed = buildDetailedShiftEmbed(await client.users.fetch(shift.user_id), shift, { actor: user, actionLabel: 'Paused by' });
          await interaction.editReply({ embeds: [embed], components: [buildShiftButtons(shift.id, 'paused', isAdmin(member))] });
          const actor = user;
          const target = await client.users.fetch(shift.user_id);
          const logEmb = buildLogEmbed('Shift Paused', shift.type || 'Unknown', actor, target, shift.total_seconds, shift.id, guild);
          await sendLogChannelEmbed(guild, logEmb);
          return;
        }

        // RESUME
        if (action === 'resume') {
          if (row.user_id !== user.id && !isAdmin(member)) return interaction.reply({ content: 'You may not resume this shift.', ephemeral: true });
          const resumeTs = now();
          db.prepare('UPDATE shifts SET resume_ts=?, start_ts=?, status=? WHERE id=?').run(resumeTs, resumeTs, 'active', id);
          await logAction(row.user_id, guild.id, user.id, 'shift_resume_button', JSON.stringify({ id }));
          const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
          const embed = buildDetailedShiftEmbed(await client.users.fetch(shift.user_id), shift, { actor: user, actionLabel: 'Resumed by' });
          await interaction.update({ embeds: [embed], components: [buildShiftButtons(shift.id, 'active', isAdmin(member))] });
          const actor = user; const target = await client.users.fetch(shift.user_id);
          const logEmb = buildLogEmbed('Shift Resumed', shift.type || 'Unknown', actor, target, shift.total_seconds, shift.id, guild);
          await sendLogChannelEmbed(guild, logEmb);
          return;
        }

        // END or FORCEEND
        if (action === 'end' || action === 'forceend') {
          if (action === 'end' && row.user_id !== user.id && !isAdmin(member)) return interaction.reply({ content: 'You may not end this shift.', ephemeral: true });
          const endTs = now();
          let total = row.total_seconds || 0;
          if (row.status === 'active') total += Math.max(0, endTs - row.start_ts);
          db.prepare('UPDATE shifts SET end_ts=?, status=?, total_seconds=? WHERE id=?').run(endTs, 'ended', total, id);
          try { const mem = await guild.members.fetch(row.user_id).catch(() => null); if (mem) await removeShiftRole(mem); } catch {}
          await logAction(row.user_id, guild.id, user.id, action === 'forceend' ? 'shift_forceend_button' : 'shift_end_button', JSON.stringify({ id, total }));
          const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
          const embed = buildDetailedShiftEmbed(await client.users.fetch(shift.user_id), shift, { actor: user, actionLabel: action === 'forceend' ? 'Force ended by' : 'Ended by' });
          await interaction.update({ embeds: [embed], components: [] });
          const actor = user; const target = await client.users.fetch(shift.user_id);
          const logEmb = buildLogEmbed('Shift Ended', shift.type || 'Unknown', actor, target, shift.total_seconds, shift.id, guild);
          await sendLogChannelEmbed(guild, logEmb);
          return;
        }

        // START (button)
        if (action === 'start') {
          const memberObj = interaction.member;
          const userObj = interaction.user;
          const type = 'normal';
          const cfg = getSetting(`guild_${guild.id}_settings`) || {};
          if (cfg.one_active_shift) {
            const existing = db.prepare('SELECT * FROM shifts WHERE user_id = ? AND guild_id = ? AND (status = ? OR status = ?)').get(userObj.id, guild.id, 'active', 'paused');
            if (existing) return interaction.reply({ content: 'You already have an active or paused shift. Single active shift is enforced.', ephemeral: true });
          }
          const startTs = now();
          const res = db.prepare('INSERT INTO shifts (user_id,guild_id,start_ts,type,status) VALUES (?,?,?,?,?)').run(userObj.id, guild.id, startTs, type, 'active');
          const shiftId = res.lastInsertRowid;
          await assignShiftRole(memberObj);
          await logAction(userObj.id, guild.id, userObj.id, 'shift_start_button', JSON.stringify({ id: shiftId }));
          const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
          const embed = buildDetailedShiftEmbed(await client.users.fetch(shift.user_id), shift, { actor: userObj, actionLabel: 'Started by' });
          await interaction.update({ embeds: [embed], components: [buildShiftButtons(shift.id, 'active')] });
          const actor = userObj; const target = await client.users.fetch(shift.user_id);
          const logEmb = buildLogEmbed('Shift Started', shift.type || 'Unknown', actor, target, shift.total_seconds, shift.id, guild);
          await sendLogChannelEmbed(guild, logEmb);
          return;
        }

        // EDIT
        if (action === 'edit') {
          if (!isAdmin(interaction.member)) return interaction.reply({ content: 'Only admins may edit shifts.', ephemeral: true });
          return interaction.reply({ content: `To edit shift ${id}, use /shift-manage bulk-edit.`, ephemeral: true });
        }

        return interaction.reply({ content: 'Unknown action.', ephemeral: true });
      }

        if (interaction.isStringSelectMenu() && interaction.customId.startsWith("shift-action-")) {

    await interaction.deferUpdate().catch(()=>{});

    const shiftId = interaction.customId.split("shift-action-")[1];
    const action = interaction.values[0];

    const shift = db.prepare("SELECT * FROM shifts WHERE id=?").get(shiftId);
    if (!shift) return;

    const userObj = await client.users.fetch(shift.user_id);

    // ========= VIEW SHIFT LIST =========
    if (action === "view") {
        const shifts = db.prepare(`
            SELECT * FROM shifts 
            WHERE user_id=? 
            ORDER BY start_ts ASC
        `).all(userObj.id);

        const embed = new EmbedBuilder()
            .setTitle(`📋 Shift list for ${userObj.tag}`)
            .setColor(0x3498db)
            .setDescription(
                shifts.map(s => `#${s.id} | ${s.type || "Default"} | ${s.status} | ${smallHMS((s.end_ts || Date.now()) - s.start_ts)}`).join("\n")
            );

        return interaction.editReply({ embeds:[embed], components: [] });
    }

    // ========= MODIFY SHIFT =========
    if (action === "modify") {

        const embed = new EmbedBuilder()
            .setTitle(`✏ Modify Shift #${shift.id}`)
            .setColor(0xf1c40f)
            .setDescription("Select what you want to do.");

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`admin-addtime-${shift.id}`).setLabel("Add Time").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`admin-removetime-${shift.id}`).setLabel("Remove Time").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`admin-settime-${shift.id}`).setLabel("Set Time").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`admin-resettime-${shift.id}`).setLabel("Reset Time").setStyle(ButtonStyle.Secondary)
        );

        return interaction.editReply({ embeds:[embed], components:[buttons] });
    }

    // ========= DELETE SHIFT =========
    if (action === "delete") {

        const userShifts = db.prepare(`
            SELECT * FROM shifts 
            WHERE user_id=? 
            ORDER BY start_ts DESC
        `).all(userObj.id);

        const menu = new StringSelectMenuBuilder()
            .setCustomId(`delete-select-${userObj.id}`)
            .setPlaceholder("Select a shift to delete")
            .addOptions(userShifts.map(s => ({
                label: `Shift #${s.id}`,
                description: `${s.type || "Default"} | ${s.status}`,
                value: String(s.id)
            })));

        const row1 = new ActionRowBuilder().addComponents(menu);

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`delete-latest-${userObj.id}`)
                .setLabel("Most recent")
                .setStyle(ButtonStyle.Danger)
        );

        const embed = new EmbedBuilder()
            .setTitle("🗑 Delete shift")
            .setColor(0xe74c3c);

        return interaction.editReply({ embeds:[embed], components:[row1, row2] });
    }

    // ========= CLEAR SHIFTS =========
    if (action === "clear") {

        db.prepare(`
            DELETE FROM shifts 
            WHERE user_id=? AND type=?
        `).run(userObj.id, shift.type);

        const embed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ Cleared")
            .setDescription(`All shifts for **${userObj.tag}** have been removed.`);

        return interaction.editReply({ embeds:[embed], components: [] });
    }
}

if (interaction.isButton() && interaction.customId.startsWith("shift-") || 
    interaction.customId.startsWith("admin-") || 
    interaction.customId.startsWith("delete-")) {

    await interaction.deferReply({ ephemeral:true }).catch(()=>{});

    const cid = interaction.customId;

    // ========= SHIFT START =========
    if (cid.startsWith("shift-start-")) {
        const id = cid.split("shift-start-")[1];

        db.prepare(`
            UPDATE shifts 
            SET status='active', start_ts=? 
            WHERE id=?
        `).run(Date.now(), id);

        return interaction.editReply("✅ Shift started.");
    }

    // ========= SHIFT END =========
    if (cid.startsWith("shift-end-")) {
        const id = cid.split("shift-end-")[1];
        const end = Date.now();

        const shift = db.prepare("SELECT * FROM shifts WHERE id=?").get(id);
        const duration = shift.start_ts ? Math.floor((end - shift.start_ts)/60000) : 0;

        db.prepare(`
            UPDATE shifts 
            SET status='ended', end_ts=?, duration=? 
            WHERE id=?
        `).run(end, duration, id);

        return interaction.editReply("✅ Shift ended.");
    }

    // ========= SHIFT PAUSE =========
    if (cid.startsWith("shift-pause-")) {
        const id = cid.split("shift-pause-")[1];

        db.prepare(`
            UPDATE shifts SET status='paused' WHERE id=?
        `).run(id);

        return interaction.editReply("⏸ Shift paused.");
    }

    // ========= ADD TIME =========
    if (cid.startsWith("admin-addtime-")) {
        const id = cid.split("admin-addtime-")[1];

        db.prepare(`
            UPDATE shifts 
            SET duration = COALESCE(duration,0) + 10 
            WHERE id=?
        `).run(id);

        return interaction.editReply("➕ 10 minutes added.");
    }

    // ========= REMOVE TIME =========
    if (cid.startsWith("admin-removetime-")) {
        const id = cid.split("admin-removetime-")[1];

        db.prepare(`
            UPDATE shifts 
            SET duration = MAX(COALESCE(duration,0) - 10, 0)
            WHERE id=?
        `).run(id);

        return interaction.editReply("➖ 10 minutes removed.");
    }

    // ========= SET TIME =========
    if (cid.startsWith("admin-settime-")) {
        return interaction.editReply("⚠ Set Time not implemented yet (I can add modal input).");
    }

    // ========= RESET TIME =========
    if (cid.startsWith("admin-resettime-")) {
        const id = cid.split("admin-resettime-")[1];

        db.prepare(`
            UPDATE shifts SET duration=0 WHERE id=?
        `).run(id);

        return interaction.editReply("♻ Time reset.");
    }

    // ========= DELETE FROM MENU =========
    if (cid.startsWith("delete-latest-")) {
        const uid = cid.split("delete-latest-")[1];

        const row = db.prepare(`
            SELECT id FROM shifts 
            WHERE user_id=? 
            ORDER BY start_ts DESC LIMIT 1
        `).get(uid);

        if (row) {
            db.prepare("DELETE FROM shifts WHERE id=?").run(row.id);
            return interaction.editReply("🗑 Most recent shift deleted.");
        }

        return interaction.editReply("No shifts found.");
    }
}


    }

    // ------------------ MODALS SUBMISSIONS ------------------
    if (interaction.isModalSubmit() && interaction.customId && interaction.customId.startsWith('loa_start_modal')) {
      const parts = interaction.customId.split('_');
      const guildId = parts.length >= 3 ? parts[2] : (interaction.guild ? interaction.guild.id : null);
      const duration = interaction.fields.getTextInputValue('duration_input');
      const reason = interaction.fields.getTextInputValue('reason_input');
      const uid = interaction.user.id;
      const startTs = now();
      let endTs = startTs;
      const m = duration.match(/^(\d+)([dw])$/i);
      if (m) {
        const val = parseInt(m[1],10);
        const unit = m[2].toLowerCase();
        if (unit === 'd') endTs += val * 86400;
        if (unit === 'w') endTs += val * 7 * 86400;
      } else {
        const n = parseInt(duration,10);
        if (!isNaN(n)) endTs += n * 86400;
      }
      // enforce max 6 months
      if (endTs - startTs > LOA_MAX_SECONDS) {
        return interaction.reply({ content: 'Requested LoA exceeds maximum allowed duration (6 months).', ephemeral: true });
      }
      // check existing LoA active if multiple not allowed
      const existing = db.prepare('SELECT * FROM loa WHERE user_id = ? AND guild_id = ? AND status = ?').get(uid, guildId, 'approved');
      if (existing) return interaction.reply({ content: 'You already have an active LoA.', ephemeral: true });
      const res = db.prepare('INSERT INTO loa (user_id,guild_id,start_ts,end_ts,reason,status) VALUES (?,?,?,?,?,?)').run(uid, guildId, startTs, endTs, reason || 'No reason provided', 'pending');
      const loaId = res.lastInsertRowid;
      await logAction(uid, guildId, uid, 'loa_request_modal', JSON.stringify({ id: loaId }));
      const embed = new EmbedBuilder()
        .setAuthor({ name: interaction.guild ? interaction.guild.name : 'Guild', iconURL: interaction.guild ? interaction.guild.iconURL() : null })
        .setTitle('Leave of Absence Pending')
        .setDescription(`Your Leave of Absence is pending review by management.\nIf approved, it will end at approximately:\n<t:${endTs}:f>\n\nID: ${loaId}`)
        .setColor(EMBED_COLOR)
        .setFooter({ text: footerTextForLocale(interaction.guild) })
        .setTimestamp();
      await interaction.reply({ embeds: [embed], ephemeral: true });
      const cfg = getSetting(`guild_${guildId}_settings`) || {};
      if (cfg && cfg.shift_log_channel) {
        const logCh = await client.channels.fetch(cfg.shift_log_channel).catch(()=>null);
        if (logCh && logCh.send) await logCh.send({ embeds: [embed] }).catch(()=>null);
      }
      return;
    }

    // ------------------ COMMANDS ------------------
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, member, guild, user } = interaction;
    const gid = guild ? guild.id : 'dm';
    const uid = user.id;

    // helper for sending logs: use guild-specific shift log channel
    async function maybeSendLog(embed) {
      if (!guild) return;
      await sendLogChannelEmbed(guild, embed);
    }

    // shift management
    if (commandName === 'shift-manage') {
    if (!isAdmin(member))
        return interaction.reply({ content: 'You may not manage shifts.', ephemeral: true });

    const sub = interaction.options.getSubcommand();

    if (sub === 'menu') {
        const shiftId = interaction.options.getInteger('id');
        const shift = db.prepare('SELECT * FROM shifts WHERE id=?').get(shiftId);

        if (!shift)
            return interaction.reply({ content: 'Shift not found.', ephemeral: true });

        const userObj = await client.users.fetch(shift.user_id);

        const embed = new EmbedBuilder()
            .setTitle(`Shift #${shift.id} von ${userObj.tag}`)
            .addFields(
                { name: 'Status', value: shift.status || 'Nicht gestartet', inline: true },
                { name: 'Startzeit', value: shift.start_time || '–', inline: true },
                { name: 'Endzeit', value: shift.end_time || '–', inline: true },
                { name: 'Dauer', value: shift.duration ? `${shift.duration} Minuten` : '–', inline: true }
            )
            .setColor(shift.status === 'active' ? 'Green' : 'Orange')
            .setFooter({ text: 'Admin Shift Management' });

        // SelectMenu für Aktionen
        const actionMenu = new StringSelectMenuBuilder()
            .setCustomId(`shift-action-${shift.id}`)
            .setPlaceholder('Shift actions')
            .addOptions([
                { label: 'View shift list', description: 'View all shifts for this user', value: 'view' },
                { label: 'Modify shift', description: 'Modify a shift: add, remove or set time', value: 'modify' },
                { label: 'Delete shift', description: 'Delete a shift', value: 'delete' },
                { label: 'Clear user shifts', description: 'Clear all shifts for this user', value: 'clear' },
            ]);

        const components = [
            new ActionRowBuilder().addComponents(actionMenu),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`shift-start-${shift.id}`)
                    .setLabel('Shift starten')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`shift-end-${shift.id}`)
                    .setLabel('Shift beenden')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`shift-pause-${shift.id}`)
                    .setLabel('Shift pausieren')
                    .setStyle(ButtonStyle.Secondary)
            )
        ];

        return interaction.reply({ embeds: [embed], components, ephemeral: true });
    }
}

    // ---------- SHIFT ----------
    if (commandName === 'shift') {
      const sub = options.getSubcommand();

      const group = options.getSubcommandGroup(false);

if (group === 'type' && sub === 'list') {
  const types = db.prepare('SELECT name FROM shift_types ORDER BY name').all();

  if (!types.length) {
    return interaction.reply({ content: 'No shift types found.', ephemeral: true });
  }

  const embed = new EmbedBuilder()
    .setTitle('Shift Types')
    .setDescription(types.map(t => `• ${t.name}`).join('\n'))
    .setColor(EMBED_COLOR)
    .setFooter({ text: footerTextForLocale(guild) })
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

      // START
      if (sub === 'start') {
        const type = options.getString('type') || 'Customer Worker';
        const startTs = now();
        const st = db.prepare('SELECT * FROM shift_types WHERE name = ?').get(type);
        if (st && st.role_id) {
          const roleId = st.role_id;
          if (!member.roles.cache.has(roleId)) return interaction.reply({ content: `You need role <@&${roleId}> to start a ${type} shift.`, ephemeral: true });
          if (!st) {
            return interaction.reply({ content: `❌ Shift type "${type}" does not exist.\nUse "/shift type list" to see all valid shift types.`, ephemeral: true });
          }
        }
        const cfg = getSetting(`guild_${gid}_settings`) || {};
        if (cfg.one_active_shift) {
          const existing = db.prepare('SELECT * FROM shifts WHERE user_id = ? AND guild_id = ? AND (status = ? OR status = ?)').get(uid, gid, 'active', 'paused');
          if (existing) return interaction.reply({ content: 'You already have an active or paused shift.', ephemeral: true });
        }
        const res = db.prepare('INSERT INTO shifts (user_id,guild_id,start_ts,type,status) VALUES (?,?,?,?,?)').run(uid, gid, startTs, type, 'active');
        const shiftId = res.lastInsertRowid;
        await assignShiftRole(member);
        await logAction(uid, gid, uid, 'shift_start', JSON.stringify({ id: shiftId, type }));
        const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
        const embed = buildDetailedShiftEmbed(user, shift, { actor: user, actionLabel: 'Started by' });
        await interaction.reply({ embeds: [embed], components: [buildShiftButtons(shift.id, 'active')] });
        await maybeSendLog(embed);
        return;
      }

      // PAUSE
      if (sub === 'pause') {
        const row = db.prepare('SELECT * FROM shifts WHERE user_id=? AND guild_id=? AND status=?').get(uid, gid, 'active');
        if (!row) return interaction.reply({ content: 'No active shift found.', ephemeral: true });
        const pauseTs = now();
        const elapsed = Math.max(0, pauseTs - row.start_ts);
        const total = (row.total_seconds || 0) + elapsed;
        db.prepare('UPDATE shifts SET pause_ts=?, status=?, total_seconds=? WHERE id=?').run(pauseTs, 'paused', total, row.id);
        await logAction(uid, gid, uid, 'shift_pause', JSON.stringify({ id: row.id }));
        const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(row.id);
        const embed = buildDetailedShiftEmbed(user, shift, { actor: user, actionLabel: 'Paused by' });
        await interaction.reply({ embeds: [embed], components: [buildShiftButtons(shift.id, 'paused')] });
        await maybeSendLog(embed);
        return;
      }

      // RESUME
      if (sub === 'resume') {
        const row = db.prepare('SELECT * FROM shifts WHERE user_id=? AND guild_id=? AND status=?').get(uid, gid, 'paused');
        if (!row) return interaction.reply({ content: 'No paused shift found.', ephemeral: true });
        const resumeTs = now();
        db.prepare('UPDATE shifts SET resume_ts=?, start_ts=?, status=? WHERE id=?').run(resumeTs, resumeTs, 'active', row.id);
        await logAction(uid, gid, uid, 'shift_resume', JSON.stringify({ id: row.id }));
        const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(row.id);
        const embed = buildDetailedShiftEmbed(user, shift, { actor: user, actionLabel: 'Resumed by' });
        await interaction.reply({ embeds: [embed], components: [buildShiftButtons(shift.id, 'active')] });
        await maybeSendLog(embed);
        return;
      }

      // END
      if (sub === 'end') {
        const row = db.prepare('SELECT * FROM shifts WHERE user_id=? AND guild_id=? AND status IN (?,?)').get(uid, gid, 'active', 'paused');
        if (!row) return interaction.reply({ content: 'No active or paused shift found.', ephemeral: true });
        const endTs = now();
        let total = row.total_seconds || 0;
        if (row.status === 'active') total += Math.max(0, endTs - row.start_ts);
        db.prepare('UPDATE shifts SET end_ts=?, status=?, total_seconds=? WHERE id=?').run(endTs, 'ended', total, row.id);
        try { const mem = await guild.members.fetch(uid).catch(() => null); if (mem) await removeShiftRole(mem); } catch {}
        await logAction(uid, gid, uid, 'shift_end', JSON.stringify({ id: row.id, total }));
        const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(row.id);
        const embed = buildDetailedShiftEmbed(user, shift, { actor: user, actionLabel: 'Ended by' });
        await interaction.reply({ embeds: [embed], components: [] });
        await maybeSendLog(embed);
        return;
      }
      // shift panel
      if (sub === 'panel') {

    const row = db.prepare(`
        SELECT * FROM shifts WHERE user_id=? AND guild_id=? AND status IN ('active','paused')
    `).get(uid, gid);

    if (!row) {
        const embed = new EmbedBuilder()
            .setTitle("🕒 Shift Panel")
            .setDescription("You have no active shift.\nUse Start to begin your shift.")
            .setColor(EMBED_COLOR)
            .setFooter({ text: footerTextForLocale(guild) });

        return interaction.reply({
            embeds: [embed],
            components: [buildShiftButtons('new', 'none')]
        });
    }

    const embed = buildDetailedShiftEmbed(user, row);
    const buttons = buildShiftButtons(row.id, row.status);

    return interaction.reply({ embeds: [embed], components: [buttons] });
}
// ACTIVE SHIFTS panel
if (sub === 'active') {

    const rows = db.prepare(`
        SELECT * FROM shifts 
        WHERE guild_id=? AND status IN ('active','paused')
        ORDER BY start_ts ASC
    `).all(gid);

    if (!rows.length) {
        return interaction.reply({ content: '✅ No active shifts.', ephemeral: true });
    }

    let table = [];

    for (const r of rows) {
        const u = await client.users.fetch(r.user_id);
        const time = now() - r.start_ts;
        const status = r.status === 'paused' ? ' (paused)' : '';
        table.push(
            `**${r.type || 'Default'}** | ${u.tag}${status} | ${smallHMS(time)}`
        );
    }

    const embed = new EmbedBuilder()
        .setTitle("🟢 Active Shifts")
        .setDescription(table.join('\n'))
        .setColor(0x2ecc71)
        .setFooter({ text: footerTextForLocale(guild) });

    return interaction.reply({ embeds: [embed] });
}


      // LOGS
      if (sub === 'logs') {
        const limit = options.getInteger('limit') || 10;
        const rows = db.prepare('SELECT * FROM shifts WHERE user_id=? AND guild_id=? ORDER BY start_ts DESC LIMIT ?').all(uid, gid, limit);
        if (!rows.length) return interaction.reply({ content: 'No shift logs found.', ephemeral: true });
        const embeds = [];
        for (const r of rows) {
          const embed = buildDetailedShiftEmbed(user, r);
          embeds.push(embed);
        }
        await interaction.reply({ embeds, ephemeral: true });
        return;
      }

      // LEADERBOARD
      if (sub === 'leaderboard') {
        const typeFilter = options.getString('type');
        if (typeFilter) {
          const st = db.prepare('SELECT * FROM shift_types WHERE name = ?').get(typeFilter);
          if (!st) {
            return interaction.reply({ 
              content: `❌ Unknown Shift Type: ${typeFilter}`, 
              ephemeral: true 
            });           
          }
        }
        await sendLeaderboard(interaction, typeFilter, 1);
        return;
      }
    }

    // ---------- LOA ----------
    if (commandName === 'loa') {
      const sub = options.getSubcommand();

      if (sub === 'request') {
        const duration = options.getString('duration');
        const reason = options.getString('reason') || 'No reason provided';
        const startTs = now();
        let endTs = startTs;
        const m = duration.match(/^(\d+)([dw])$/i);
        if (m) {
          const val = parseInt(m[1], 10);
          const unit = m[2].toLowerCase();
          if (unit === 'd') endTs += val * 86400;
          if (unit === 'w') endTs += val * 7 * 86400;
        }
        if (endTs - startTs > LOA_MAX_SECONDS) return interaction.reply({ content: 'LoA exceeds 6 months max.', ephemeral: true });
        const existing = db.prepare('SELECT * FROM loa WHERE user_id=? AND guild_id=? AND status=?').get(uid, gid, 'approved');
        if (existing) return interaction.reply({ content: 'You already have an active LoA.', ephemeral: true });
        const res = db.prepare('INSERT INTO loa (user_id,guild_id,start_ts,end_ts,reason,status) VALUES (?,?,?,?,?,?)').run(uid, gid, startTs, endTs, reason, 'pending');
        const loaId = res.lastInsertRowid;
        await logAction(uid, gid, uid, 'loa_request', JSON.stringify({ id: loaId }));
        const embed = new EmbedBuilder()
          .setTitle('Leave of Absence Pending')
          .setDescription(`Your LoA request is pending.\nEnds: <t:${endTs}:f>\nID: ${loaId}`)
          .setColor(EMBED_COLOR)
          .setFooter({ text: footerTextForLocale(guild) })
          .setTimestamp();
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (sub === 'list') {
        const rows = db.prepare('SELECT * FROM loa WHERE user_id=? ORDER BY start_ts DESC LIMIT 7').all(uid);
        if (!rows.length) return interaction.reply({ content: 'No LoAs found.', ephemeral: true });
        const embed = buildLoAListEmbed(guild, rows);
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (sub === 'status') {
        const row = db.prepare('SELECT * FROM loa WHERE user_id=? AND status=?').get(uid, 'approved');
        if (!row) return interaction.reply({ content: 'You have no active LoA.', ephemeral: true });
        const embed = new EmbedBuilder()
          .setTitle('Active LoA')
          .setDescription(`Ends: <t:${row.end_ts}:f>\nReason: ${row.reason}`)
          .setColor(EMBED_COLOR)
          .setFooter({ text: footerTextForLocale(guild) })
          .setTimestamp();
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (sub === 'manage') {
        // LoA management menu: start, end, extend
        const rows = db.prepare('SELECT * FROM loa WHERE status=? ORDER BY start_ts DESC LIMIT 7').all('approved');
        const embed = new EmbedBuilder()
          .setTitle('LoA Management')
          .setDescription(rows.map(r => `#${r.id} • <@${r.user_id}> ends <t:${r.end_ts}:f>`).join('\n'))
          .setColor(EMBED_COLOR)
          .setFooter({ text: footerTextForLocale(guild) })
          .setTimestamp();
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId('loa_start').setLabel('Start').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('loa_end').setLabel('End').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('loa_extend').setLabel('Extend').setStyle(ButtonStyle.Primary)
          );
        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        return;
      }
    }

    // ---------- LOA-MANAGE ----------
    if (commandName === 'loa-manage') {
      if (!isAdmin(member)) return interaction.reply({ content: 'Only admins may manage LoAs.', ephemeral: true });
      const sub = options.getSubcommand();
      const id = options.getInteger('id');
      const note = options.getString('note') || '';
      if (sub === 'approve') {
        const row = db.prepare('SELECT * FROM loa WHERE id=?').get(id);
        if (!row) return interaction.reply({ content: 'LoA not found.', ephemeral: true });
        db.prepare('UPDATE loa SET status=? WHERE id=?').run('approved', id);
        try {
          const mem = await guild.members.fetch(row.user_id).catch(()=>null);
          if (mem) {
            const role = guild.roles.cache.get(LOA_ROLE_ID);
            if (role) await mem.roles.add(role);
          }
          const u = await client.users.fetch(row.user_id).catch(()=>null);
          if (u) {
            const e = new EmbedBuilder()
              .setTitle('LoA Approved')
              .setDescription(`Your LoA request has been approved.\nID: ${id}\nNote: ${note}`)
              .setColor(0x2ecc71)
              .setFooter({ text: footerTextForLocale(guild) })
              .setTimestamp();
            await u.send({ embeds: [e] }).catch(()=>null);
          }
        } catch {}
        await logAction(row.user_id, gid, uid, 'loa_approved', JSON.stringify({ id, note }));
        await interaction.reply({ content: `LoA #${id} approved.`, ephemeral: true });
        return;
      }
      if (sub === 'deny') {
        const row = db.prepare('SELECT * FROM loa WHERE id=?').get(id);
        if (!row) return interaction.reply({ content: 'LoA not found.', ephemeral: true });
        db.prepare('UPDATE loa SET status=? WHERE id=?').run('denied', id);
        await logAction(row.user_id, gid, uid, 'loa_denied', JSON.stringify({ id, note }));
        await interaction.reply({ content: `LoA #${id} denied.`, ephemeral: true });
        return;
      }
      if (sub === 'list') {
        const limit = options.getInteger('limit') || 10;
        const rows = db.prepare('SELECT * FROM loa WHERE status=? ORDER BY start_ts DESC LIMIT ?').all('pending', limit);
        if (!rows.length) return interaction.reply({ content: 'No pending LoAs.', ephemeral: true });
        const embed = new EmbedBuilder()
          .setTitle('Pending LoAs')
          .setDescription(rows.map(r => `#${r.id} • <@${r.user_id}> • <t:${r.start_ts}:f> → <t:${r.end_ts}:f>`).join('\n'))
          .setColor(EMBED_COLOR)
          .setFooter({ text: footerTextForLocale(guild) })
          .setTimestamp();
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }
    }

    // ---------- BOT-MANAGE ----------
    if (commandName === 'bot-manage') {
      if (!isAdmin(member)) return interaction.reply({ content: 'You may not manage bot settings.', ephemeral: true });
      const sub = options.getSubcommand();
      const cfgKey = `guild_${gid}_settings`;
      let cfg = getSetting(cfgKey) || {};
      if (sub === 'view') {
        const desc = Object.entries(cfg).map(([k,v]) => `- ${k}: ${JSON.stringify(v)}`).join('\n');
        const embed = new EmbedBuilder().setTitle('Bot Settings').setDescription(desc || 'No settings.').setColor(EMBED_COLOR).setFooter({ text: footerTextForLocale(guild) });
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }
      if (sub === 'set-shift-log') {
        const chId = options.getString('channel');
        cfg.shift_log_channel = chId;
        setSetting(cfgKey, cfg);
        await interaction.reply({ content: `Shift log channel set to <#${chId}>`, ephemeral: true });
        return;
      }
      if (sub === 'set-report-channel') {
        const chId = options.getString('channel');
        cfg.report_channel = chId;
        setSetting(cfgKey, cfg);
        await interaction.reply({ content: `Report channel set to <#${chId}>`, ephemeral: true });
        return;
      }
      if (sub === 'set-role') {
        const type = options.getString('type');
        const roleId = options.getString('roleid');
        const st = db.prepare('SELECT * FROM shift_types WHERE name=?').get(type);
        if (!st) return interaction.reply({ content: `Shift type ${type} not found.`, ephemeral: true });
        db.prepare('UPDATE shift_types SET role_id=? WHERE name=?').run(roleId, type);
        await interaction.reply({ content: `Role for shift type ${type} set to <@&${roleId}>`, ephemeral: true });
        return;
      }
      if (sub === 'toggle-one-shift') {
        const value = options.getString('value').toLowerCase() === 'on';
        cfg.one_active_shift = value;
        setSetting(cfgKey, cfg);
        await interaction.reply({ content: `Single active shift is now ${value ? 'ON' : 'OFF'}`, ephemeral: true });
        return;
      }
      if (sub === 'set-requirement') {
        const mins = options.getInteger('minutes');
        cfg.requirement_minutes = mins;
        setSetting(cfgKey, cfg);
        await interaction.reply({ content: `Requirement time set to ${mins} minutes`, ephemeral: true });
        return;
      }
      if (sub === 'set-report-schedule') {
        const time = options.getString('time');
        const interval = options.getInteger('interval_days');
        cfg.report_schedule = { time, interval_days: interval };
        setSetting(cfgKey, cfg);
        await interaction.reply({ content: `Report schedule set to ${time} every ${interval} days`, ephemeral: true });
        return;
      }
      if (sub === "set-admin-shift-logs") {

    const channel = options.getChannel("channel");

    db.prepare(`
        INSERT INTO admin_settings (guild_id, shift_log_channel)
        VALUES (?, ?)
        ON CONFLICT(guild_id)
        DO UPDATE SET shift_log_channel = excluded.shift_log_channel
    `).run(guild.id, channel.id);

    return interaction.reply({
        content: `✅ Admin shift logs will now be sent to ${channel}.`,
        ephemeral: true
    });
      }
    }

    // ---------- REPORT ----------
    if (commandName === 'report') {
      const sub = options.getSubcommand();
      if (sub === 'setup') {
        const time = options.getString('time');
        const interval = options.getInteger('interval_days');
        const cfgKey = `guild_${gid}_settings`;
        let cfg = getSetting(cfgKey) || {};
        cfg.report_schedule = { time, interval_days: interval };
        setSetting(cfgKey, cfg);
        await interaction.reply({ content: `Automatic report scheduled at ${time} every ${interval} days.`, ephemeral: true });
        return;
      }
      if (sub === 'run') {
        const days = options.getInteger('days');

        const typeFilter = options.getString('type');

        if (typeFilter) {
          const st = db.prepare('SELECT * FROM shift_types WHERE name = ?').get(typeFilter);
          if (!st) {
            return interaction.reply({ 
              content: `❌ Invalid Shift Type: ${typeFilter}`, 
              ephemeral: true 
            });           
          }
        }

        const cfg = getSetting(`guild_${gid}_settings`) || {};
        const reportCh = cfg.report_channel;
        if (!reportCh) return interaction.reply({ content: 'Report channel not set.', ephemeral: true });
        await generateAndSendReport(gid, reportCh, days, typeFilter, cfg.included_roles || []);
        await interaction.reply({ content: 'Report generated.', ephemeral: true });
        return;
      }
    }

  } catch (e) {
    console.error('Interaction handler error', e);
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content: 'An error occurred.', ephemeral: true });
    else await interaction.reply({ content: 'An error occurred.', ephemeral: true });
  }
});

// ---------- Leaderboard pagination handler ----------
async function sendLeaderboard(interaction, typeFilter, page = 1) {
  const gid = interaction.guild.id;
  const limitPerPage = 10;
  const offset = (page - 1) * limitPerPage;
  let q = 'SELECT user_id, SUM(total_seconds) as total FROM shifts WHERE guild_id=? AND status IN (?,?)';
  const params = [gid, 'active','ended'];
  if (typeFilter) { q += ' AND type=?'; params.push(typeFilter); }
  q += ' GROUP BY user_id ORDER BY total DESC LIMIT ? OFFSET ?';
  params.push(limitPerPage, offset);
  const rows = db.prepare(q).all(...params);
  if (!rows.length) return interaction.reply({ content: 'No leaderboard data.', ephemeral: true });
  const embed = new EmbedBuilder()
    .setTitle(`Shift Leaderboard${typeFilter ? ' • '+typeFilter : ''}`)
    .setColor(EMBED_COLOR)
    .setDescription(rows.map((r,i)=>`#${offset+i+1} • <@${r.user_id}> • ${secsToHMS(r.total||0)}`).join('\n'))
    .setFooter({ text: footerTextForLocale(interaction.guild) });
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId(`leaderboard_next_${page+1}_${typeFilter||''}`).setLabel('Next').setStyle(ButtonStyle.Primary)
    );
  await interaction.reply({ embeds: [embed], components: [row] });
}

client.once('Ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(TOKEN);