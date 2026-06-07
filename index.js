// SkyBlock Mining Coach — remote MCP server
// Exposes tools that fetch a player's Hypixel SkyBlock data, decode their gear
// (gzipped base64 NBT), and compute mining/HotM levels. Connect it to Claude as a
// custom connector and Claude can call these live — no more pasting JSON.
//
// Required env var:  HYPIXEL_API_KEY   (get one at https://developer.hypixel.net/dashboard)
// Optional env var:  PORT              (Render sets this automatically)

import express from "express";
import zlib from "node:zlib";
import { promisify } from "node:util";
import nbt from "prismarine-nbt";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const gunzip = promisify(zlib.gunzip);
const HYPIXEL_KEY = process.env.HYPIXEL_API_KEY;
if (!HYPIXEL_KEY) console.warn("WARNING: HYPIXEL_API_KEY is not set — Hypixel calls will fail.");

// ------------------------------------------------------------------ tables ---
// HotM cumulative XP -> tier. Increments per tier: 3k,9k,25k,60k,100k,150k,210k,280k,350k.
// Verify against the wiki if Hypixel ever rebalances HotM.
const HOTM_CUM = [0, 3000, 12000, 37000, 97000, 197000, 347000, 557000, 837000, 1187000];
function hotmTier(xp) {
  let t = 1;
  for (let i = 0; i < HOTM_CUM.length; i++) if (xp >= HOTM_CUM[i]) t = i + 1;
  return t;
}

// Skill cumulative XP -> level (mining cap 60).
const SKILL_CUM = [50,175,375,675,1175,1925,2925,4425,6425,9925,14925,22425,32425,47425,67425,97425,147425,222425,322425,522425,822425,1222425,1722425,2322425,3022425,3822425,4722425,5722425,6822425,8022425,9322425,10722425,12222425,13822425,15522425,17322425,19222425,21222425,23322425,25522425,27822425,30222425,32722425,35322425,38072425,40972425,44072425,47472425,51172425,55172425,59472425,64072425,68972425,74172425,79672425,85472425,91572425,97972425,104672425,111672425];
function skillLevel(xp) {
  let lvl = 0;
  for (const c of SKILL_CUM) { if (xp >= c) lvl++; else break; }
  return lvl;
}

// ------------------------------------------------------------- data fetching --
async function getUuid(username) {
  const r = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`);
  if (!r.ok) throw new Error(`Mojang lookup failed for "${username}" (HTTP ${r.status})`);
  const j = await r.json();
  if (!j.id) throw new Error(`No such player: "${username}"`);
  return j.id;
}

async function getProfiles(uuid) {
  const r = await fetch(`https://api.hypixel.net/v2/skyblock/profiles?uuid=${uuid}`, {
    headers: { "API-Key": HYPIXEL_KEY },
  });
  const j = await r.json();
  if (!j.success) throw new Error(`Hypixel API error: ${j.cause || "unknown"}`);
  return j.profiles || [];
}

// Resolve username -> { uuid, profile, member, profileName }
// `profileName` (optional) selects a specific profile by its cute_name (e.g. "Mango").
async function loadMember(username, profileName) {
  const uuid = await getUuid(username);
  const profiles = await getProfiles(uuid);
  if (!profiles.length) throw new Error(`No SkyBlock profiles found for "${username}"`);
  let profile;
  if (profileName) profile = profiles.find(p => p.cute_name?.toLowerCase() === profileName.toLowerCase());
  if (!profile) profile = profiles.find(p => p.selected) || profiles[0];
  const member = profile.members[uuid] || profile.members[uuid.replace(/-/g, "")];
  if (!member) throw new Error(`Member data missing for "${username}" on profile ${profile.cute_name}`);
  return { uuid, profile, member, profileName: profile.cute_name };
}

// ---------------------------------------------------------------- NBT decode --
async function decodeItems(b64) {
  if (!b64) return [];
  let buf = Buffer.from(b64, "base64");
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = await gunzip(buf); // gzip magic
  const { parsed } = await nbt.parse(buf);
  const list = parsed.value?.i?.value?.value || [];
  return list.map(it => {
    const tag = it.tag?.value;
    if (!tag) return null;
    const ea = tag.ExtraAttributes?.value;
    const id = ea?.id?.value;
    if (!id) return null;
    const name = (tag.display?.value?.Name?.value || "").replace(/§./g, "");
    const reforge = ea?.modifier?.value || null;
    const ench = ea?.enchantments?.value
      ? Object.fromEntries(Object.entries(ea.enchantments.value).map(([k, v]) => [k, v.value]))
      : {};
    const gems = ea?.gems?.value ? Object.keys(ea.gems.value) : [];
    return { id, name, reforge, enchantments: ench, gems };
  }).filter(Boolean);
}

const TOOL_RE = /(PICK|DRILL|GAUNTLET|GEMSTONE|PICKONIMBUS|JUNGLE_AXE|TREECAPITATOR)/;

// ----------------------------------------------------------- analysis object --
async function buildMining(username, profileName) {
  const { member, profileName: pname } = await loadMember(username, profileName);
  const inv = member.inventory || {};
  const mc = member.mining_core || {};

  const miningXp = member.player_data?.experience?.SKILL_MINING ?? 0;
  const hotmXp = mc.experience; // may be undefined — this is the gap the JSON export hit

  const armor = inv.inv_armor ? await decodeItems(inv.inv_armor.data) : [];
  const equipment = inv.equipment_contents ? await decodeItems(inv.equipment_contents.data) : [];
  let tools = [];
  for (const key of ["inv_contents", "ender_chest_contents"]) {
    if (inv[key]) {
      const items = await decodeItems(inv[key].data);
      tools.push(...items.filter(i => TOOL_RE.test(i.id)).map(i => ({ ...i, location: key })));
    }
  }

  const pets = (member.pets_data?.pets || []).map(p => ({
    type: p.type, tier: p.tier, active: !!p.active, heldItem: p.heldItem || null, exp: Math.floor(p.exp || 0),
  }));

  return {
    profile: pname,
    mining: { level: skillLevel(miningXp), xp: Math.round(miningXp) },
    hotm: hotmXp === undefined
      ? { tier: null, note: "HotM experience not present in this API response — node/tier data unavailable." }
      : { tier: hotmTier(hotmXp), xp: Math.round(hotmXp) },
    powder: {
      mithril_available: mc.powder_mithril ?? 0,
      mithril_total: mc.powder_mithril_total ?? null,
      mithril_spent: mc.powder_spent_mithril ?? 0,
      gemstone_available: mc.powder_gemstone ?? 0,
      gemstone_total: mc.powder_gemstone_total ?? null,
      gemstone_spent: mc.powder_spent_gemstone ?? 0,
      glacite_available: mc.powder_glacite ?? 0,
    },
    armor, equipment, tools, pets,
  };
}

const text = obj => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const err = e => ({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });

// --------------------------------------------------------------- MCP wiring ---
function makeServer() {
  const server = new McpServer({ name: "skyblock-mining-coach", version: "1.0.0" });

  server.tool(
    "analyze_mining",
    "Full mining readout for a Hypixel SkyBlock player: mining level, HotM tier, powder, decoded armor/equipment/pickaxes, and pets.",
    { username: z.string().describe("Minecraft username"), profile: z.string().optional().describe("Profile cute_name, e.g. 'Mango'. Defaults to the selected profile.") },
    async ({ username, profile }) => { try { return text(await buildMining(username, profile)); } catch (e) { return err(e); } }
  );

  server.tool(
    "get_gear",
    "Decode and return a player's worn armor, equipment, and any pickaxes/drills/gauntlets (with reforges, enchantments, and gemstones).",
    { username: z.string(), profile: z.string().optional() },
    async ({ username, profile }) => {
      try { const d = await buildMining(username, profile); return text({ profile: d.profile, armor: d.armor, equipment: d.equipment, tools: d.tools }); }
      catch (e) { return err(e); }
    }
  );

  server.tool(
    "get_hotm",
    "Return Heart of the Mountain tier/XP and powder totals for a player.",
    { username: z.string(), profile: z.string().optional() },
    async ({ username, profile }) => {
      try { const d = await buildMining(username, profile); return text({ profile: d.profile, hotm: d.hotm, powder: d.powder }); }
      catch (e) { return err(e); }
    }
  );

  server.tool(
    "list_profiles",
    "List a player's SkyBlock profiles (names) and which is currently selected.",
    { username: z.string() },
    async ({ username }) => {
      try {
        const uuid = await getUuid(username);
        const profiles = await getProfiles(uuid);
        return text(profiles.map(p => ({ name: p.cute_name, selected: !!p.selected })));
      } catch (e) { return err(e); }
    }
  );

  return server;
}

// ---------------------------------------------------- HTTP (Streamable) layer --
const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/", (_req, res) => res.send("SkyBlock Mining Coach MCP server is running. POST /mcp"));

app.post("/mcp", async (req, res) => {
  // Stateless: a fresh server+transport per request (simplest for a public connector).
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: e.message }, id: null });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SkyBlock Mining Coach MCP listening on :${PORT}`));
