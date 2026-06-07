# SBC — SkyBlock Coach (Claude custom connector)

A remote MCP server that gives Claude live, complete access to your Hypixel SkyBlock
profile. The server is the source of truth — it fetches and decodes every system. Claude
is the coach — it reasons over that live data (plus the wiki) to tell you what's best.

## Tools
| Tool | What it returns |
|---|---|
| `analyze_player` | Overview: skill average, all skills, mining/HotM, slayers, catacombs, currencies, active pet, fairy souls |
| `get_skills` | Every skill level + XP and skill average |
| `get_mining` | HotM tier/XP, powder, decoded mining gear |
| `get_slayers` | Levels + XP for all six slayer bosses |
| `get_dungeons` | Catacombs level, selected class, class levels |
| `get_gear` | Worn armor + equipment + accessories + main tools (reforges/enchants/gems/stars) |
| `decode_container` | Decode ANY container: inventory, armor, equipment, enderchest, vault, accessories, potions, fishing, quiver, wardrobe |
| `get_pets` | Every pet: type, tier, XP, held item, active |
| `get_currencies` | Purse, bank, motes, bits |
| `get_collections` | Raw collection counts |
| `get_data` | **Escape hatch** — read any field by dot-path (e.g. `jacobs_contest`, `bestiary.kills`). Covers anything not above. |
| `list_profiles` | Profile names + which is selected |
| `wiki_search` | Search the wiki (official + Fandom) for pages — titles, snippets, URLs |
| `wiki_page` | Read a wiki page's plain text — ground-truth formulas, item stats, requirements |
| `community_search` | Search r/HypixelSkyblock for current meta discussion — top posts, scores, dates |

The `get_data` escape hatch makes the *player* side cover everything — any profile field is
reachable. `wiki_*` + `community_search` cover the *game-knowledge* side: the wiki for hard
facts (both wiki.hypixel.net and the Fandom wiki), Reddit for the living meta.

**On game knowledge:** the wiki tools use the MediaWiki Action API (built for programmatic
access — no scraping, no bot-blocking). Reddit uses its public JSON search; if Reddit
rate-limits the server, Claude falls back to a **live web search** in-chat, which also covers
the Hypixel forums and anything the tools miss.

---

## Setup

### 0. Hypixel key
https://developer.hypixel.net/dashboard → Create API Key. **Regenerate the old one** — it's
been pasted in plaintext. You'll store the key as a server env var, never in the code.

### 1. Put the files on GitHub
New repo → upload `index.js`, `package.json`, `.gitignore`. (Skip `node_modules`.)

### 2. Deploy on Render (free tier is fine)
New → **Web Service** → connect the repo →
- Build command: `npm install`
- Start command: `npm start`
- Env var: `HYPIXEL_API_KEY` = your new key

Deploy → you get `https://YOUR-APP.onrender.com`. Your MCP endpoint is that **+ `/mcp`**.
Open the base URL in a browser; it should say SBC is running.

### 3. Connect to Claude
Customize → **Connectors** → **`+`** (Add custom connector) →
- Name: `SBC`
- URL: `https://YOUR-APP.onrender.com/mcp`

No OAuth — your key lives on the server. Enable it in a chat via the connectors menu.

> Claude reaches your server from Anthropic's cloud, not your machine — that's why a public
> URL works and localhost didn't. Free Claude accounts allow one custom connector.

### 4. Use it
- "SBC: analyze amlt"
- "What should amlt upgrade next?"
- "Show amlt's accessories" / "amlt's pets" / "amlt's catacombs"

---

## Extending
Every system lives in the same profile object, so adding a tool is one `s.tool(...)` block.
Natural next add: **networth** via the [`skyhelper-networth`](https://www.npmjs.com/package/skyhelper-networth)
package (it prices items from bazaar/auction data) — wire it into a `get_networth` tool.

## Local test (optional)
`npm install` then `HYPIXEL_API_KEY=key npm start`, and point the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector) at `http://localhost:3000/mcp`.
