# maptap-bot

A Discord bot that tracks [Maptap](https://www.maptap.gg) daily results posted in a channel, stores scores per player, and provides leaderboards and stats via slash commands.

## How it works

The bot watches a configured channel for messages in the Maptap result format:

```
www.maptap.gg March 27
93🏆 96🔥 93🏆 88🎉 80✨
Final score: 879
```

When a result is detected it reacts with ✅ and saves the score to a local SQLite database. One result is stored per player per day — reposting updates the existing entry.

## Slash commands

| Command | Description |
|---|---|
| `/leaderboard` | Top 15 players ranked by average score |
| `/stats` | Your own stats and recent results |
| `/stats @user` | Stats for another player |
| `/backfill` | Scan the last 1000 messages and import past results |

## Setup

### 1. Create a Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application
2. Go to **Bot** and click **Reset Token** — save the token
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**

### 2. Invite the bot to your server

1. Go to **OAuth2 → URL Generator**
2. Select scopes: `bot`, `applications.commands`
3. Select permissions: **View Channels**, **Read Message History**, **Add Reactions**, **Use Slash Commands**
4. Open the generated URL and authorize the bot to your server

### 3. Get your IDs

Enable **Developer Mode** in Discord (User Settings → Advanced), then:

- **Client ID** — Application ID on the General Information page
- **Guild ID** — right-click your server icon → Copy Server ID
- **Channel ID** — right-click the target channel → Copy Channel ID

### 4. Configure

```sh
cp .env.example .env
```

Fill in `.env`:

```
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_client_id
GUILD_ID=your_server_guild_id
CHANNEL_ID=your_general_channel_id
```

## Running

### Docker (recommended)

```sh
docker run -d \
  --name maptap-bot \
  --restart unless-stopped \
  --env-file .env \
  -v maptap-data:/data \
  matejbasic/maptap-bot:latest
```

The SQLite database is persisted in the `maptap-data` volume at `/data/maptap.db`.

### Local

Requires Node.js 22.5+.

```sh
npm install
npm run deploy   # register slash commands (run once)
npm start
```

## Building the image

```sh
docker buildx build --platform linux/amd64,linux/arm64 -t matejbasic/maptap-bot:latest --push .
```
