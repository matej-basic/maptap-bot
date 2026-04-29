require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { DatabaseSync } = require('node:sqlite');

// --- Config ---
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const DB_PATH = process.env.DB_PATH || './maptap.db';
const DIGEST_HOUR = parseInt(process.env.DIGEST_HOUR ?? '22', 10);

// --- Database setup ---
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT    NOT NULL,
    username    TEXT    NOT NULL,
    game_date   TEXT    NOT NULL,
    final_score INTEGER NOT NULL,
    rounds      TEXT    NOT NULL,
    recorded_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, game_date)
  )
`);

const upsertScore = db.prepare(`
  INSERT INTO scores (user_id, username, game_date, final_score, rounds)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (user_id, game_date) DO UPDATE SET
    username    = excluded.username,
    final_score = excluded.final_score,
    rounds      = excluded.rounds,
    recorded_at = datetime('now')
`);

const getLeaderboard = db.prepare(`
  SELECT
    user_id,
    username,
    COUNT(*)         AS games_played,
    AVG(final_score) AS avg_score,
    MAX(final_score) AS best_score
  FROM scores
  GROUP BY user_id
  ORDER BY avg_score DESC
  LIMIT 15
`);

const getUserSummary = db.prepare(`
  SELECT
    COUNT(*)         AS games,
    AVG(final_score) AS avg,
    MAX(final_score) AS best,
    MIN(final_score) AS worst
  FROM scores
  WHERE user_id = ?
`);

const getUserRecent = db.prepare(`
  SELECT game_date, final_score, rounds
  FROM scores
  WHERE user_id = ?
  ORDER BY game_date DESC
  LIMIT 10
`);

const getDailyScores = db.prepare(`
  SELECT username, final_score, rounds
  FROM scores
  WHERE game_date = ?
  ORDER BY final_score DESC
`);

// --- Maptap message parser ---
const MONTHS = {
  January: 1, February: 2, March: 3, April: 4,
  May: 5, June: 6, July: 7, August: 8,
  September: 9, October: 10, November: 11, December: 12
};

function parseMaptap(content) {
  if (!content.includes('www.maptap.gg')) return null;
  if (!content.includes('Final score:')) return null;

  // Extract date: "www.maptap.gg March 27"
  const dateMatch = content.match(/www\.maptap\.gg\s+(\w+)\s+(\d+)/);
  if (!dateMatch) return null;
  const [, monthName, dayStr] = dateMatch;
  const month = MONTHS[monthName];
  if (!month) return null;
  const day = parseInt(dayStr, 10);

  // Infer year (handle year boundary: if game month is >6 months in future, use prev year)
  const now = new Date();
  let year = now.getFullYear();
  if (month - (now.getMonth() + 1) > 6) year -= 1;
  const gameDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  // Extract final score
  const finalMatch = content.match(/Final score:\s*(\d+)/i);
  if (!finalMatch) return null;
  const finalScore = parseInt(finalMatch[1], 10);

  // Extract round scores: the line with multiple digit+emoji patterns
  const lines = content.split('\n');
  let rounds = [];
  for (const line of lines) {
    if (line.includes('maptap.gg') || /final score/i.test(line)) continue;
    const nums = [...line.matchAll(/(\d+)/g)].map(m => parseInt(m[1], 10));
    if (nums.length >= 2) {
      rounds = nums;
      break;
    }
  }

  return { gameDate, finalScore, rounds };
}

const ROUND_MULTIPLIERS = [1, 1, 2, 3, 3];
const MAX_ROUND_SCORE = 100;
const MAX_TOTAL_SCORE = 1000;

function validateResult({ finalScore, rounds }) {
  if (rounds.length < ROUND_MULTIPLIERS.length) {
    return `Invalid result: expected ${ROUND_MULTIPLIERS.length} round scores, got ${rounds.length}.`;
  }

  for (let i = 0; i < ROUND_MULTIPLIERS.length; i++) {
    if (rounds[i] > MAX_ROUND_SCORE) {
      return `Invalid result: round ${i + 1} score ${rounds[i]} exceeds max of ${MAX_ROUND_SCORE}.`;
    }
  }

  const calculated = ROUND_MULTIPLIERS.reduce((sum, mult, i) => sum + rounds[i] * mult, 0);

  if (calculated !== finalScore) {
    return `Invalid result: calculated score ${calculated} does not match submitted final score ${finalScore}.`;
  }

  if (finalScore > MAX_TOTAL_SCORE) {
    return `Invalid result: final score ${finalScore} exceeds max of ${MAX_TOTAL_SCORE}.`;
  }

  return null;
}

// --- Discord client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Watching channel: ${CHANNEL_ID}`);
  client.user.setActivity('Waiting for maptap results', { type: 3 }); // 3 = Watching
});

// --- Record maptap results ---
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== CHANNEL_ID) return;

  const result = parseMaptap(message.content);
  if (!result) return;

  const validationError = validateResult(result);
  if (validationError) {
    await message.react('❌');
    await message.reply(validationError);
    console.log(`Rejected ${message.author.username}: ${validationError}`);
    return;
  }

  const { gameDate, finalScore, rounds } = result;
  upsertScore.run(
    message.author.id,
    message.author.username,
    gameDate,
    finalScore,
    JSON.stringify(rounds),
  );

  await message.react('✅');
  console.log(`Recorded ${message.author.username}: ${finalScore} on ${gameDate}`);
});

// --- Slash commands ---
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'backfill') {
    await interaction.deferReply();
    const channel = await client.channels.fetch(CHANNEL_ID);
    let recorded = 0;
    let scanned = 0;
    let lastId;
    let batch = 0;
    const MAX_MESSAGES = 10000;

    console.log('Backfill started...');

    while (scanned < MAX_MESSAGES) {
      const remaining = MAX_MESSAGES - scanned;
      const messages = await channel.messages.fetch({ limit: Math.min(100, remaining), ...(lastId && { before: lastId }) });
      if (messages.size === 0) break;

      batch++;
      scanned += messages.size;

      for (const message of messages.values()) {
        if (message.author.bot) continue;
        const result = parseMaptap(message.content);
        if (!result) continue;
        const validationError = validateResult(result);
        if (validationError) {
          console.log(`  [!] Skipped ${message.author.username}: ${validationError}`);
          continue;
        }
        upsertScore.run(
          message.author.id,
          message.author.username,
          result.gameDate,
          result.finalScore,
          JSON.stringify(result.rounds),
        );
        recorded++;
        console.log(`  [+] ${message.author.username}: ${result.finalScore} on ${result.gameDate}`);
        await message.react('✅').catch(() => { });
      }

      console.log(`Batch ${batch}: scanned ${scanned} messages total, ${recorded} results so far`);
      lastId = messages.last().id;
    }

    console.log(`Backfill complete — ${recorded} results from ${scanned} messages.`);
    return interaction.editReply(`Backfill complete — recorded ${recorded} result${recorded !== 1 ? 's' : ''} from ${scanned} messages.`);
  }

  if (interaction.commandName === 'leaderboard') {
    const rows = getLeaderboard.all();
    if (rows.length === 0) {
      return interaction.reply({ content: 'No scores recorded yet.', ephemeral: true });
    }

    const medals = ['🥇', '🥈', '🥉'];
    const lines = rows.map((row, i) => {
      const medal = medals[i] || `${i + 1}.`;
      const avg = parseFloat(row.avg_score).toFixed(1);
      return `${medal} **${row.username}** — avg ${avg} | best ${row.best_score} | ${row.games_played} games`;
    });

    const embed = new EmbedBuilder()
      .setTitle('🗺️ Maptap Leaderboard')
      .setDescription(lines.join('\n'))
      .setColor(0x5865F2)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'digest') {
    const dateInput = interaction.options.getString('date');
    const date = dateInput ?? new Date().toISOString().slice(0, 10);
    if (dateInput && !/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      return interaction.reply({ content: 'Invalid date format. Use YYYY-MM-DD.', ephemeral: true });
    }
    await interaction.deferReply();
    await postDailyDigest(date);
    return interaction.editReply(`Digest posted for ${date}.`);
  }

  if (interaction.commandName === 'stats') {
    const targetUser = interaction.options.getUser('user') ?? interaction.user;
    const summary = getUserSummary.get(targetUser.id);

    if (!summary || summary.games === 0) {
      return interaction.reply({
        content: `No scores found for **${targetUser.username}**.`,
        ephemeral: true,
      });
    }

    const recent = getUserRecent.all(targetUser.id);
    const recentLines = recent.map((row) => {
      const rounds = JSON.parse(row.rounds);
      const roundsStr = rounds.length > 0 ? `  [${rounds.join(', ')}]` : '';
      return `\`${row.game_date}\`  **${row.final_score}**${roundsStr}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`📊 Stats for ${targetUser.username}`)
      .addFields(
        { name: 'Games played', value: String(summary.games), inline: true },
        { name: 'Average score', value: parseFloat(summary.avg).toFixed(1), inline: true },
        { name: 'Best score', value: String(summary.best), inline: true },
        { name: 'Worst score', value: String(summary.worst), inline: true },
      )
      .addFields({ name: 'Recent results', value: recentLines.join('\n') || 'None' })
      .setColor(0x57F287)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
});

// --- Daily digest ---
async function postDailyDigest(date) {
  const rows = getDailyScores.all(date);
  const channel = await client.channels.fetch(CHANNEL_ID);
  const medals = ['🥇', '🥈', '🥉'];

  const [year, month, day] = date.split('-');
  const label = new Date(year, month - 1, day).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  let description;
  if (rows.length === 0) {
    description = 'No scores submitted today.';
  } else {
    description = rows.map((row, i) => {
      const medal = medals[i] || `${i + 1}.`;
      const rounds = JSON.parse(row.rounds);
      const roundsStr = rounds.length > 0 ? `  \`[${rounds.join(', ')}]\`` : '';
      return `${medal} **${row.username}** — ${row.final_score}${roundsStr}`;
    }).join('\n');
  }

  const embed = new EmbedBuilder()
    .setTitle(`🗺️ Maptap Daily Digest — ${label}`)
    .setDescription(description)
    .setColor(0xEB459E)
    .setTimestamp();

  await channel.send({ embeds: [embed] });
  console.log(`Daily digest posted for ${date} (${rows.length} scores)`);
}

let lastDigestDate = null;

setInterval(() => {
  const now = new Date();
  if (now.getHours() !== DIGEST_HOUR) return;

  const today = now.toISOString().slice(0, 10);
  if (lastDigestDate === today) return;

  lastDigestDate = today;
  postDailyDigest(today).catch(err => console.error('Digest error:', err));
}, 60_000);

client.login(TOKEN);
