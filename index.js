// SBC — SkyBlock Coach (remote MCP server)
// Fetches a player's full Hypixel SkyBlock data, decodes gear NBT, and computes
// levels across every system. Connect it to Claude as a custom connector; Claude
// does the master-level coaching on top of the live data.
//
// Required env var: HYPIXEL_API_KEY  (https://developer.hypixel.net/dashboard)
// Optional:         PORT             (Render sets this automatically)

import express from "express";
import zlib from "node:zlib";
import { promisify } from "node:util";
import nbt from "prismarine-nbt";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const gunzip = promisify(zlib.gunzip);
const KEY = process.env.HYPIXEL_API_KEY;
if (!KEY) console.warn("WARNING: HYPIXEL_API_KEY not set — Hypixel calls will fail.");

// ============================================================ LEVEL TABLES ===
// Cumulative XP -> level. Verify against the wiki if Hypixel rebalances anything.
const SKILL_CUM = [50,175,375,675,1175,1925,2925,4425,6425,9925,14925,22425,32425,47425,67425,97425,147425,222425,322425,522425,822425,1222425,1722425,2322425,3022425,3822425,4722425,5722425,6822425,8022425,9322425,10722425,12222425,13822425,15522425,17322425,19222425,21222425,23322425,25522425,27822425,30222425,32722425,35322425,38072425,40972425,44072425,47472425,51172425,55172425,59472425,64072425,68972425,74172425,79672425,85472425,91572425,97972425,104672425,111672425];
const HOTM_CUM  = [0,3000,12000,37000,97000,197000,347000,557000,837000,1187000]; // tiers 1..10
const SLAYER_CUM= [0,5,15,200,1000,5000,20000,100000,400000,1000000];             // lvl 0..9 (zombie/spider/wolf/ender/blaze)
const VAMP_CUM  = [0,20,75,240,840,2400];                                          // riftstalker/vampire lvl 0..5
const CATA_CUM  = [0,50,125,235,395,625,955,1425,2095,3045,4385,6275,8940,12700,17960,25340,35640,50040,70040,97640,135640,188140,259640,356640,488640,668640,911640,1239640,1684640,2284640,3084640,4149640,5559640,7459640,9959640,13259640,17559640,23159640,30359640,39559640,51559640,66559640,85559640,109559640,139559640,177559640,225559640,285559640,360559640,453559640,569809640];

const lvlFrom = (xp, table, cap) => { let l = 0; for (const c of table) { if (xp >= c) l++; else break; } return cap ? Math.min(l, cap) : l; };
const skillLevel  = xp => lvlFrom(xp || 0, SKILL_CUM, 60);
const hotmTier    = xp => { let t=1; for (let i=0;i<HOTM_CUM.length;i++) if ((xp||0)>=HOTM_CUM[i]) t=i+1; return t; };
const slayerLevel = (xp, vamp=false) => lvlFrom(xp || 0, vamp ? VAMP_CUM : SLAYER_CUM, vamp ? 5 : 9);
const cataLevel   = xp => lvlFrom(xp || 0, CATA_CUM, 50);

const CORE_SKILLS = ["FARMING","MINING","COMBAT","FORAGING","FISHING","ENCHANTING","ALCHEMY","TAMING"];

// ============================================================ DATA FETCHING ===
async function getUuid(username) {
  const r = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`);
  if (!r.ok) throw new Error(`Mojang lookup failed for "${username}" (HTTP ${r.status})`);
  const j = await r.json();
  if (!j.id) throw new Error(`No such player: "${username}"`);
  return j.id;
}
async function getProfiles(uuid) {
  const r = await fetch(`https://api.hypixel.net/v2/skyblock/profiles?uuid=${uuid}`, { headers: { "API-Key": KEY } });
  const j = await r.json();
  if (!j.success) throw new Error(`Hypixel API error: ${j.cause || "unknown"}`);
  return j.profiles || [];
}
async function load(username, profileName) {
  const uuid = await getUuid(username);
  const profiles = await getProfiles(uuid);
  if (!profiles.length) throw new Error(`No SkyBlock profiles for "${username}"`);
  let profile;
  if (profileName) profile = profiles.find(p => p.cute_name?.toLowerCase() === profileName.toLowerCase());
  if (!profile) profile = profiles.find(p => p.selected) || profiles[0];
  const member = profile.members[uuid] || profile.members[uuid.replace(/-/g, "")];
  if (!member) throw new Error(`Member data missing on profile ${profile.cute_name}`);
  return { uuid, profile, member, profileName: profile.cute_name };
}

// ============================================================== NBT DECODE ====
async function decode(b64) {
  if (!b64) return [];
  let buf = Buffer.from(b64, "base64");
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = await gunzip(buf);
  const { parsed } = await nbt.parse(buf);
  const list = parsed.value?.i?.value?.value || [];
  return list.map(it => {
    const tag = it.tag?.value; if (!tag) return null;
    const ea = tag.ExtraAttributes?.value; const id = ea?.id?.value; if (!id) return null;
    const name = (tag.display?.value?.Name?.value || "").replace(/§./g, "");
    const reforge = ea?.modifier?.value || null;
    const ench = ea?.enchantments?.value ? Object.fromEntries(Object.entries(ea.enchantments.value).map(([k,v]) => [k, v.value])) : {};
    const gems = ea?.gems?.value ? Object.keys(ea.gems.value).filter(k => !k.endsWith("_gem")) : [];
    const stars = ea?.upgrade_level?.value ?? ea?.dungeon_item_level?.value ?? null;
    const count = it.Count?.value ?? 1;
    return { id, name, reforge, enchantments: ench, gems, stars, count };
  }).filter(Boolean);
}
// friendly container name -> location in member.inventory
function containerBlob(member, container) {
  const inv = member.inventory || {};
  const map = {
    inventory: inv.inv_contents, armor: inv.inv_armor, equipment: inv.equipment_contents,
    enderchest: inv.ender_chest_contents, vault: inv.personal_vault_contents,
    accessories: inv.bag_contents?.talisman_bag, potions: inv.bag_contents?.potion_bag,
    fishing: inv.bag_contents?.fishing_bag, quiver: inv.bag_contents?.quiver, wardrobe: inv.wardrobe_contents,
  };
  return map[container];
}

// ============================================================== SUMMARIES =====
function skillsOf(member) {
  const exp = member.player_data?.experience || {};
  const out = {};
  for (const [k, v] of Object.entries(exp)) out[k.replace("SKILL_", "").toLowerCase()] = { level: skillLevel(v), xp: Math.round(v) };
  const core = CORE_SKILLS.map(s => skillLevel(exp["SKILL_" + s] || 0));
  const skill_average = +(core.reduce((a, b) => a + b, 0) / core.length).toFixed(2);
  return { skills: out, skill_average };
}
function slayersOf(member) {
  const sb = member.slayer?.slayer_bosses || {};
  const names = { zombie:"revenant", spider:"tarantula", wolf:"sven", enderman:"voidgloom", blaze:"inferno", vampire:"riftstalker" };
  const out = {};
  for (const [k, label] of Object.entries(names)) {
    const xp = sb[k]?.xp || 0;
    out[k] = { boss: label, level: slayerLevel(xp, k === "vampire"), xp };
  }
  return out;
}
function dungeonsOf(member) {
  const d = member.dungeons || {};
  const cata = d.dungeon_types?.catacombs?.experience;
  const classes = {};
  for (const [c, v] of Object.entries(d.player_classes || {})) classes[c] = cataLevel(v.experience || 0);
  return {
    catacombs: cata === undefined ? { level: null, note: "no catacombs XP in response" } : { level: cataLevel(cata), xp: Math.round(cata) },
    selected_class: d.selected_dungeon_class || null,
    class_levels: classes,
  };
}
function miningOf(member) {
  const mc = member.mining_core || {};
  return {
    hotm: mc.experience === undefined ? { tier: null, note: "HotM experience not in response" } : { tier: hotmTier(mc.experience), xp: Math.round(mc.experience) },
    powder: {
      mithril_available: mc.powder_mithril ?? 0, mithril_spent: mc.powder_spent_mithril ?? 0,
      gemstone_available: mc.powder_gemstone ?? 0, gemstone_spent: mc.powder_spent_gemstone ?? 0,
      glacite_available: mc.powder_glacite ?? 0, glacite_spent: mc.powder_spent_glacite ?? 0,
    },
  };
}
function currenciesOf(member, profile) {
  return {
    purse: Math.round(member.currencies?.coin_purse || 0),
    bank: profile.banking?.balance != null ? Math.round(profile.banking.balance) : null,
    motes: Math.round(member.currencies?.motes_purse || 0),
    bits: member.profile?.bank_account != null ? null : (member.currencies?.bits ?? null),
  };
}
function petsOf(member) {
  return (member.pets_data?.pets || []).map(p => ({ type: p.type, tier: p.tier, active: !!p.active, heldItem: p.heldItem || null, exp: Math.floor(p.exp || 0) }))
    .sort((a, b) => (b.active - a.active) || (b.exp - a.exp));
}

// ============================================================== KNOWLEDGE ====
// MediaWiki Action API (no scraping, built for programmatic access) + Reddit JSON.
const WIKIS = {
  official: { name: "wiki.hypixel.net", endpoints: ["https://wiki.hypixel.net/api.php", "https://wiki.hypixel.net/w/api.php"], page: t => `https://wiki.hypixel.net/${t.replace(/ /g, "_")}` },
  fandom:   { name: "hypixel-skyblock.fandom.com", endpoints: ["https://hypixel-skyblock.fandom.com/api.php"], page: t => `https://hypixel-skyblock.fandom.com/wiki/${encodeURIComponent(t.replace(/ /g, "_"))}` },
};
const UA = { "User-Agent": "SBC-SkyBlockCoach/1.0 (personal Claude connector)" };
const stripHtml = s => (s || "").replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

async function mwCall(wikiKey, params) {
  const w = WIKIS[wikiKey];
  const qs = new URLSearchParams({ ...params, format: "json", formatversion: "2" }).toString();
  let lastErr;
  for (const ep of w.endpoints) {
    try { const r = await fetch(`${ep}?${qs}`, { headers: UA }); if (!r.ok) { lastErr = new Error(`HTTP ${r.status}`); continue; } return await r.json(); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error(`${w.name} unreachable`);
}
async function wikiSearch(query, wikiKey, limit = 6) {
  const j = await mwCall(wikiKey, { action: "query", list: "search", srsearch: query, srlimit: String(limit) });
  return (j.query?.search || []).map(r => ({ source: WIKIS[wikiKey].name, title: r.title, snippet: stripHtml(r.snippet), url: WIKIS[wikiKey].page(r.title) }));
}
async function wikiPage(title, wikiKey, cap = 8000) {
  const j = await mwCall(wikiKey, { action: "query", prop: "extracts", explaintext: "1", exsectionformat: "plain", redirects: "1", titles: title });
  const pages = j.query?.pages || [];
  const pg = Array.isArray(pages) ? pages[0] : Object.values(pages)[0];
  if (!pg || pg.missing) return { source: WIKIS[wikiKey].name, title, found: false, note: "no such page — try wiki_search for the exact title" };
  let extract = pg.extract || "";
  const truncated = extract.length > cap;
  return { source: WIKIS[wikiKey].name, title: pg.title, found: true, truncated, url: WIKIS[wikiKey].page(pg.title), extract: truncated ? extract.slice(0, cap) : extract };
}
async function redditSearch(query, subreddit = "HypixelSkyblock", limit = 8) {
  const url = `https://www.reddit.com/r/${subreddit}/search.json?` + new URLSearchParams({ q: query, restrict_sr: "on", sort: "relevance", t: "year", limit: String(limit), raw_json: "1" });
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`Reddit HTTP ${r.status} (likely rate-limited — Claude can web-search forums/Reddit live instead)`);
  const j = await r.json();
  return (j.data?.children || []).map(c => c.data).map(d => ({ title: d.title, score: d.score, comments: d.num_comments, date: new Date(d.created_utc * 1000).toISOString().slice(0, 10), url: `https://reddit.com${d.permalink}`, snippet: (d.selftext || "").slice(0, 500) }));
}

const text = o => ({ content: [{ type: "text", text: JSON.stringify(o, null, 2) }] });
const fail = e => ({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
const P = { username: z.string().describe("Minecraft username"), profile: z.string().optional().describe("Profile name e.g. 'Mango'; defaults to selected") };

// ================================================================ MCP TOOLS ===
function makeServer() {
  const s = new McpServer({ name: "skyblock-coach", version: "1.0.0" });

  s.tool("list_profiles", "List a player's profiles and which is selected.",
    { username: z.string() },
    async ({ username }) => { try { const u = await getUuid(username); const ps = await getProfiles(u); return text(ps.map(p => ({ name: p.cute_name, selected: !!p.selected }))); } catch (e) { return fail(e); } });

  s.tool("analyze_player", "Full overview: skills+average, mining/HotM, slayers, catacombs, currencies, active pet, fairy souls. Best starting point.",
    P, async ({ username, profile }) => { try {
      const { member, profile: prof, profileName } = await load(username, profile);
      const sk = skillsOf(member);
      return text({ profile: profileName, skill_average: sk.skill_average, skills: sk.skills,
        mining: miningOf(member), slayers: slayersOf(member), dungeons: dungeonsOf(member),
        currencies: currenciesOf(member, prof), fairy_souls: member.fairy_soul?.total_collected ?? null,
        active_pet: petsOf(member).find(p => p.active) || null });
    } catch (e) { return fail(e); } });

  s.tool("get_skills", "All skill levels + XP and the skill average.", P,
    async ({ username, profile }) => { try { const { member } = await load(username, profile); return text(skillsOf(member)); } catch (e) { return fail(e); } });

  s.tool("get_mining", "HotM tier/XP, powder totals, and decoded mining gear (armor, equipment, pickaxes/drills/gauntlets).",
    P, async ({ username, profile }) => { try {
      const { member } = await load(username, profile);
      const armor = await decode(member.inventory?.inv_armor?.data);
      const equipment = await decode(member.inventory?.equipment_contents?.data);
      const tools = [];
      for (const c of ["inventory", "enderchest"]) { const its = await decode(containerBlob(member, c)?.data); tools.push(...its.filter(i => /(PICK|DRILL|GAUNTLET|GEMSTONE)/.test(i.id)).map(i => ({ ...i, from: c }))); }
      return text({ ...miningOf(member), armor, equipment, tools });
    } catch (e) { return fail(e); } });

  s.tool("get_slayers", "Slayer levels + XP for all bosses (Revenant, Tarantula, Sven, Voidgloom, Inferno, Riftstalker).",
    P, async ({ username, profile }) => { try { const { member } = await load(username, profile); return text(slayersOf(member)); } catch (e) { return fail(e); } });

  s.tool("get_dungeons", "Catacombs level/XP, selected class, and class levels.", P,
    async ({ username, profile }) => { try { const { member } = await load(username, profile); return text(dungeonsOf(member)); } catch (e) { return fail(e); } });

  s.tool("get_gear", "Worn armor + equipment + accessories (talisman bag) + main mining tools, decoded with reforges/enchants/gems/stars.",
    P, async ({ username, profile }) => { try {
      const { member } = await load(username, profile);
      const armor = await decode(member.inventory?.inv_armor?.data);
      const equipment = await decode(member.inventory?.equipment_contents?.data);
      const accessories = await decode(containerBlob(member, "accessories")?.data);
      return text({ armor, equipment, accessory_count: accessories.length, accessories: accessories.map(a => ({ id: a.id, reforge: a.reforge })) });
    } catch (e) { return fail(e); } });

  s.tool("decode_container", "Decode any inventory container into a full item list. container ∈ inventory, armor, equipment, enderchest, vault, accessories, potions, fishing, quiver, wardrobe.",
    { ...P, container: z.enum(["inventory","armor","equipment","enderchest","vault","accessories","potions","fishing","quiver","wardrobe"]) },
    async ({ username, profile, container }) => { try { const { member } = await load(username, profile); const blob = containerBlob(member, container); if (!blob) return text({ container, items: [], note: "container empty or absent" }); return text({ container, items: await decode(blob.data) }); } catch (e) { return fail(e); } });

  s.tool("get_pets", "All pets with type, tier, level XP, held item, and which is active.", P,
    async ({ username, profile }) => { try { const { member } = await load(username, profile); return text(petsOf(member)); } catch (e) { return fail(e); } });

  s.tool("get_currencies", "Purse, bank balance, motes, and bits.", P,
    async ({ username, profile }) => { try { const { member, profile: prof } = await load(username, profile); return text(currenciesOf(member, prof)); } catch (e) { return fail(e); } });

  s.tool("get_collections", "Raw collection counts (e.g. MITHRIL_ORE, ENDER_PEARL).", P,
    async ({ username, profile }) => { try { const { member } = await load(username, profile); return text(member.collection || {}); } catch (e) { return fail(e); } });

  s.tool("get_data", "ESCAPE HATCH — read any field of the member profile object by dot-path (e.g. 'jacobs_contest', 'bestiary.kills', 'mining_core'). Empty path lists top-level keys. Use this for anything the other tools don't cover.",
    { ...P, path: z.string().optional().describe("Dot path into the member object; empty = list top-level keys") },
    async ({ username, profile, path }) => { try {
      const { member } = await load(username, profile);
      if (!path) return text({ top_level_keys: Object.keys(member) });
      let cur = member; for (const seg of path.split(".")) { if (cur == null) break; cur = cur[seg]; }
      if (cur === undefined) return text({ path, value: null, note: "not found" });
      let str = JSON.stringify(cur);
      if (str && str.length > 60000) return text({ path, truncated: true, keys: cur && typeof cur === "object" ? Object.keys(cur) : null, note: "value too large; drill deeper with a longer path" });
      return text({ path, value: cur });
    } catch (e) { return fail(e); } });

  s.tool("wiki_search", "Search the SkyBlock wiki for pages (titles + snippets + URLs). wiki ∈ official, fandom, both (default both). Use this to find the exact page title, then wiki_page to read it.",
    { query: z.string(), wiki: z.enum(["official", "fandom", "both"]).optional() },
    async ({ query, wiki = "both" }) => { try {
      const keys = wiki === "both" ? ["official", "fandom"] : [wiki];
      const out = (await Promise.all(keys.map(k => wikiSearch(query, k).catch(e => [{ source: WIKIS[k].name, error: e.message }])))).flat();
      return text(out);
    } catch (e) { return fail(e); } });

  s.tool("wiki_page", "Read a wiki page's plain-text content by exact title. wiki ∈ official, fandom, both (default official). Ground-truth formulas, item stats, requirements.",
    { title: z.string(), wiki: z.enum(["official", "fandom", "both"]).optional() },
    async ({ title, wiki = "official" }) => { try {
      const keys = wiki === "both" ? ["official", "fandom"] : [wiki];
      const out = await Promise.all(keys.map(k => wikiPage(title, k).catch(e => ({ source: WIKIS[k].name, error: e.message }))));
      return text(out.length === 1 ? out[0] : out);
    } catch (e) { return fail(e); } });

  s.tool("community_search", "Search r/HypixelSkyblock (or another subreddit) for current community/meta discussion — top posts with score, comments, date, and text. For 'what are people running now' questions.",
    { query: z.string(), subreddit: z.string().optional() },
    async ({ query, subreddit }) => { try { return text(await redditSearch(query, subreddit || "HypixelSkyblock")); } catch (e) { return fail(e); } });

  return s;
}

// ============================================================== HTTP LAYER ====
const app = express();
app.use(express.json({ limit: "6mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.get("/", (_q, r) => r.send("SBC — SkyBlock Coach MCP server is running. POST /mcp"));

// ---- OAuth shim ------------------------------------------------------------
// Claude's custom-connector flow performs OAuth discovery + Dynamic Client
// Registration even for public servers (anthropics/claude-ai-mcp #402); if those
// endpoints 404 it fails to connect instead of falling back to anonymous. This is
// an OPEN shim: it satisfies the handshake and issues a token to anyone. There's
// nothing to protect (public game data; the Hypixel key stays server-side and is
// read-only) — but note the endpoint is therefore effectively public.
const base = req => (process.env.RENDER_EXTERNAL_URL || `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`).replace(/\/$/, "");
const rnd = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const asMeta = b => ({ issuer: b, authorization_endpoint: `${b}/authorize`, token_endpoint: `${b}/token`, registration_endpoint: `${b}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256", "plain"], token_endpoint_auth_methods_supported: ["none"] });
const prMeta = b => ({ resource: `${b}/mcp`, authorization_servers: [b] });

for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp", "/.well-known/openid-configuration"])
  app.get(p, (req, res) => res.json(asMeta(base(req))));
for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"])
  app.get(p, (req, res) => res.json(prMeta(base(req))));

app.post("/register", (req, res) => res.status(201).json({
  client_id: "sbc-public-client", client_id_issued_at: Math.floor(Date.now() / 1000),
  redirect_uris: req.body?.redirect_uris || [], token_endpoint_auth_method: "none",
  grant_types: ["authorization_code"], response_types: ["code"],
}));
app.get("/authorize", (req, res) => {
  const { redirect_uri, state } = req.query;
  if (!redirect_uri) return res.status(400).send("missing redirect_uri");
  const u = new URL(String(redirect_uri));
  u.searchParams.set("code", rnd());
  if (state) u.searchParams.set("state", String(state));
  res.redirect(u.toString());
});
app.post("/token", (_req, res) => res.json({ access_token: rnd(), token_type: "bearer", expires_in: 3600, scope: "mcp" }));
// ---------------------------------------------------------------------------

app.post("/mcp", async (req, res) => {
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
  catch (e) { if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: e.message }, id: null }); }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SBC — SkyBlock Coach MCP listening on :${PORT}`));
