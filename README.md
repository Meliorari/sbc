# SkyBlock Mining Coach 

A tiny remote MCP server that gives Claude live access to your Hypixel SkyBlock data.
It runs where there's real internet, so it does the three things the browser/sandbox
couldn't: hits the Hypixel API, decodes your gear NBT, and computes HotM + mining level.
Once it's connected, you just ask Claude — no pasting JSON.

## Tools it exposes
- `analyze_mining(username, profile?)` — full readout: mining level, HotM tier, powder, decoded armor/equipment/pickaxes, pets
- `get_gear(username, profile?)` — armor, equipment, and any pickaxes/drills/gauntlets with reforges + enchants + gems
- `get_hotm(username, profile?)` — HotM tier/XP + powder totals
- `list_profiles(username)` — profile names and which is selected

---

## 1. Get a Hypixel API key
https://developer.hypixel.net/dashboard → Create API Key. You'll set it as an env var
(never in the code). **Regenerate the old key from earlier** — it's been pasted in plaintext.

## 2. Deploy (Render — free tier is fine)
1. Push these files to a GitHub repo (`index.js`, `package.json`, `.gitignore`).
2. Render → **New → Web Service** → connect the repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Environment variable:** `HYPIXEL_API_KEY` = your key
4. Deploy. You'll get a public URL like `https://skyblock-mining-coach.onrender.com`.
   Your MCP endpoint is that URL **+ `/mcp`**.

> Render's free tier sleeps when idle, so the first call after a nap takes ~30s to wake.
> That's fine for personal use.

Test it's alive: open the base URL in a browser — it should say the server is running.

## 3. Add it to Claude
Customize → **Connectors** → **`+`** (Add custom connector) →
- **Name:** SkyBlock Mining Coach
- **URL:** `https://YOUR-APP.onrender.com/mcp`

No OAuth needed (your Hypixel key lives on the server, not in Claude). Enable it in a chat
via the connectors menu.

> Heads up: Claude reaches your server **from Anthropic's cloud, not your machine** — that's
> exactly why localhost failed before. As long as the Render URL is public, it connects.
> Free Claude accounts get one custom connector; Pro/Max and up get more.

## 4. Use it
In any chat with the connector enabled:
- "Analyze amlt's mining setup"
- "What's amlt's HotM tier and powder?"
- "Show amlt's gear on the Mango profile"

I'll call the tools, get your live data, and give advice off real numbers.

---

## Notes
- **The HotM gap:** if `mining_core.experience` is missing from the API response (like in the
  manual export earlier), `get_hotm`/`analyze_mining` returns a `note` saying so instead of
  guessing. A fresh live pull normally includes it.
- **Local testing (optional):** `npm install`, then
  `HYPIXEL_API_KEY=yourkey npm start`, and point the
  [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at `http://localhost:3000/mcp`.
- **Extending it:** add tools the same way — gemstone/collection counts, networth, slayer,
  whatever you want to coach on. The data's all in the same profile object.
