require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const commands = [
  new SlashCommandBuilder()
    .setName('backfill')
    .setDescription('Scan channel history and import all past maptap results'),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the maptap leaderboard ranked by average score'),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show maptap stats for a player')
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('Player to look up (defaults to you)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('digest')
    .setDescription('Post the daily digest for a given date (defaults to today)')
    .addStringOption((opt) =>
      opt
        .setName('date')
        .setDescription('Date in YYYY-MM-DD format (defaults to today)')
        .setRequired(false)
    ),
].map((cmd) => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
      : Routes.applicationCommands(CLIENT_ID);
    await rest.put(route, { body: commands });
    console.log('Done.');
  } catch (err) {
    console.error(err);
  }
})();
