# Steam Web Bot

A small local web app that looks up any Steam profile and shows:

- Profile basics (name, avatar, country, account age, online status)
- Steam level + XP
- Total games owned and total hours played
- Owned games list with hours per game (filterable, sorted by hours)
- Recently played games (last 2 weeks)
- VAC / game / community / trade ban status
- Friends list count
- Currently playing (if online and in a game)

Runs entirely on `localhost`. Your API key never leaves your machine.

## Setup

1. **Get a Steam Web API key** (free, takes 1 minute):
   - Go to https://steamcommunity.com/dev/apikey
   - Sign in, enter any domain name (e.g. `localhost`), agree to terms, submit.
   - Copy the key.

2. **Add your key to `.env`**:
   Open `.env` in this folder and replace `PASTE_YOUR_NEW_KEY_HERE` with your key:
   ```
   STEAM_API_KEY=your_actual_key_here
   PORT=3000
   ```

3. **Install dependencies**:
   ```
   npm install
   ```

4. **Run**:
   ```
   npm start
   ```
   Then open http://localhost:3000 in your browser.

## Usage

In the search bar, enter any of:

- **SteamID64** — e.g. `76561197960435530`
- **Vanity name** — e.g. `gabelogannewell`
- **Full profile URL** — e.g. `https://steamcommunity.com/id/gabelogannewell` or `https://steamcommunity.com/profiles/76561197960435530`

## Notes

- If a profile is private, the app still shows what's public (profile basics, ban status) and labels the rest as "Private".
- The Steam Web API has a generous rate limit (~100k calls per day per key) — plenty for personal use.
- All data is fetched on-demand; nothing is cached or stored.

## Privacy / Security

- The `.env` file containing your API key is gitignored.
- The frontend never sees your key — all Steam API calls go through the local Node server.
- If you accidentally leak your key, revoke it at https://steamcommunity.com/dev/revoke and request a new one.

## Files

```
steamwebbot/
  server.js          Express server + Steam Web API logic
  package.json
  .env               Your API key (gitignored)
  .env.example       Template
  public/
    index.html       UI shell
    styles.css       Dark Steam-themed styling
    app.js           Frontend logic
```
