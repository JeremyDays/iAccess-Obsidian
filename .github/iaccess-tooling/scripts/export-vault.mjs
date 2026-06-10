import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vaultArg = process.argv[2];
const vaultDir = vaultArg ? path.resolve(vaultArg) : null;
const outDir = path.join(rootDir, "public");
const formspreeEndpoint = "https://formspree.io/f/xgobklaa";
const excludedTopLevelDirs = new Set([".obsidian", ".trash", "z_obsidian", "z_templates", "z_old"]);
const excludedFolderNames = new Set(["gutachter"]);
const excludedNoteNames = new Set([
  "bors-praktikum.md",
  "tasks.md",
  "task overview cb.md",
  "task overview sh.md",
  "bauwiki.md",
  "qgiswiki.md",
  "iac central greenkeeping list.md",
  "iac central design and material list.md",
  "zützen-berkholz-meyenburg (c).md"
]);
const categoryOrder = ["overview", "project", "expert", "note"];
const assetVersion = Date.now().toString(36);
const assetExtensions = new Set([
  ".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".mp3", ".mp4", ".ogg", ".pdf", ".png", ".svg", ".wav", ".webm", ".webp"
]);

if (!vaultDir) {
  console.error('Usage: npm run export -- "C:\\Path\\To\\ObsidianVault"');
  process.exit(1);
}

await assertDirectory(vaultDir);
await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(path.join(outDir, "notes"), { recursive: true });
await fs.mkdir(path.join(outDir, "api", "notes"), { recursive: true });
await fs.mkdir(path.join(outDir, "assets"), { recursive: true });
await fs.mkdir(path.join(outDir, "assets", "vault"), { recursive: true });

const vaultFiles = await walk(vaultDir);
const markdownFiles = vaultFiles
  .filter((file) => file.toLowerCase().endsWith(".md"))
  .filter((file) => shouldExportFile(file, vaultDir));
const assetFiles = vaultFiles
  .filter((file) => assetExtensions.has(path.extname(file).toLowerCase()))
  .filter((file) => shouldExportFile(file, vaultDir));

const rawNotes = await Promise.all(markdownFiles.map((file) => readNote(file, vaultDir)));
rawNotes.push(projectMapsNote());
const slugByTitle = buildSlugLookup(rawNotes);
const notes = rawNotes.map((note) => enrichNote(note, slugByTitle));
const notesByTitle = new Map(notes.map((note) => [normalizeTitle(note.title), note]));
const assetsByName = await copyVaultAssets(assetFiles, vaultDir);

await writeObsidianCss();
await writeStaticAssets();
await fs.writeFile(path.join(outDir, ".nojekyll"), "\n");
await copyProjectAssets();
await writeDashboard(notes, notesByTitle, assetsByName);
await Promise.all(notes.map((note) => writeNotePage(note, notes, notesByTitle, assetsByName)));
await writeApi(notes, notesByTitle);

console.log(`Exported ${notes.length} notes to ${outDir}`);

async function assertDirectory(dir) {
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Vault directory not found: ${dir}`);
  }
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    if (entry.isFile()) return [fullPath];
    return [];
  }));
  return nested.flat();
}

function hasPathPart(file, part) {
  return file.split(path.sep).includes(part);
}

function shouldExportFile(file, vaultDir) {
  if (hasPathPart(file, ".obsidian") || hasPathPart(file, ".trash")) return false;
  const relativeParts = path.relative(vaultDir, file).split(path.sep);
  const [topLevel] = relativeParts;
  if (excludedTopLevelDirs.has(topLevel)) return false;
  if (relativeParts.some((part) => excludedFolderNames.has(part.toLowerCase()))) return false;
  if (file.toLowerCase().endsWith(".md") && excludedNoteNames.has(path.basename(file).toLowerCase())) return false;
  if (isRulebookAsset(file, vaultDir)) return false;
  return true;
}

function projectMapsNote() {
  return {
    title: "Projektkarten",
    slug: "projektkarten",
    category: "overview",
    relativePath: "0 - Übersicht/Projektkarten.md",
    frontmatter: {},
    tags: [],
    links: [],
    body: "",
    excerpt: "Detaillierte Karten der Projekte in Deutschland, Frankreich und Japan."
  };
}

function isRulebookAsset(file, vaultDir) {
  const relativePath = path.relative(vaultDir, file).replaceAll("\\", "/").toLowerCase();
  if (!relativePath.startsWith("6 - regeln/")) return false;
  const basename = path.basename(relativePath);
  return basename.includes("regelwerk");
}

async function readNote(file, vaultDir) {
  const source = repairMojibake(await fs.readFile(file, "utf8"));
  const relativePath = path.relative(vaultDir, file).replaceAll("\\", "/");
  const parsed = parseFrontmatter(source);
  const title = String(parsed.frontmatter.title || path.basename(file, ".md"));
  const tags = extractTags(parsed.body, parsed.frontmatter);
  const links = extractWikiLinks(parsed.body);
  const category = inferCategory(relativePath, tags, parsed.frontmatter);

  return {
    title,
    slug: slugify(title),
    category,
    relativePath,
    frontmatter: parsed.frontmatter,
    tags,
    links,
    body: parsed.body,
    excerpt: makeExcerpt(parsed.body)
  };
}

function parseFrontmatter(source) {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
    return { frontmatter: {}, body: source };
  }

  const end = source.search(/\r?\n---\r?\n/);
  if (end === -1) return { frontmatter: {}, body: source };

  const raw = source.slice(4, end).trim();
  const body = source.slice(end).replace(/^\r?\n---\r?\n/, "");
  return { frontmatter: parseSimpleYaml(raw), body };
}

function parseSimpleYaml(raw) {
  const result = {};
  let currentKey = null;
  let blockKey = null;
  let blockIndent = 0;
  let blockLines = [];

  const flushBlock = () => {
    if (!blockKey) return;
    result[blockKey] = blockLines.join("\n").trimEnd();
    blockKey = null;
    blockLines = [];
  };

  for (const line of raw.split(/\r?\n/)) {
    if (blockKey) {
      const indent = line.match(/^\s*/)?.[0].length || 0;
      if (!line.trim() || indent >= blockIndent) {
        blockLines.push(line.slice(Math.min(blockIndent, line.length)));
        continue;
      }
      flushBlock();
    }

    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem && currentKey) {
      result[currentKey] = Array.isArray(result[currentKey]) ? result[currentKey] : [];
      result[currentKey].push(cleanYamlValue(listItem[1]));
      continue;
    }

    const pair = line.match(/^([^:#][^:]*):\s*(.*)$/);
    if (!pair) continue;
    currentKey = pair[1].trim();
    if (/^[|>]-?$/.test(pair[2].trim())) {
      blockKey = currentKey;
      blockIndent = 2;
      blockLines = [];
      continue;
    }
    result[currentKey] = parseYamlValue(pair[2]);
  }

  flushBlock();
  return result;
}

function parseYamlValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map(cleanYamlValue).filter(Boolean);
  }
  return cleanYamlValue(trimmed);
}

function cleanYamlValue(value) {
  return value.trim().replace(/^["']|["']$/g, "");
}

function repairMojibake(value) {
  if (!/[ÃÂâ][\s\S]?/.test(value)) return value;

  const bytes = [];
  for (const char of value) {
    const code = char.codePointAt(0);
    bytes.push(windows1252Byte(code));
  }

  const repaired = Buffer.from(bytes).toString("utf8");
  const originalScore = mojibakeScore(value);
  const repairedScore = mojibakeScore(repaired);
  return repairedScore < originalScore ? repaired : value;
}

function windows1252Byte(code) {
  const map = new Map([
    [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
    [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
    [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
    [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
    [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
    [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
    [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f]
  ]);
  return map.get(code) ?? (code <= 0xff ? code : 0x3f);
}

function mojibakeScore(value) {
  return (value.match(/[ÃÂ�]|â[€œ„“”™€]|ð/g) || []).length;
}

function extractTags(body, frontmatter) {
  const values = new Set();
  const frontmatterTags = frontmatter.tags || frontmatter.tag || [];
  for (const tag of Array.isArray(frontmatterTags) ? frontmatterTags : [frontmatterTags]) {
    if (tag) values.add(String(tag).replace(/^#/, ""));
  }
  for (const match of body.matchAll(/(^|\s)#([\p{L}\p{N}/_-]+)/gu)) {
    values.add(match[2]);
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

function extractWikiLinks(body) {
  const links = [];
  for (const match of body.matchAll(/(?<!!)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g)) {
    const target = match[1].trim();
    links.push({ target, label: (match[2] || target).trim() });
  }
  return dedupeBy(links, (link) => `${normalizeTitle(link.target)}|${link.label}`);
}

function inferCategory(relativePath, tags, frontmatter) {
  const explicit = frontmatter.type || frontmatter.category || frontmatter.kategorie;
  if (explicit) return normalizeCategory(explicit);

  const segments = relativePath.replaceAll("\\", "/").toLowerCase().split("/");
  if (segments[0] === "projekte") return "project";
  if (segments[0] === "0 - übersicht") return "overview";
  if (segments[0] === "gutachter") return "expert";
  if (segments[0] === "ashurrpg") return "rules";

  const numberedFolder = segments.find((segment) => /^\d+\s*-/.test(segment));
  if (numberedFolder) {
    if (/^0\s*-\s*fraktionen$/.test(numberedFolder)) return "faction";
    if (/^1\s*-\s*scs$/.test(numberedFolder)) return "sc";
    if (/^2\s*-\s*nscs$/.test(numberedFolder)) return "npc";
    if (/^3\s*-\s*orte$/.test(numberedFolder)) return "location";
    if (/^4\s*-\s*gegenst(a|ä)nde$/.test(numberedFolder)) return "item";
    if (/^5\s*-\s*welt$/.test(numberedFolder)) return "lore";
    if (/^6\s*-\s*regeln$/.test(numberedFolder)) return "rules";
    if (/^7\s*-\s*protokoll$/.test(numberedFolder)) return "session";
    if (/^8\s*-\s*kreaturen$/.test(numberedFolder)) return "creature";
  }

  const haystack = `${relativePath} ${tags.join(" ")}`.toLowerCase();
  const rules = [
    ["faction", ["0 - fraktionen", "fraktion", "faction", "organisation", "gilde"]],
    ["sc", ["spielercharakter", "player character", "sc"]],
    ["npc", ["2 - nscs", "nsc", "npc"]],
    ["location", ["3 - orte", "ort", "orte", "location", "stadt", "region", "dungeon"]],
    ["item", ["4 - gegenstände", "4 - gegenstaende", "gegenstand", "gegenstände", "gegenstaende", "artefakt", "loot"]],
    ["lore", ["5 - welt", "welt", "lore", "geschichte", "religion", "mythos", "glaube"]],
    ["rules", ["6 - regeln", "regel", "regeln", "rules", "regelwerk"]],
    ["session", ["7 - protokoll", "session", "sitzung", "protokoll", "log", "kalender"]],
    ["creature", ["8 - kreaturen", "kreatur", "kreaturen", "monster"]]
  ];

  return rules.find(([, words]) => words.some((word) => haystack.includes(word)))?.[0] || "note";
}

function normalizeCategory(value) {
  const category = String(value).trim().toLowerCase();
  if (["sc", "scs", "spielercharakter", "spielercharaktere", "pc", "pcs", "character", "charakter"].includes(category)) return "sc";
  if (["nsc", "nscs", "npc", "npcs"].includes(category)) return "npc";
  if (["fraktion", "fraktionen", "faction"].includes(category)) return "faction";
  if (["ort", "orte", "location"].includes(category)) return "location";
  if (["gegenstand", "gegenstände", "gegenstaende", "item"].includes(category)) return "item";
  if (["regel", "regeln", "rules", "rule"].includes(category)) return "rules";
  if (["protokoll", "session", "sessions"].includes(category)) return "session";
  if (["kreatur", "kreaturen", "creature"].includes(category)) return "creature";
  return category;
}

function buildSlugLookup(notes) {
  const used = new Map();
  const lookup = new Map();

  for (const note of notes) {
    const base = note.slug || "note";
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    const slug = count ? `${base}-${count + 1}` : base;
    note.slug = slug;
    lookup.set(normalizeTitle(note.title), slug);
    lookup.set(normalizeTitle(path.basename(note.relativePath, ".md")), slug);
    const relativeTarget = note.relativePath.replace(/\.md$/i, "");
    lookup.set(normalizeTitle(relativeTarget), slug);
    lookup.set(normalizeTitle(`Shared/${relativeTarget}`), slug);
  }

  return lookup;
}

function enrichNote(note, slugByTitle) {
  return {
    ...note,
    links: note.links.map((link) => ({
      ...link,
      slug: slugByTitle.get(normalizeTitle(link.target)) || null
    })),
    url: `notes/${note.slug}.html`,
    apiUrl: `api/notes/${note.slug}.json`
  };
}

async function writeDashboard(notes, notesByTitle, assetsByName) {
  const defaultNote = notesByTitle.get(normalizeTitle("Projektphasen"));
  if (!defaultNote) throw new Error("Default note Projektphasen not found.");
  const html = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0; url=${defaultNote.url}">
  <title>Obsidian Database</title>
  <link rel="canonical" href="${defaultNote.url}">
</head>
<body>
  <p><a href="${defaultNote.url}">Projektphasen öffnen</a></p>
</body>
</html>`;
  await fs.writeFile(path.join(outDir, "index.html"), html);
}

function computeDashboardStats(notes) {
  const allProjects = notes.filter(isDashboardProject);
  const activeProjects = notes.filter((note) => projectGroup(note) && !isUnbuiltOperatingProject(note));
  const byGroup = groupBy(activeProjects, projectGroup);
  const built = byGroup.get("built") || [];
  const notBuilt = activeProjects.filter((note) => projectGroup(note) !== "built");
  return [
    { label: "Projekte gesamt", value: allProjects.length },
    { label: "In Akquise", value: (byGroup.get("acquisition") || []).length },
    { label: "In Entwicklung", value: (byGroup.get("development") || []).length },
    { label: "In Bau", value: (byGroup.get("construction") || []).length },
    { label: "Errichtet", value: built.length },
    { label: "Leistung errichtet", value: `${formatMwp(sumPower(built))} MWp` },
    { label: "Pipeline", value: `${formatMwp(sumPower(notBuilt))} MWp` }
  ];
}

function isDashboardProject(note) {
  if (note.category !== "project") return false;
  const relativePath = note.relativePath.replaceAll("\\", "/");
  return relativePath.startsWith("Projekte/")
    && !/^Projekte\/z_Ergänzendes(?:\/|$)/i.test(relativePath);
}

function isUnbuiltOperatingProject(note) {
  return projectGroup(note) === "built"
    && /nicht gebaut/i.test(String(note.frontmatter.Projektstatus || note.frontmatter.projektstatus || ""));
}

function projectGroup(note) {
  const relativePath = note.relativePath.replaceAll("\\", "/");
  if (!relativePath.startsWith("Projekte/")) return null;
  const topFolder = relativePath.split("/")[1] || "";
  if (/^A0\s*-\s*In Betrieb$/i.test(topFolder)) return "built";
  if (/^A[12]\s*-/i.test(topFolder)) return "construction";
  if (/^[BCD](?:\d)?\s*-/i.test(topFolder)) return "development";
  if (/^[EF]\s*-/i.test(topFolder)) return "acquisition";
  return null;
}

function sumPower(notes) {
  return notes.reduce((sum, note) => sum + projectPowerMwp(note), 0);
}

function projectPowerMwp(note) {
  const direct = parsePowerMwp(note.frontmatter.Leistung || note.frontmatter.leistung);
  if (direct > 0) return direct;

  // Historical operating projects have no Leistung field. Their archived image
  // names in Shared/Bilder carry the documented plant capacities.
  const historicalOperatingPower = {
    "akune": 2.6,
    "estézargues": 12,
    "guitinières": 1.5,
    "isahaya north": 1.1,
    "isahaya south": 3,
    "kawasaki": 56,
    "minami izu": 0.6,
    "okayama": 1.7,
    "sanbonmatsu": 2.4,
    "tochigi": 2.6,
    "uwaba north": 3.1,
    "uwaba south": 3,
    "yamagata": 58,
    "yamanashi": 2.2,
    "yamashita north": 2.6,
    "yamashita south": 2.7
  };
  return projectGroup(note) === "built"
    ? historicalOperatingPower[normalizeTitle(note.title).replaceAll("-", " ")] || 0
    : 0;
}

function parsePowerMwp(value) {
  const matches = [...String(value || "").matchAll(/([\d.,]+)\s*(kWp|MWp)/gi)];
  if (!matches.length) return 0;
  const [, raw, unit] = matches.at(-1);
  let normalized = raw;
  if (raw.includes(",") && raw.includes(".")) {
    normalized = raw.replaceAll(".", "").replace(",", ".");
  } else if (raw.includes(",")) {
    normalized = raw.replace(",", ".");
  } else if (raw.includes(".") && unit.toLowerCase() === "kwp" && /\.\d{3}$/.test(raw)) {
    normalized = raw.replaceAll(".", "");
  }
  const number = Number(normalized);
  if (!Number.isFinite(number)) return 0;
  return unit.toLowerCase() === "kwp" ? number / 1000 : number;
}

function formatMwp(value) {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(value);
}

function buildActivityGroups(notes, notesByTitle, assetsByName) {
  const notesBySlug = new Map(notes.map((note) => [note.slug, note]));
  const latestSessions = notes
    .filter((note) => isSessionProtocol(note))
    .slice()
    .sort((a, b) => compareSessionsByNumber(b, a));

  return [
    { title: "Letzte Sessions", notes: latestSessions.slice(0, 3) },
    { title: "Letzte NSCs", notes: recentLinkedNotes(latestSessions, notesByTitle, notesBySlug, "npc", 3) },
    { title: "Letzte Orte", notes: recentLinkedNotes(latestSessions, notesByTitle, notesBySlug, "location", 3) },
    { title: "Letzte Gegenstände", notes: recentLinkedNotes(latestSessions, notesByTitle, notesBySlug, "item", 3) }
  ].map((group) => ({
    ...group,
    cards: group.notes.map((note) => activityCardData(note, assetsByName, notesByTitle))
  }));
}

function recentLinkedNotes(sessions, notesByTitle, notesBySlug, category, limit) {
  const found = [];
  const seen = new Set();

  for (const session of sessions) {
    for (const link of session.links) {
      const note = link.slug
        ? notesBySlug.get(link.slug)
        : notesByTitle.get(normalizeTitle(link.target));
      if (!note || note.category !== category || seen.has(note.slug)) continue;
      seen.add(note.slug);
      found.push(note);
      if (found.length === limit) return found;
    }
  }

  const fallback = [...notesBySlug.values()]
    .filter((note) => note.category === category && !seen.has(note.slug))
    .sort(compareNotesByVaultOrder)
    .slice(-Math.max(0, limit - found.length))
    .reverse();

  return [...found, ...fallback].slice(0, limit);
}

function activityCardData(note, assetsByName, notesByTitle) {
  const summary = makeActivitySummary(note, notesByTitle);
  return {
    note,
    summary: markContinuedSummary(summary, note),
    image: firstNoteImage(note, assetsByName)
  };
}

function markContinuedSummary(summary, note) {
  if (!summary || summary.endsWith("...")) return summary;
  const fullText = markdownToPlainText(note.body);
  const summaryText = markdownToPlainText(summary);
  if (fullText.length <= summaryText.length + 40) return summary;
  return `${summary.replace(/[.!?;:\s]+$/, "")}...`;
}

function firstNoteImage(note, assetsByName) {
  const embed = note.body.match(/!\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/);
  if (embed) {
    const asset = resolveAsset(embed[1], assetsByName);
    if (asset) return { src: asset.publicPath, alt: path.basename(embed[1]) };
  }

  const markdownImage = note.body.match(/!\[([^\]]*)\]\(([^)]+)\)/);
  return markdownImage ? { src: markdownImage[2], alt: markdownImage[1] || note.title } : null;
}

function isSessionProtocol(note) {
  return note.relativePath.includes("7 - Protokoll/Session Protokolle/");
}

function parseSessionExperience(body) {
  const match = body.match(/\*\*Erfahrungspunkte:\*\*\s*([^\n]+)/i);
  if (!match) return [];
  return [...match[1].matchAll(/\]\]\s*(\d+)|\b[A-Za-zÄÖÜäöüß]+\b\s*(\d+)/g)]
    .map((item) => Number(item[1] || item[2]))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function formatExperienceRange(values) {
  const unique = [...new Set(values)].sort((a, b) => a - b);
  if (!unique.length) return "";
  const min = unique[0];
  const max = unique[unique.length - 1];
  return min === max ? String(min) : `${min}-${max}`;
}

function parseSessionIngameDates(body) {
  const dates = [];
  for (const match of body.matchAll(/\[(?:ingame|Nächster Tag|Naechster Tag)::\s*(?:\[\[)?([^\]\n]+?)(?:\]\])?\s*\]/gi)) {
    const parsed = parseIsoIngameDate(match[1]);
    if (parsed) dates.push(parsed);
  }
  return dedupeBy(dates, (date) => date.key);
}

function parseSessionOutgameDate(body) {
  const match = body.match(/\[outgame::\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\]/i);
  if (!match) return null;
  const date = {
    day: Number(match[1]),
    month: Number(match[2]),
    year: Number(match[3])
  };
  return { ...date, key: `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}` };
}

function parseIsoIngameDate(value) {
  const match = String(value).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
  return { ...date, key: `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}` };
}

function formatSessionDates(note) {
  const outgame = parseSessionOutgameDate(note.body);
  const ingame = parseSessionIngameDates(note.body);
  const parts = [];
  if (outgame) parts.push(`Outgame: ${formatCalendarDate(outgame)}`);
  if (ingame.length) parts.push(`Ingame: ${formatIngameDateRange(ingame)}`);
  return parts.join(" | ");
}

function formatCalendarDate(date) {
  return `${String(date.day).padStart(2, "0")}.${String(date.month).padStart(2, "0")}.${date.year}`;
}

function formatIngameDateRange(dates) {
  const sorted = dates.slice().sort((a, b) => a.key.localeCompare(b.key));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return first.key === last.key
    ? formatCalendarDate(first)
    : `${formatCalendarDate(first)}-${formatCalendarDate(last)}`;
}

function parseSessionDateTime(body) {
  const topMatter = body.split(/\r?\n/).slice(0, 20).join("\n");
  const match = topMatter.match(/\[\[(\d{1,2})\.\s+([A-Za-zÄÖÜäöüß]+)\s+(\d{3,4})\s+EB\]\]\s*,?\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return {
    day: Number(match[1]),
    month: match[2],
    year: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5])
  };
}

function compareSessionsByNumber(a, b) {
  return sessionNumber(a) - sessionNumber(b) || a.title.localeCompare(b.title, "de", { numeric: true });
}

function sessionNumber(note) {
  const match = note.title.match(/^S(\d+)/i) || note.relativePath.match(/\/S(\d+)\s*-/i);
  return match ? Number(match[1]) : 0;
}

function parseIngameDate(title) {
  const match = title.match(/^(\d{1,2})\.\s+([A-Za-zÄÖÜäöüß]+)\s+(\d{3,4})\s+EB$/);
  if (!match) return null;
  const date = {
    day: Number(match[1]),
    month: match[2],
    year: Number(match[3]),
    hour: 0,
    minute: 0
  };
  return { ...date, key: `${date.year}-${monthIndex(date.month)}-${date.day}` };
}

function compareIngameDateTime(a, b) {
  return a.year - b.year
    || monthIndex(a.month) - monthIndex(b.month)
    || a.day - b.day
    || a.hour - b.hour
    || a.minute - b.minute;
}

function monthIndex(month) {
  const months = ["Yanevar", "Fivral", "Mart", "April", "May", "Eyune", "Eyule", "Avgust", "Sintyavr", "Oktavr", "Noyavr", "Dekavr"];
  const index = months.findIndex((item) => item.toLowerCase() === month.toLowerCase());
  return index === -1 ? 99 : index;
}

function formatIngameDateTime(date) {
  return `${date.day}. ${date.month} ${date.year} EB ${String(date.hour).padStart(2, "0")}:${String(date.minute).padStart(2, "0")}`;
}

function buildCategoryTrees(notes, assetsByName = new Map()) {
  const root = createTreeNode("Shared");
  for (const note of notes.sort(compareNotesByVaultOrder)) {
    addNoteToTree(root, note.relativePath.split("/").slice(0, -1).map(cleanFolderLabel), note);
  }
  return [{ category: "note", root: sortTree(root) }];
}

function createTreeNode(name) {
  return { name, children: new Map(), notes: [], media: [], specialLast: new Set() };
}

function addNoteToTree(root, segments, note) {
  let node = root;
  for (const segment of segments) {
    if (!node.children.has(segment)) node.children.set(segment, createTreeNode(segment));
    node = node.children.get(segment);
  }
  node.notes.push(note);
}

function addMediaToTree(root, segments, media) {
  let node = root;
  for (const segment of segments) {
    if (!node.children.has(segment)) node.children.set(segment, createTreeNode(segment));
    node = node.children.get(segment);
  }
  node.media.push(media);
}

function mediaAssetsForTree(assetsByName) {
  const seen = new Set();
  return [...assetsByName.values()]
    .flat()
    .filter((asset) => asset.relativePath.includes("/7 - Protokoll/"))
    .filter((asset) => {
      const extension = path.extname(asset.relativePath).toLowerCase();
      return [".avif", ".gif", ".jpeg", ".jpg", ".mp4", ".pdf", ".png", ".webm", ".webp"].includes(extension);
    })
    .filter((asset) => {
      if (seen.has(asset.relativePath)) return false;
      seen.add(asset.relativePath);
      return true;
    })
    .map((asset) => ({
      ...asset,
      title: path.basename(asset.relativePath),
      segments: treeSegmentsForAsset(asset)
    }));
}

function treeSegmentsForAsset(asset) {
  const parts = asset.relativePath.split("/");
  const categoryIndex = parts.findIndex((part) => part === "7 - Protokoll");
  const folderSegments = categoryIndex === -1 ? parts.slice(0, -1) : parts.slice(categoryIndex + 1, -1);
  return folderSegments.map(cleanFolderLabel);
}

function treeSegmentsForNote(note) {
  const parts = note.relativePath.split("/");
  const fileName = parts.at(-1);
  if (note.category === "rules" && note.relativePath.startsWith("AshurRPG/")) {
    return ["AshurRPG", ...parts.slice(1, -1).map(cleanFolderLabel)];
  }

  const categoryIndex = parts.findIndex((part) => /^\d+\s*-/.test(part));
  const folderSegments = categoryIndex === -1 ? parts.slice(0, -1) : parts.slice(categoryIndex + 1, -1);

  return folderSegments.map(cleanFolderLabel);
}

function cleanFolderLabel(value) {
  return String(value)
    .replace(/^\d+\s*[-_]\s*/, "")
    .replaceAll("_", " ")
    .trim();
}

function sortTree(node) {
  const children = [...node.children.entries()].sort(([a], [b]) => {
    const aSpecial = isSpecialLastFolder(a);
    const bSpecial = isSpecialLastFolder(b);
    if (aSpecial !== bSpecial) return aSpecial ? 1 : -1;
    return a.localeCompare(b, "de", { numeric: true, sensitivity: "base" });
  });
  node.children = new Map(children.map(([name, child]) => [name, sortTree(child)]));
  node.notes.sort((a, b) => a.title.localeCompare(b.title, "de", { numeric: true, sensitivity: "base" }));
  node.media.sort((a, b) => a.title.localeCompare(b.title, "de", { numeric: true, sensitivity: "base" }));
  return node;
}

function isSpecialLastFolder(name) {
  return name === "AshurRPG";
}

function treeCount(node) {
  return node.notes.length + node.media.length + [...node.children.values()].reduce((sum, child) => sum + treeCount(child), 0);
}

function renderTreeRoot(entry, prefix = "") {
  const root = entry.root;
  return [
    ...root.children.values()].map((child) => renderTreeNode(child, false, prefix, child.name)
  ).concat(
    root.notes.map((note) => renderTreeNote(note, prefix)),
    root.media.map((media) => `<a class="tree-note tree-media" href="${prefix}${media.publicPath}" target="_blank" rel="noreferrer">${escapeHtml(media.title)}</a>`)
  ).join("");
}

function renderTreeNode(node, isRoot = false, prefix = "", treePath = node.name) {
  const count = treeCount(node);
  const children = [...node.children.values()];
  const regularChildren = children.filter((child) => !isSpecialLastFolder(child.name));
  const specialChildren = children.filter((child) => isSpecialLastFolder(child.name));
  const childHtml = [
    ...regularChildren.map((child) => renderTreeNode(child, false, prefix, `${treePath}/${child.name}`)),
    ...node.notes.map((note) => renderTreeNote(note, prefix)),
    ...node.media.map((media) => `<a class="tree-note tree-media" href="${prefix}${media.publicPath}" target="_blank" rel="noreferrer">${escapeHtml(media.title)}</a>`),
    ...specialChildren.map((child) => renderTreeNode(child, false, prefix, `${treePath}/${child.name}`))
  ].join("");

  return `<details class="tree-node${isRoot ? " tree-root" : ""}" data-tree-id="${escapeHtml(treePath)}">
    <summary><span>${escapeHtml(node.name)}</span><strong>${count}</strong></summary>
    <div class="tree-children">${childHtml}</div>
  </details>`;
}

function renderTreeNote(note, prefix) {
  return `<a class="tree-note" data-note-slug="${escapeHtml(note.slug)}" href="${prefix}${note.url}">${escapeHtml(note.title)}</a>`;
}

function orderedCategoryEntries(categories) {
  return [...categories.entries()].sort(([a], [b]) => {
    const aIndex = categoryOrder.indexOf(a);
    const bIndex = categoryOrder.indexOf(b);
    const safeA = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex;
    const safeB = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex;
    return safeA - safeB || labelCategory(a).localeCompare(labelCategory(b), "de", { numeric: true });
  });
}

function compareNotesByVaultOrder(a, b) {
  return a.relativePath.localeCompare(b.relativePath, "de", { numeric: true, sensitivity: "base" });
}

async function writeNotePage(note, notes, notesByTitle, assetsByName) {
  const categoryTrees = buildCategoryTrees(notes, assetsByName);
  const backlinks = notes
    .filter((candidate) => candidate.links.some((link) => link.slug === note.slug))
    .sort((a, b) => a.title.localeCompare(b.title));

  const html = pageShell({
    title: note.title,
    bodyClass: `note-page note-${note.slug}`,
    content: `
      ${siteHeader("../", computeDashboardStats([...notesByTitle.values()]))}
      <div class="site-layout">
        ${siteSidebar(categoryTrees, "../")}
        <div class="note-column">
      <nav class="top-nav"><a href="../index.html">Dashboard</a></nav>
      <article class="note-detail obsidian-note">
        <header>
          <p class="eyebrow">${labelCategory(note.category)}</p>
          <h1>${escapeHtml(note.title)}</h1>
        </header>
        <div class="content obsidian-rendered">
          ${note.category === "project" ? projectOverview(note) : ""}
          ${note.category === "project" ? automaticProjectGallery(note, assetsByName) : ""}
          ${note.slug === "projektphasen"
            ? projectPhasesBoard(note, notes)
            : note.slug === "projektkarten"
              ? projectMapsHtml([...notesByTitle.values()])
              : markdownToHtml(resolveDataviewFields(projectBody(note), note), notesByTitle, assetsByName, { note })}
        </div>
      </article>
      ${noteFeedbackForm(note)}
      <aside class="relation-panel">
        <section>
          <h2>Verweise</h2>
          ${note.links.length ? `<div class="relation-list">${note.links.map(relationLink).join("")}</div>` : `<p class="muted">Keine ausgehenden Links.</p>`}
        </section>
        <section>
          <h2>Backlinks</h2>
          ${backlinks.length ? `<div class="relation-list">${backlinks.map((item) => `<a href="${item.slug}.html">${escapeHtml(item.title)}</a>`).join("")}</div>` : `<p class="muted">Keine Backlinks.</p>`}
        </section>
      </aside>
        </div>
      </div>
    `
  });

  await fs.writeFile(path.join(outDir, "notes", `${note.slug}.html`), html);
}

function noteFeedbackForm(note) {
  return `<section class="note-feedback" aria-labelledby="note-feedback-title">
    <div class="note-feedback-heading">
      <div>
        <p class="eyebrow">Rückmeldung</p>
        <h2 id="note-feedback-title">Anmerkung zu dieser Notiz</h2>
      </div>
      <p>Die Anmerkung wird per E-Mail an hornick@iaccess.de geschickt. Die Notiz selbst wird nicht verändert.</p>
    </div>
    <form class="note-feedback-form" action="${formspreeEndpoint}" method="POST">
      <input type="hidden" name="Notiz" value="${escapeHtml(note.title)}">
      <input type="hidden" name="Pfad" value="${escapeHtml(note.relativePath)}">
      <input type="hidden" name="Notiz-Link" value="">
      <input type="hidden" name="Zeitpunkt" value="">
      <input type="hidden" name="_subject" value="Website-Anmerkung: ${escapeHtml(note.title)}">
      <label class="feedback-trap" aria-hidden="true">
        <span>Bitte leer lassen</span>
        <input name="_gotcha" type="text" tabindex="-1" autocomplete="off">
      </label>
      <label>
        <span>Name</span>
        <input name="Name" type="text" autocomplete="name" maxlength="120" required>
      </label>
      <label>
        <span>Anmerkung</span>
        <textarea name="Anmerkung" rows="5" maxlength="5000" required></textarea>
      </label>
      <div class="note-feedback-actions">
        <button type="submit">Anmerkung abschicken</button>
        <p class="note-feedback-status" role="status" aria-live="polite"></p>
      </div>
    </form>
  </section>`;
}

function siteHeader(prefix, dashboardStats = []) {
  return `<header class="site-header">
    <div class="header-brand">
      <a class="brand" href="${prefix}index.html"><img src="${prefix}assets/iaccess-logo.png" alt="iAccess"></a>
      <div class="brand-title"><strong>Obsidian Database</strong></div>
    </div>
    <section class="header-stats" aria-label="Dashboard">
      ${dashboardStats.map((item) => `<div><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></div>`).join("")}
    </section>
    <div class="search-shell header-search">
      <input id="site-search" type="search" placeholder="Titel oder Alias..." autocomplete="off" aria-label="Notizen durchsuchen">
      <div id="search-results" class="search-results"></div>
    </div>
  </header>`;
}

function siteSidebar(categoryTrees, prefix) {
  return `<aside class="site-sidebar">
    <div class="folder-panel">
      <h2>Ordner</h2>
      <div class="category-tree">${categoryTrees.map((entry) => renderTreeRoot(entry, prefix)).join("")}</div>
    </div>
  </aside>`;
}

function resolveDataviewFields(markdown, note) {
  return markdown.replace(/`=this\.([A-Za-z0-9_.-]+)`/g, (_, key) => {
    const fileValues = {
      "file.name": note.title,
      "file.folder": `Shared/${path.posix.dirname(note.relativePath)}`,
      "file.path": `Shared/${note.relativePath}`
    };
    const value = key in fileValues ? fileValues[key] : note.frontmatter[key];
    if (Array.isArray(value)) return value.join(", ");
    return value === undefined || value === null || value === "" ? "" : String(value);
  });
}

function projectBody(note) {
  if (note.category !== "project") return note.body;
  const start = note.body.search(/^####\s+Bilder\s*$/m);
  return start === -1 ? note.body : note.body.slice(start);
}

function automaticProjectGallery(note, assetsByName) {
  if (/```img-gallery/i.test(note.body)) return "";
  const folderPrefix = normalizeTitle(`Bilder/${note.title}/`).replaceAll("\\", "/");
  const images = [...assetsByName.values()].flat()
    .filter((asset) => normalizeTitle(asset.relativePath).replaceAll("\\", "/").startsWith(folderPrefix))
    .filter((asset) => /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(asset.relativePath))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, "de", { numeric: true }));
  if (!images.length) return "";
  return `<section class="automatic-project-images"><h2>Bilder</h2><div class="image-gallery image-gallery-horizontal">
    ${images.map((asset) => `<figure><img src="../${asset.publicPath}" alt="${escapeHtml(path.basename(asset.relativePath))}" loading="lazy"><figcaption>${escapeHtml(path.basename(asset.relativePath))}</figcaption></figure>`).join("")}
  </div></section>`;
}

function projectPhasesBoard(note, notes) {
  const columns = [];
  let current = null;
  for (const sourceLine of note.body.replace(/\r\n/g, "\n").split("\n")) {
    const heading = sourceLine.match(/^##\s+(?:#{1,6}\s+)?(?:\*\*)?(.+?)(?:\*\*)?\s*$/);
    if (heading) {
      current = { title: heading[1].replace(/\*+/g, "").trim(), cards: [] };
      columns.push(current);
      continue;
    }
    if (!current) continue;
    const task = sourceLine.match(/^\s*-\s+\[[ xX-]\]\s+(.+)$/);
    if (!task) continue;
    const raw = task[1].trim();
    const link = raw.match(/^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]$/);
    if (link) {
      const target = resolveProjectPhaseTarget(link[1], notes);
      current.cards.push({ title: link[2] || link[1], note: target || null, heading: false });
    } else {
      current.cards.push({ title: raw.replace(/^\*\*|\*\*$/g, ""), note: null, heading: true });
    }
  }

  return `<section class="kanban-board" aria-label="Projektphasen">
    ${columns.map((column) => `<section class="kanban-column">
      <header><h2>${escapeHtml(column.title)}</h2><span>${column.cards.filter((card) => !card.heading).length}</span></header>
      <div class="kanban-cards">
        ${column.cards.map((card) => card.note
          ? `<a class="kanban-card wiki-link project-preview-link" data-preview-url="${card.note.slug}.html" href="${card.note.slug}.html">${escapeHtml(card.title)}</a>`
          : `<div class="kanban-card is-heading">${escapeHtml(card.title)}</div>`).join("")}
      </div>
    </section>`).join("")}
  </section>`;
}

function resolveProjectPhaseTarget(target, notes) {
  const normalizedTarget = normalizeTitle(String(target)
    .replaceAll("\\", "/")
    .replace(/^Shared\//i, "")
    .replace(/\.md$/i, ""));

  const pathMatch = notes.find((note) =>
    normalizeTitle(note.relativePath.replace(/\.md$/i, "")) === normalizedTarget
  );
  if (pathMatch) return pathMatch;

  const basename = normalizeTitle(path.posix.basename(normalizedTarget));
  return notes.find((note) =>
    normalizeTitle(note.title) === normalizedTarget
    || normalizeTitle(note.title) === basename
    || normalizeTitle(path.posix.basename(note.relativePath, ".md")) === basename
  ) || null;
}

function projectMapsHtml(notes) {
  const projects = notes.filter((note) => note.category === "project").map(projectMapRecord);
  const countries = [["DE", "Deutschland"], ["FR", "Frankreich"], ["JP", "Japan"]];
  return `<section class="project-maps">
    <p class="map-intro">Die Pins verwenden vorhandene GPS-Koordinaten. Fehlende Koordinaten werden anhand des Ortsnamens ermittelt und im Browser zwischengespeichert.</p>
    <div class="map-legend">
      <span class="map-status acquisition">In Akquise</span>
      <span class="map-status development">In Entwicklung</span>
      <span class="map-status construction">In Bau</span>
      <span class="map-status built">Errichtet</span>
      <span class="map-status other">Weitere</span>
    </div>
    ${countries.map(([code, label]) => `<section class="country-map-section">
      <h2>${label}</h2>
      <div class="project-map" data-country="${code}" aria-label="Projektkarte ${label}"></div>
      <p class="map-progress" data-map-progress="${code}"></p>
    </section>`).join("")}
    <script id="project-map-data" type="application/json">${safeJson(projects)}</script>
  </section>`;
}

function projectMapRecord(note) {
  const country = note.relativePath.includes("/JP/") ? "JP" : note.relativePath.includes("/FR/") ? "FR" : "DE";
  const frontmatter = note.frontmatter || {};
  const locationOverride = projectLocationOverride(note);
  return {
    title: note.title,
    url: `${note.slug}.html`,
    country,
    status: projectGroup(note) || "other",
    location: locationOverride?.location || valueText(frontmatter.Gemeinde || frontmatter.Gemarkung || frontmatter.Ort || cleanProjectPlace(note.title)),
    coordinates: locationOverride?.coordinates || projectCoordinates(note)
  };
}

function projectLocationOverride(note) {
  const overrides = {
    kawasaki: {
      location: "Kawasaki, Präfektur Miyagi",
      coordinates: [38.21582429, 140.63567186]
    }
  };
  return overrides[normalizeTitle(note.title)] || null;
}

function projectCoordinates(note) {
  const frontmatter = note.frontmatter || {};
  const direct = valueText(frontmatter.Koordinaten || frontmatter.Koordinate || frontmatter.GPS);
  const directMatch = direct.match(/(-?\d{1,3}(?:[.,]\d+)?)\s*[,;/]\s*(-?\d{1,3}(?:[.,]\d+)?)/);
  if (directMatch) return [Number(directMatch[1].replace(",", ".")), Number(directMatch[2].replace(",", "."))];
  const dvlp = valueText(frontmatter.DVLP || frontmatter["DVLP-Link"]);
  const lat = dvlp.match(/[?&]lat(?:itude)?=(-?\d+(?:\.\d+)?)/i);
  const lng = dvlp.match(/[?&](?:lng|lon|longitude)=(-?\d+(?:\.\d+)?)/i);
  return lat && lng ? [Number(lat[1]), Number(lng[1])] : null;
}

function cleanProjectPlace(title) {
  return String(title).replace(/\s+\([^)]*\)\s*$/, "").replace(/\s+\d+\s*$/, "").trim();
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function projectOverview(note) {
  const fm = note.frontmatter;
  const milestones = [
    ["Landsicherung", "Landsicherung"], ["Netzreservierung", "Netzreservierung"],
    ["Kommune", "Kommune"], ["Wirtschaftlichkeit", "Wirtschaftlichkeit"],
    ["Bezugsprojekt", "Bezugsprojekt"], ["Bauleitplanverfahren", "Bauleitplanverfahren"],
    ["Beschluss_Aufstellung", "Aufstellungsbeschluss"], ["Beschluss_Beteiligung", "Beteiligungsbeschluss"],
    ["Beschluss_Offenlage", "Offenlagebeschluss"], ["Beschluss_Satzung", "Satzungsbeschluss"],
    ["Beschluss_Feststellung", "Feststellungsbeschluss"], ["Bauantragsverfahren", "Baugenehmigungsverfahren"],
    ["Bauantrag", "Bauantrag"], ["Baugenehmigung", "Baugenehmigung"],
    ["Baufreigabe", "Baufreigabe"], ["Trassensicherung", "Trassensicherung"],
    ["Gebaut", "Gebaut"], ["Inbetriebnahme", "Inbetriebnahme"]
  ];
  const groups = [
    ["Projekt", [["Projektnummer", "ProjectNumber"], ["Im Lead", "Im_Lead"], ["Projekttyp", "Projekttyp"], ["Kooperationspartner", "Kooperationspartner"], ["Anlagentyp", "Anlagentyp"], ["Privilegierung", "Privilegierung"], ["Verfahren", "Verfahren"], ["Projektkosten", "Projektkosten"]]],
    ["Leistung", [["Leistung", "Leistung"], ["Specific Yield", "SpecificYield"], ["Yield Estimate", "YieldEstimate"], ["Technische Komponenten", "Technische_Komponenten"]]],
    ["Land", [["Koordinaten", "Koordinaten"], ["DVLP-Link", "DVLP"], ["Eigentümer", "Eigentümer"], ["Grundstücksfläche", "Grundstücksfläche"], ["Nutzbare Fläche", "NutzbareFläche"], ["Land", "Land"], ["Bundesland", "Bundesland"], ["Regionalverband", "Regionalverband"], ["Landkreis", "Landkreis"], ["Gemeinde", "Gemeinde"], ["Gemarkung", "Gemarkung"], ["Flur", "Flur"], ["Flurstücke", "Flurstücke"], ["PLZ", "PLZ"], ["Projektadresse", "Projektadresse"], ["Restriktionen", "Restriktionen"]]],
    ["Netz", [["Netzbetreiber", "Netzbetreiber"], ["Letzte Anfrage", "Anfragedatum"], ["Vorgangsnummern", "Vorgangsnummern"], ["Einspeisung (G)", "EinspeisungGesichert"], ["Bezug (G)", "BezugGesichert"], ["Netzverknüpfungspunkt", "NVP"], ["Distanz zum NVP", "Distanz"], ["Eigenes UW", "EigenesUW"], ["Netzausbau bis", "Netzausbau"], ["Reservierungsstufe", "Stufe"], ["Reserviert bis", "Reservierung"], ["Trassensicherung", "Trassensicherung"]]],
    ["Gutachten Phase 1", [["Stadtplanung", "Stadtplanung"], ["Vermessung", "Vermessung"], ["Leitungsauskunft Fläche", "Leitungsauskunft"], ["Leitungsauskunft Trasse", "Leitungsauskunft_Trasse"], ["Letztes Design", "Design"], ["Umweltschutz", "Umweltschutz"], ["Bodenschutz", "Bodenschutz"], ["Brandschutz", "Brandschutz"], ["Blendschutz", "Blendschutz"], ["Wasserschutz", "AwSV"], ["Landwirtschaftliches Nutzungskonzept", "lwnk"]]],
    ["Gutachten Phase 2", [["Umweltfachgutachten", "Fachgutachten"], ["Kartierung", "Kartierung"], ["Schallschutz", "Schallschutz"], ["Feuerwehrplan", "Feuerwehrplan"], ["Immissionsschutz", "Immissionsschutz"], ["Auszugstests", "Auszugstests"], ["Standsicherheitsnachweis", "Standsicherheitsnachweis"], ["UK beantragt", "UK_beantragt"], ["Statik", "Statik"], ["Prüfstatik", "Prüfstatik"], ["Projektkosten", "Projektkosten"]]],
    ["Bauleitplanung", [["Bauleitplanung", "Bauleitplanung_Notizen"]]],
    ["Baugenehmigung", [["Aktenzeichen", "BA_Aktenzeichen"], ["Mitarbeiter", "BA_Mitarbeiter"], ["ViBa-BW", "ViBa-BW"], ["Baugenehmigung", "Baugenehmigung_Notizen"]]],
    ["Milestones", [["Aufstellungsbeschluss", "MS0_Aufstellungsbeschluss"], ["Bebauungsplan", "MS0_Bebauungsplan"], ["Bauantrag", "MS1_Bauantrag"], ["Baugenehmigung", "MS2_Baugenehmigung"], ["Shipment Long Lead Items", "MS3_ShipmentLongLeadItems"], ["Baufreigabe", "MS4_RTB"], ["Baubeginn Civil Works", "MS5_ConstructionStartCivil"], ["Baubeginn EPC Works", "MS5_ConstructionStart"], ["Bauende", "MS6_ConstructionCompletion"], ["Baudauer", "Baudauer"], ["Inbetriebnahme", "MS7_CommercialOperation"]]],
    ["Zeitplan", [["Zeitplan", "Zeitplan"]]],
    ["Übergabe PM", [["Baufenster", "Baufenster"], ["Bauzeitenbeschränkung", "Bauzeitenbeschränkung"], ["Kleintierdurchlass", "Kleintierdurchlass"], ["Hecke", "Hecke"], ["Gras", "Gras"], ["BBB", "Bodenkundliche_Baubegleitung"], ["UBB", "Umweltbaubegleitung"], ["Auszugstests", "Auszugstests"], ["Standsicherheitsnachweis", "Standsicherheitsnachweis"], ["UK beantragt", "UK_beantragt"], ["Statik", "Statik"], ["Prüfstatik", "Prüfstatik"], ["Notizen", "Übergabe_Notizen"]]],
    ["Notizen", [["Notizen", "Notizen"]]]
  ];
  const dvlp = fm.DVLP ? `<a href="${escapeHtml(fm.DVLP)}" target="_blank" rel="noreferrer">app.dvlp.energy</a>` : "–";
  return `<section class="project-overview">
    <div class="project-summary-grid">
      <div class="project-status">
        ${projectTextBox("Projektstatus", fm.Projektstatus)}
        ${projectTextBox("Nächste Schritte", fm.NächsteSchritte)}
        <dl class="project-file-meta">
          <div><dt>File</dt><dd>${escapeHtml(note.title)}</dd></div>
          <div><dt>Folder</dt><dd>Shared/${escapeHtml(path.posix.dirname(note.relativePath))}</dd></div>
          <div><dt>Template</dt><dd>${escapeHtml(valueText(fm.Template) || "–")}</dd></div>
          <div><dt>DVLP-Link</dt><dd>${dvlp}</dd></div>
        </dl>
      </div>
      <div class="milestone-panel"><h2>Milestones</h2><div class="milestone-list">${milestones.map(([key, label]) => milestoneItem(label, fm[key])).join("")}</div></div>
    </div>
    <div class="project-groups">${groups.map(([title, rows]) => projectDetailGroup(title, rows, fm)).join("")}</div>
  </section>`;
}

function projectTextBox(title, value) {
  return `<section class="project-text-box"><h2>${escapeHtml(title)}</h2><div>${formatMultiline(valueText(value) || "–")}</div></section>`;
}

function milestoneItem(label, value) {
  const checked = metaBoolean(value);
  return `<div class="milestone-item ${checked ? "is-done" : ""}"><span aria-hidden="true">${checked ? "✓" : ""}</span>${escapeHtml(label)}</div>`;
}

function projectDetailGroup(title, rows, frontmatter) {
  const isSingleMultiline = rows.length === 1 && projectFieldType(rows[0][1]) === "textarea";
  const body = isSingleMultiline
    ? `<div class="project-single-field"><strong>${escapeHtml(rows[0][0])}</strong>${projectFieldValue(rows[0][1], frontmatter[rows[0][1]])}</div>`
    : `<div class="project-field-table">
        <div class="project-field-head"><strong>Kategorie</strong><strong>Inhalt</strong></div>
        ${rows.map(([label, key]) => `<div class="project-field-row"><strong>${escapeHtml(label)}</strong>${projectFieldValue(key, frontmatter[key])}</div>`).join("")}
      </div>`;
  return `<details class="project-group"><summary>${escapeHtml(title)}</summary>${body}</details>`;
}

function projectFieldValue(key, value) {
  const type = projectFieldType(key);
  const text = valueText(value);
  const placeholder = type === "date" ? "tt.mm.jjjj" : type === "select" ? "Auswahl" : "Text";
  const display = type === "date" && text ? formatGermanDate(text) : text;
  const classes = ["project-field-value", `is-${type}`];
  if (!display) classes.push("is-empty");
  const content = display ? formatProjectValue(display) : escapeHtml(placeholder);
  return `<div class="${classes.join(" ")}">${type === "date" ? `<span class="field-icon" aria-hidden="true">▣</span>` : ""}<span>${content}</span></div>`;
}

function projectFieldType(key) {
  const textareas = new Set([
    "Projektkosten", "Technische_Komponenten", "Restriktionen",
    "Bauleitplanung_Notizen", "Baugenehmigung_Notizen", "Zeitplan",
    "Übergabe_Notizen", "Notizen"
  ]);
  const selects = new Set(["Projekttyp", "Anlagentyp", "Privilegierung", "Verfahren"]);
  const dates = new Set(["Anfragedatum", "Reservierung", "Design"]);
  if (textareas.has(key)) return "textarea";
  if (selects.has(key)) return "select";
  if (dates.has(key) || /^MS\d+_/.test(key)) return "date";
  return "text";
}

function formatGermanDate(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function valueText(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function formatProjectValue(value) {
  const text = valueText(value);
  if (/^https?:\/\//i.test(text)) return `<a href="${escapeHtml(text)}" target="_blank" rel="noreferrer">${escapeHtml(text)}</a>`;
  return formatMultiline(text);
}

function formatMultiline(value) {
  return escapeHtml(value).replaceAll("\n", "<br>");
}

function metaBoolean(value) {
  return value === true || /^(true|yes|ja|1|\*)$/i.test(String(value || "").trim());
}

function noteMetaPanel(note, notesByTitle) {
  const aliases = normalizeMetaValues(note.frontmatter.aliases || note.frontmatter.alias || []);
  const folders = [labelCategory(note.category), ...treeSegmentsForNote(note)];
  const rows = [];
  if (aliases.length) rows.push({ label: "Alias", values: aliases });
  if (folders.length) rows.push({ label: "Ordner", values: folders, linkValues: false });
  if (note.category === "npc") {
    const factions = inferFactions(note, notesByTitle);
    const places = inferPlaces(note, notesByTitle);
    if (factions.length) rows.push({ label: "Fraktion", values: factions });
    if (places.length) rows.push({ label: "Aufenthalt", values: places });
  } else if (note.category === "item") {
    rows.push({ label: "Magisch", values: [inferMagicState(note)] });
  } else if (note.category === "location") {
    const places = inferContainingPlaces(note, notesByTitle);
    if (places.length) rows.push({ label: "Ort", values: places });
  }

  for (const [key, value] of Object.entries(note.frontmatter)) {
    if (["title", "aliases", "alias", "tags", "tag"].includes(key)) continue;
    const values = normalizeMetaValues(value);
    if (values.length) rows.push({ label: labelMetaKey(key), values });
  }

  if (!rows.length) return "";
  return `<aside class="note-meta" aria-label="Metadaten">${rows.map((row) => `
            <div class="note-meta-row">
              <span>${escapeHtml(row.label)}</span>
              <div>${row.values.map((value) => metaValueHtml(value, notesByTitle, row.linkValues !== false)).join("")}</div>
            </div>`).join("")}
          </aside>`;
}

function metaValueHtml(value, notesByTitle, linkValues = true) {
  const title = String(value).replace(/^\[\[|\]\]$/g, "");
  const note = linkValues ? notesByTitle.get(normalizeTitle(title)) : null;
  if (note) return `<a href="${note.slug}.html">${escapeHtml(note.title)}</a>`;
  return `<b>${escapeHtml(title)}</b>`;
}

function inferFactions(note, notesByTitle) {
  const factions = [];
  for (const link of note.links) {
    const linked = notesByTitle.get(normalizeTitle(link.target));
    if (linked?.category === "faction") factions.push(linked.title);
  }
  for (const candidate of notesByTitle.values()) {
    if (candidate.category !== "faction") continue;
    if (candidate.links.some((link) => link.slug === note.slug)) factions.push(candidate.title);
  }
  const rel = note.relativePath.split("/");
  const familyFolder = rel.find((part) => /^[A-ZÄÖÜ][\p{L} -]+$/u.test(part) && !/^\d+\s*-/.test(part) && !["Shared", "Vaesen", "NSCs"].includes(part));
  if (familyFolder && notesByTitle.has(normalizeTitle(`Familie ${familyFolder}`))) factions.push(`Familie ${familyFolder}`);
  for (const name of [...factions]) {
    const faction = notesByTitle.get(normalizeTitle(name));
    if (!faction) continue;
    for (const link of faction.links) {
      const parent = notesByTitle.get(normalizeTitle(link.target));
      const parentPattern = new RegExp(`Eine\\s+Form\\s+von\\s+\\[\\[${escapeRegExp(link.target)}(?:\\|[^\\]]+)?\\]\\]`, "i");
      if (parent?.category === "faction" && parentPattern.test(faction.body)) factions.push(parent.title);
    }
  }
  return dedupeValues(factions).filter((name) => name !== note.title).slice(0, 6);
}

function inferPlaces(note, notesByTitle) {
  const places = [];
  const rel = note.relativePath.split("/");
  for (const part of rel.slice(0, -1)) {
    const candidate = notesByTitle.get(normalizeTitle(part));
    if (candidate?.category === "location") places.push(candidate.title);
  }
  for (const link of note.links) {
    const linked = notesByTitle.get(normalizeTitle(link.target));
    if (linked?.category === "location") places.push(linked.title);
  }
  for (const candidate of notesByTitle.values()) {
    if (candidate.category !== "location") continue;
    if (!candidate.links.some((link) => link.slug === note.slug)) continue;
    const body = stripKiSummary(candidate.body);
    if (/(wohnt|lebt|in:|wohnort|hier wohnt|leiter|gegner|burgomeister|familie)/i.test(body)) places.push(candidate.title);
  }
  return dedupeValues(places).slice(0, 5);
}

function inferContainingPlaces(note, notesByTitle) {
  const places = [];
  const rel = note.relativePath.split("/");
  for (const part of rel.slice(0, -1)) {
    const candidate = notesByTitle.get(normalizeTitle(part));
    if (candidate?.category === "location" && candidate.slug !== note.slug) places.push(candidate.title);
  }
  const inMatches = [...note.body.matchAll(/\bIn:\s*\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/gi)];
  for (const match of inMatches) places.push(match[2] || match[1]);
  return dedupeValues(places).slice(0, 5);
}

function inferMagicState(note) {
  if (/\/Magische Gegenst(ä|Ã¤)nde\//i.test(note.relativePath)) return "Ja";
  if (/\bmagisch\b/i.test(note.body)) return "Ja";
  if (/nicht magisch|unmagisch/i.test(note.body)) return "Nein";
  return "Nicht bekannt";
}

function stripKiSummary(body) {
  return body.replace(/(^|\n)## KI-Zusammenfassung[\s\S]*$/m, "");
}

function dedupeValues(values) {
  const out = [];
  const seen = new Set();
  for (const value of values.map((item) => String(item).trim()).filter(Boolean)) {
    const key = normalizeTitle(value);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

function normalizeMetaValues(value) {
  const rawValues = Array.isArray(value) ? value : [value];
  return rawValues
    .flatMap((item) => typeof item === "string" && item.includes(",") && !item.includes("[[") ? item.split(",") : [item])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function labelMetaKey(key) {
  const labels = {
    category: "Kategorie",
    kategorie: "Kategorie",
    type: "Typ",
    status: "Status",
    date: "Datum",
    created: "Erstellt",
    updated: "Geändert",
  };
  return labels[key] || key.replaceAll("_", " ").replaceAll("-", " ");
}

async function writeApi(notes) {
  const publicNotes = notes.map(publicNote);
  const graph = {
    nodes: notes.map((note) => ({ id: note.slug, title: note.title, category: note.category, url: note.url })),
    edges: notes.flatMap((note) => note.links.filter((link) => link.slug).map((link) => ({
      source: note.slug,
      target: link.slug,
      label: link.label
    })))
  };

  await fs.writeFile(path.join(outDir, "api", "index.json"), JSON.stringify(publicNotes, null, 2));
  await fs.writeFile(path.join(outDir, "api", "graph.json"), JSON.stringify(graph, null, 2));

  await Promise.all(notes.map((note) => fs.writeFile(
    path.join(outDir, "api", "notes", `${note.slug}.json`),
    JSON.stringify(publicNote(note, true), null, 2)
  )));
}

function publicNote(note, includeBody = false) {
  return {
    title: note.title,
    slug: note.slug,
    category: note.category,
    relativePath: note.relativePath,
    url: note.url,
    apiUrl: note.apiUrl,
    excerpt: note.excerpt,
    frontmatter: note.frontmatter,
    links: note.links,
    ...(includeBody ? { markdown: note.body } : {})
  };
}

async function writeStaticAssets() {
  await fs.writeFile(path.join(outDir, "assets", "app.css"), css());
  await fs.writeFile(path.join(outDir, "assets", "app.js"), js());
}

async function copyProjectAssets() {
  const logoPath = path.join(rootDir, "assets", "iaccess-logo.png");
  const exists = await fs.stat(logoPath).then((stat) => stat.isFile()).catch(() => false);
  if (exists) {
    await fs.copyFile(logoPath, path.join(outDir, "assets", "iaccess-logo.png"));
  }
}

async function copyVaultAssets(assetFiles, vaultDir) {
  const byName = new Map();
  for (const file of assetFiles) {
    const relativePath = path.relative(vaultDir, file).replaceAll("\\", "/");
    const publicPath = `assets/vault/${encodePath(relativePath)}`;
    const target = path.join(outDir, "assets", "vault", ...relativePath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(file, target);
    const key = normalizeTitle(path.basename(file));
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({ relativePath, publicPath });
  }
  return byName;
}

async function writeObsidianCss() {
  const cssParts = [];
  const localCssPath = path.join(rootDir, "assets", "obsidian.css");
  const localCss = await fs.readFile(localCssPath, "utf8").catch(() => "");
  if (localCss) cssParts.push(`/* local assets/obsidian.css */\n${localCss}`);

  const snippetsByName = new Map();
  const snippetDirs = [
    path.join(vaultDir, "z_obsidian", "CSS Snippets"),
    path.join(path.dirname(vaultDir), ".obsidian", "snippets")
  ];
  for (const snippetsDir of snippetDirs) {
    const snippetFiles = await fs.readdir(snippetsDir).catch(() => []);
    for (const fileName of snippetFiles.filter((name) => name.toLowerCase().endsWith(".css")).sort()) {
      const cssPath = path.join(snippetsDir, fileName);
      const cssText = await fs.readFile(cssPath, "utf8").catch(() => "");
      if (cssText) snippetsByName.set(fileName.toLowerCase(), { fileName, cssPath, cssText });
    }
  }
  for (const { fileName, cssText } of [...snippetsByName.values()]
    .sort((a, b) => a.fileName.localeCompare(b.fileName, "de"))) {
    cssParts.push(`/* Obsidian snippet: ${fileName} */\n${cssText}`);
  }

  await fs.writeFile(path.join(outDir, "assets", "obsidian.css"), cssParts.join("\n\n"));
}

function pageShell({ title, content, bodyClass }) {
  const assetPrefix = bodyClass.includes("note-page") ? "../" : "";
  const mapAssets = bodyClass.includes("note-projektkarten")
    ? `  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="">
  <script defer src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
`
    : "";
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
${mapAssets}  <link rel="stylesheet" href="${assetPrefix}assets/app.css?v=${assetVersion}">
  <link rel="stylesheet" href="${assetPrefix}assets/obsidian.css?v=${assetVersion}">
  <script defer src="${assetPrefix}assets/app.js?v=${assetVersion}"></script>
</head>
<body class="${bodyClass}">
  <main>${content}</main>
</body>
</html>`;
}

function markdownToHtml(markdown, notesByTitle, assetsByName, context = {}) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let inCode = false;
  let code = [];
  let codeLanguage = "";

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(`<p>${inlineMarkdown(paragraph.join(" "), notesByTitle, assetsByName, context)}</p>`);
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("```")) {
      if (inCode) {
        const codeText = code.join("\n");
        const special = renderPluginCodeBlock(codeLanguage, codeText, notesByTitle, assetsByName, context);
        if (special !== null) {
          blocks.push(special);
        } else if (!isHiddenExportCode(codeText)) {
          blocks.push(`<pre><code>${escapeHtml(codeText)}</code></pre>`);
        }
        inCode = false;
        code = [];
        codeLanguage = "";
      } else {
        flushParagraph();
        inCode = true;
        codeLanguage = line.slice(3).trim().toLowerCase();
      }
      continue;
    }

    if (inCode) {
      code.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    if (isTableRow(line) && isTableSeparator(lines[i + 1] || "")) {
      flushParagraph();
      const tableLines = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        tableLines.push(lines[i]);
        i += 1;
      }
      i -= 1;
      blocks.push(markdownTableToHtml(tableLines, notesByTitle, assetsByName, context));
      continue;
    }

    const callout = line.match(/^>\s*\[!([^\]]+)\]([+-])?\s*(.*)$/);
    if (callout) {
      flushParagraph();
      const calloutLines = [];
      while (i + 1 < lines.length && !isCalloutBoundary(lines[i + 1], calloutLines)) {
        i += 1;
        calloutLines.push(lines[i].replace(/^>\s?/, ""));
      }
      blocks.push(markdownCalloutToHtml(callout, calloutLines, notesByTitle, assetsByName, context));
      continue;
    }

    const quote = line.match(/^>\s*(.+)$/);
    if (quote) {
      flushParagraph();
      blocks.push(`<blockquote>${inlineMarkdown(quote[1], notesByTitle, assetsByName, context)}</blockquote>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const headingText = heading[2].replace(/^#{1,6}\s+/, "");
      blocks.push(`<h${level}>${inlineMarkdown(headingText, notesByTitle, assetsByName, context)}</h${level}>`);
      continue;
    }

    const task = line.match(/^(\s*)[-*]\s+\[([ xX\/-])\]\s+(.+)$/);
    if (task) {
      flushParagraph();
      blocks.push(renderTaskItem({
        indent: task[1].replaceAll("\t", "  ").length,
        status: task[2],
        text: task[3]
      }, notesByTitle, assetsByName, context));
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      blocks.push(`<ul><li>${inlineMarkdown(bullet[1], notesByTitle, assetsByName, context)}</li></ul>`);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  return blocks.join("\n").replaceAll("</ul>\n<ul>", "\n");
}

function isHiddenExportCode(codeText) {
  return /id:\s*BaroviaMap/i.test(codeText)
    && /image:\s*\[\[Karte von Barovia/i.test(codeText)
    && /bounds:\s*\[\[/i.test(codeText);
}

function renderPluginCodeBlock(language, codeText, notesByTitle, assetsByName, context) {
  if (language === "img-gallery") return renderImageGallery(codeText, assetsByName);
  if (language === "tasks") return renderTasksQuery(codeText, notesByTitle, assetsByName, context);
  if (language === "meta-bind") return renderMetaBindBlock(codeText, context.note);
  return null;
}

function renderImageGallery(codeText, assetsByName) {
  const settings = parseCodeSettings(codeText);
  const requestedPath = String(settings.path || "").replaceAll("\\", "/").replace(/^Shared\//i, "").replace(/\/+$/, "");
  const assets = [...assetsByName.values()].flat()
    .filter((asset, index, all) => all.findIndex((candidate) => candidate.relativePath === asset.relativePath) === index)
    .filter((asset) => asset.relativePath.replaceAll("\\", "/").startsWith(`${requestedPath}/`))
    .filter((asset) => [".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"].includes(path.extname(asset.relativePath).toLowerCase()))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, "de", { numeric: true }));
  if (!assets.length) return `<p class="muted">Keine Bilder gefunden.</p>`;
  const type = String(settings.type || "masonry").toLowerCase();
  return `<div class="image-gallery image-gallery-${escapeHtml(type)}">${assets.map((asset) => `<figure><img src="../${asset.publicPath}" alt="${escapeHtml(path.basename(asset.relativePath))}" loading="lazy"><figcaption>${escapeHtml(path.basename(asset.relativePath))}</figcaption></figure>`).join("")}</div>`;
}

function renderTasksQuery(codeText, notesByTitle, assetsByName, context) {
  const include = codeText.match(/description\s+includes\s+(.+)/i)?.[1]?.trim();
  const tasks = [];
  for (const note of notesByTitle.values()) {
    const lines = note.body.replace(/\r\n/g, "\n").split("\n");
    for (const line of lines) {
      const match = line.match(/^(\s*)[-*]\s+\[([ xX\/-])\]\s+(.+)$/);
      if (!match || include && !match[3].toLowerCase().includes(include.toLowerCase())) continue;
      tasks.push({
        indent: match[1].replaceAll("\t", "  ").length,
        status: match[2],
        text: match[3],
        priority: taskPriority(match[3])
      });
    }
  }
  tasks.sort((a, b) => b.priority - a.priority);
  if (!tasks.length) return `<p class="muted">Keine passenden Aufgaben.</p>`;
  return `<div class="task-query">${tasks.map((task) => renderTaskItem(task, notesByTitle, assetsByName, context)).join("")}<p class="task-count">${tasks.length} Aufgaben</p></div>`;
}

function renderTaskItem(task, notesByTitle, assetsByName, context) {
  const state = task.status.toLowerCase() === "x" ? "done" : task.status === "/" ? "progress" : task.status === "-" ? "cancelled" : "open";
  const mark = state === "done" ? "✓" : state === "progress" ? "◐" : state === "cancelled" ? "–" : "";
  const displayText = task.text.replace(/(^|\s)#[\p{L}\p{N}_-]+/gu, "$1").replace(/\s{2,}/g, " ").trim();
  return `<div class="task-item task-${state}" style="--task-indent:${Math.min(task.indent || 0, 12)}px"><span class="task-checkbox" aria-hidden="true">${mark}</span><span>${inlineMarkdown(displayText, notesByTitle, assetsByName, context)}</span></div>`;
}

function taskPriority(text) {
  if (text.includes("🔺")) return 4;
  if (text.includes("⏫")) return 3;
  if (text.includes("🔼")) return 2;
  if (text.includes("🔽")) return 0;
  return 1;
}

function renderMetaBindBlock(codeText, note) {
  if (!note) return "";
  const match = codeText.match(/INPUT\[[^:\]]+(?::|\]:)([^\]]+)\]/i) || codeText.match(/INPUT\[[^:]+:([^\]]+)\]/i);
  if (!match) return "";
  return `<div class="meta-bind-value">${formatProjectValue(note.frontmatter[match[1].trim()] || "")}</div>`;
}

function parseCodeSettings(codeText) {
  const settings = {};
  for (const line of codeText.split(/\r?\n/)) {
    const match = line.match(/^([^:#]+):\s*(.+)$/);
    if (match) settings[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return settings;
}

function isTableRow(line) {
  const trimmed = line.trim();
  return trimmed.includes("|") && splitTableRow(trimmed).length > 1;
}

function isTableSeparator(line) {
  const cells = splitTableRow(line.trim());
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function markdownTableToHtml(tableLines, notesByTitle, assetsByName, context = {}) {
  const [headerLine, separatorLine, ...bodyLines] = tableLines;
  const headers = splitTableRow(headerLine);
  const alignments = splitTableRow(separatorLine).map((cell) => {
    const trimmed = cell.trim();
    if (trimmed.startsWith(":") && trimmed.endsWith(":")) return "center";
    if (trimmed.endsWith(":")) return "right";
    return "left";
  });

  const head = headers.map((cell, index) => {
    const align = alignments[index] || "left";
    return `<th style="text-align:${align}">${inlineMarkdown(cell, notesByTitle, assetsByName, context)}</th>`;
  }).join("");

  const body = bodyLines.map((row) => {
    const cells = splitTableRow(row);
    return `<tr>${headers.map((_, index) => {
      const align = alignments[index] || "left";
      return `<td style="text-align:${align}">${inlineMarkdown(cells[index] || "", notesByTitle, assetsByName, context)}</td>`;
    }).join("")}</tr>`;
  }).join("");

  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function markdownCalloutToHtml(callout, calloutLines, notesByTitle, assetsByName, context = {}) {
  const [, type, fold, rawTitle] = callout;
  const title = rawTitle || type;
  const open = fold === "+" ? " open" : "";
  const content = calloutLines.length
    ? markdownToHtml(calloutLines.join("\n"), notesByTitle, assetsByName, context)
    : "";
  return `<details class="callout callout-${slugify(type)}"${open}><summary>${inlineMarkdown(title, notesByTitle, assetsByName, context)}</summary><div class="callout-body">${content}</div></details>`;
}

function isCalloutBoundary(line, calloutLines) {
  if (/^>\s*\[![^\]]+\]/.test(line)) return true;
  if (calloutLines.length > 0 && /^(#{1,6})\s+/.test(line)) return true;
  return false;
}

function inlineMarkdown(text, notesByTitle, assetsByName, context = {}) {
  const breakToken = "IACCESS_SAFE_BREAK";
  const prepared = String(text)
    .replace(/<br\s*\/?>/gi, breakToken)
    .replace(/(^|\s)#{1,6}\s+/g, "$1");
  return escapeHtml(prepared)
    .replaceAll(breakToken, "<br>")
    .replace(/INPUT\[toggle:([^\]]+)\]/gi, (_, key) => {
      const checked = metaBoolean(context.note?.frontmatter?.[key.trim()]);
      return `<span class="inline-meta-toggle ${checked ? "is-done" : ""}">${checked ? "✓" : ""}</span>`;
    })
    .replace(/INPUT\[[^:\]]+(?:\([^)]*\))*:([^\]]+)\]/gi, (_, key) => {
      return `<span class="inline-meta-value">${formatProjectValue(context.note?.frontmatter?.[key.trim()] || "")}</span>`;
    })
    .replace(/VIEW\[\{([^}]+)\}\]\[link\]/gi, (_, key) => {
      const value = valueText(context.note?.frontmatter?.[key.trim()]);
      return /^https?:\/\//i.test(value)
        ? `<a href="${escapeHtml(value)}" target="_blank" rel="noreferrer">${escapeHtml(value)}</a>`
        : escapeHtml(value);
    })
    .replace(/!\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, target, option) => {
      const asset = resolveAsset(target, assetsByName);
      const width = option && /^\d+$/.test(option.trim()) ? ` style="max-width:${Math.min(Number(option.trim()), 250)}px"` : "";
      const alt = escapeHtml(path.basename(target));
      return asset
        ? `<img class="vault-embed" src="../${asset.publicPath}" alt="${alt}" loading="lazy"${width}>`
        : `<span class="missing-link">${alt}</span>`;
    })
    .replace(/!\[([^\]]*)\]\(([^)]+)\)(?:\{[^}]+\})?/g, (_, alt, src) => {
      return `<img class="vault-embed" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">`;
    })
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, target, label) => {
      const normalized = normalizeTitle(target);
      const note = notesByTitle.get(normalized);
      const textLabel = escapeHtml(label || target);
      const preview = note?.category === "project" ? ` data-preview-url="${note.slug}.html"` : "";
      return note ? `<a class="wiki-link"${preview} href="${note.slug}.html">${textLabel}</a>` : `<span class="missing-link">${textLabel}</span>`;
    })
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)(?:\{[^}]+\})?/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/(^|[\s(])_([^_\n]+)_($|[\s).,;:!?])/g, "$1<em>$2</em>$3")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function resolveAsset(target, assetsByName) {
  const candidates = assetsByName.get(normalizeTitle(path.basename(target))) || [];
  if (!candidates.length) return null;
  const normalizedTarget = normalizeTitle(target).replaceAll("\\", "/");
  return candidates.find((asset) => normalizeTitle(asset.relativePath).endsWith(normalizedTarget)) || candidates[0];
}

function noteCard(note) {
  return `<a class="note-card" href="${note.url}">
    <span>${escapeHtml(labelCategory(note.category))}</span>
    <strong>${escapeHtml(note.title)}</strong>
    <p>${escapeHtml(note.excerpt)}</p>
  </a>`;
}

function noteTeaser(note) {
  return `<a class="note-teaser" href="${note.url}"><strong>${escapeHtml(note.title)}</strong><span>${escapeHtml(note.excerpt)}</span></a>`;
}

function activityGroup(group) {
  return `<section class="activity-group">
    <h3>${escapeHtml(group.title)}</h3>
    <div class="activity-list">
      ${group.cards.length ? group.cards.map(activityCard).join("") : `<p class="muted">Keine passenden Einträge gefunden.</p>`}
    </div>
  </section>`;
}

function activityCard(item) {
  const image = item.image
    ? `<img src="${escapeHtml(item.image.src)}" alt="${escapeHtml(item.image.alt)}" loading="lazy">`
    : "";
  return `<a class="activity-card" href="${item.note.url}">
    <div>
      <strong>${escapeHtml(item.note.title)}</strong>
      <p>${escapeHtml(item.summary)}</p>
    </div>
    ${image}
  </a>`;
}

function relationLink(link) {
  const label = escapeHtml(link.label);
  return link.slug ? `<a href="${link.slug}.html">${label}</a>` : `<span class="missing-link">${label}</span>`;
}

function statCard(label, value) {
  return `<div class="stat"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("de-DE").format(value);
}

function makeExcerpt(markdown) {
  return ellipsize(markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[\[[^\]]+\]\]/g, " ")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, "$2$1")
    .replace(/[#*_`>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim(), 180);
}

function ellipsize(text, maxLength) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  const shortened = normalized.slice(0, Math.max(0, maxLength - 3)).replace(/\s+\S*$/, "").trim();
  return `${shortened || normalized.slice(0, maxLength - 3).trim()}...`;
}

function makeSummary(note) {
  let markdown = note.body;
  if (note.category === "session") {
    const lines = markdown.split(/\r?\n/);
    const storyStart = lines.findIndex((line, index) => index > 8 && (/^#{1,6}\s+/.test(line.trim()) || /^>\s*\[!/.test(line.trim()) || /^Szene\s+\d+/i.test(line.trim())));
    markdown = lines.slice(storyStart === -1 ? 10 : storyStart).join("\n");
  }

  const cleaned = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[\[[^\]]+\]\]/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[![^\]]+\]/g, " ")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, "$2$1")
    .replace(/^\s*(?:#{1,6}|>|[-*+]\s+|\d+\.\s+)/gm, " ")
    .replace(/\|/g, " ")
    .replace(/[#*_`=\[\]{}]/g, " ")
    .replace(/!\w+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const withoutHeaderNoise = cleaned
    .replace(/^\d{1,2}\.\s+[A-Za-zÄÖÜäöüß]+\s+\d{3,4}\s+EB,?\s*\d{1,2}:\d{2}\s*(?:\([^)]+\))?/i, "")
    .replace(/^Schwierigkeit:?\s*[\d./]+(?:\s+Gegner Schwierigkeit:?\s*[\d./]+)?/i, "")
    .trim();

  return ellipsize(withoutHeaderNoise || cleaned, 260);
}

function makeActivitySummary(note, notesByTitle) {
  if (isSessionProtocol(note)) {
    return ellipsize([formatSessionDates(note), makeSummary(note)].filter(Boolean).join(" | "), 260);
  }

  if (note.category !== "npc") return makeSummary(note);

  const parts = [];
  const factions = inferFactions(note, notesByTitle);
  const role = firstTextLine(extractMarkdownSection(note.body, "Beruf / Rolle"));
  const firstLine = firstContentLine(stripKiSummary(note.body));

  if (factions.length) parts.push(`Fraktion: ${factions.join(", ")}`);
  if (role) parts.push(`Rolle: ${role}`);
  if (firstLine) parts.push(firstLine);

  return ellipsize(parts.join(" | ") || makeSummary(note), 260);
}

function extractMarkdownSection(body, heading) {
  const pattern = new RegExp(`(?:^|\\n)###\\s+${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=\\n###\\s+|\\n##\\s+|$)`, "i");
  const match = body.match(pattern);
  return match ? match[1].trim() : "";
}

function firstContentLine(markdown) {
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^---$/.test(trimmed)) continue;
    if (/^!\[\[/.test(trimmed) || /^!\[[^\]]*\]\(/.test(trimmed)) continue;
    if (/^#{1,6}\s+/.test(trimmed)) continue;
    if (/^\s*[-*+]\s*$/.test(trimmed)) continue;
    return firstTextLine(trimmed);
  }
  return "";
}

function firstTextLine(markdown) {
  return markdownToPlainText(markdown).split(/(?<=[.!?])\s+/)[0]?.trim() || "";
}

function markdownToPlainText(markdown) {
  return String(markdown)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[\[[^\]]+\]\]/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, "$2$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*(?:#{1,6}|>|[-*+]\s+|\d+\.\s+)/gm, " ")
    .replace(/\|/g, " ")
    .replace(/[#*_`=\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function groupBy(items, getKey) {
  const grouped = new Map();
  for (const item of items) {
    const key = getKey(item);
    grouped.set(key, [...(grouped.get(key) || []), item]);
  }
  return grouped;
}

function dedupeBy(items, getKey) {
  const seen = new Set();
  return items.filter((item) => {
    const key = getKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeTitle(title) {
  return String(title).trim().toLowerCase();
}

function slugify(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function labelCategory(category) {
  const labels = {
    overview: "Übersicht",
    project: "Projekt",
    expert: "Gutachter",
    character: "Charaktere",
    creature: "Kreaturen",
    faction: "Fraktionen",
    item: "Gegenstände",
    location: "Orte",
    lore: "Welt",
    note: "Notizen",
    npc: "NSCs",
    rules: "Regeln",
    sc: "SCs",
    session: "Protokoll"
  };
  return labels[category] || category;
}

function encodePath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function css() {
  return `:root {
  color-scheme: light;
  --bg: #f3f5f8;
  --surface: #ffffff;
  --ink: #252b36;
  --muted: #687181;
  --line: #d3d9e3;
  --accent: #38589a;
  --accent-strong: #213b78;
  --warn: #8a4650;
  --shadow: 0 10px 30px rgb(26 42 75 / 10%);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); }
a { color: inherit; }
main { width: 100%; margin: 0; padding: 0 0 56px; }
.site-header { align-items: center; background: #fff; border-bottom: 1px solid var(--line); display: grid; gap: 14px; grid-template-columns: minmax(300px, auto) minmax(570px, 1fr) minmax(170px, 220px); min-height: 92px; padding: 10px 18px; position: sticky; top: 0; z-index: 50; }
.header-brand { align-items: center; display: flex; min-width: 0; }
.site-header .brand { display: block; }
.site-header img { display: block; height: 48px; max-width: 190px; object-fit: contain; }
.site-header .brand-title { display: grid; margin-left: 18px; white-space: nowrap; }
.site-header .brand-title strong { color: var(--accent-strong); font-size: clamp(22px, 2vw, 30px); letter-spacing: -.02em; }
.header-stats { display: grid; gap: 3px; grid-template-columns: repeat(5, minmax(68px, 1fr)) minmax(92px, 1.15fr) minmax(108px, 1.3fr); justify-self: center; max-width: 840px; width: 100%; }
.header-stats > div { align-content: center; background: #f4f6fa; border: 1px solid #d7deea; border-radius: 5px; display: grid; min-height: 50px; padding: 5px 7px; text-align: center; }
.header-stats span { color: var(--muted); font-size: 9px; font-weight: 700; line-height: 1.08; }
.header-stats strong { color: var(--accent-strong); font-size: 15px; line-height: 1.1; margin-top: 3px; white-space: nowrap; }
.header-search { justify-self: end; max-width: 220px; }
.site-layout { display: grid; grid-template-columns: minmax(280px, 330px) minmax(0, 1fr); margin: 0 auto; max-width: 1600px; }
.site-sidebar { align-content: start; align-self: start; border-right: 1px solid var(--line); display: grid; gap: 7px; height: calc(100vh - 92px); overflow: auto; padding: 7px 12px 24px; position: sticky; top: 92px; }
.folder-panel h2 { font-size: 15px; margin: 0 4px 6px; }
.dashboard-content, .note-column { min-width: 0; padding: 34px clamp(18px, 4vw, 56px) 56px; }
.dashboard-content { max-width: 1100px; }
.eyebrow { color: var(--accent-strong); font-size: 13px; font-weight: 800; letter-spacing: 0; margin: 0 0 8px; text-transform: uppercase; }
h1 { font-size: clamp(36px, 6vw, 72px); line-height: .95; margin: 0; letter-spacing: 0; }
h2 { font-size: 22px; margin: 0 0 16px; }
.lede { color: var(--muted); font-size: 18px; max-width: 680px; line-height: 1.55; }
.search-shell, .panel, .stat, .note-card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
.search-shell { background: var(--surface); border-color: var(--line); box-shadow: 0 4px 12px rgb(26 42 75 / 7%); padding: 4px; position: relative; width: 100%; z-index: 20; }
.search-shell label { display: block; font-weight: 800; margin-bottom: 8px; }
input[type="search"] { width: 100%; border: 1px solid #ccd4e1; border-radius: 5px; color: var(--ink); font: inherit; font-size: 13px; padding: 6px 8px; }
.search-results { background: var(--surface); border: 1px solid var(--line); border-radius: 7px; box-shadow: 0 12px 28px rgb(20 35 70 / 16%); display: none; left: 0; max-height: min(90vh, max(140px, calc(var(--search-space-below, 90vh) - 12px))); overflow: auto; padding: 5px 8px; position: absolute; right: 0; top: calc(100% + 7px); }
.search-shell.has-results .search-results { display: grid; gap: 2px; }
.search-results a { border-top: 1px solid var(--line); display: block; font-size: 12px; line-height: 1.18; padding: 7px 0 6px; text-decoration: none; }
.search-results a:focus { background: rgb(33 59 120 / 12%); border-radius: 4px; outline: 2px solid rgb(33 59 120 / 55%); outline-offset: 2px; }
.search-results a:first-child { border-top: 0; }
.search-results strong { display: block; font-size: 12px; line-height: 1.18; }
.search-results span, .muted { color: var(--muted); }
.stats {
  display: grid;
  gap: 3px;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  margin: 28px 0 0;
  padding: 6px;
  background: linear-gradient(135deg, #213b78, #6f84b5);
  border-radius: 8px;
  box-shadow: 0 8px 22px rgb(0 0 0 / 10%);
  overflow: hidden;
}
.stat {
  align-items: center;
  background: var(--surface);
  border: 0;
  border-radius: 5px;
  box-shadow: none;
  display: flex;
  justify-content: space-between;
  min-height: 82px;
  padding: 12px 14px;
}
.stat span { color: var(--muted); display: block; font-size: 13px; line-height: 1.2; }
.stat strong { color: var(--accent-strong); display: block; font-size: 25px; line-height: 1.1; margin-left: 8px; text-align: right; overflow-wrap: anywhere; }
.dashboard-grid, .note-section { margin-left: auto; margin-right: auto; width: min(1180px, calc(100% - 32px)); }
.dashboard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 34px; }
.dashboard-side { display: grid; align-content: start; gap: 12px; }
.panel { padding: 20px; box-shadow: none; }
.category-list, .note-list, .relation-list, .category-tree { display: grid; gap: 8px; }
.category-row, .note-teaser, .relation-list a, .relation-list span { align-items: center; border: 1px solid var(--line); border-radius: 6px; display: flex; justify-content: space-between; min-height: 42px; padding: 10px 12px; text-decoration: none; }
.tree-node { border: 1px solid var(--line); border-radius: 6px; background: #fff; overflow: hidden; }
.tree-node summary {
  align-items: center;
  cursor: pointer;
  display: flex;
  gap: 10px;
  justify-content: space-between;
  list-style: none;
  min-height: 40px;
  padding: 9px 12px;
}
.tree-node summary::-webkit-details-marker { display: none; }
.tree-node summary::before {
  color: var(--accent-strong);
  content: "+";
  font-weight: 800;
  margin-right: 2px;
}
.tree-node[open] > summary::before { content: "-"; }
.tree-node summary span { flex: 1; }
.tree-node summary strong { font-size: 13px; }
.tree-root > summary { font-size: 16px; font-weight: 700; }
.tree-children { display: grid; gap: 5px; padding: 0 8px 8px 18px; }
.tree-children .tree-node { background: #f7f8fb; }
.tree-note {
  border-radius: 5px;
  color: var(--ink);
  display: block;
  font-size: 13px;
  line-height: 1.25;
  padding: 6px 8px;
  text-decoration: none;
}
.tree-note:hover { background: #edf1f7; color: var(--accent-strong); }
.tree-note.is-active { background: #dfe7f5; box-shadow: inset 3px 0 0 var(--accent-strong); color: #1d376f; font-weight: 800; }
.note-teaser { align-items: flex-start; display: grid; }
.note-teaser span { color: var(--muted); margin-top: 3px; }
.activity-panel { display: grid; gap: 16px; }
.activity-panel h2 { margin-bottom: 0; }
.activity-group { display: grid; gap: 8px; }
.activity-group h3 { color: var(--accent-strong); font-size: 13px; letter-spacing: 0; margin: 0; text-transform: uppercase; }
.activity-list { display: grid; gap: 7px; }
.activity-card {
  align-items: start;
  border: 1px solid var(--line);
  border-radius: 6px;
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0, 1fr) auto;
  min-height: 78px;
  padding: 9px 10px;
  text-decoration: none;
}
.activity-card strong { display: block; font-size: 14px; line-height: 1.2; margin-bottom: 4px; }
.activity-card p {
  color: var(--muted);
  display: -webkit-box;
  font-size: 12px;
  line-height: 1.28;
  margin: 0;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
.activity-card img { border-radius: 5px; height: 54px; margin-top: 21px; object-fit: cover; width: 54px; }
.note-section { margin-top: 34px; scroll-margin-top: 20px; }
.note-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.note-card { box-shadow: none; min-height: 164px; padding: 16px; text-decoration: none; }
.note-card span { color: var(--accent-strong); display: block; font-size: 12px; font-weight: 800; margin-bottom: 8px; text-transform: uppercase; }
.note-card strong { display: block; font-size: 18px; line-height: 1.25; }
.note-card p { color: var(--muted); line-height: 1.45; margin: 10px 0 0; }
.top-nav { display: flex !important; gap: 6px !important; margin: 4px 0 0 !important; }
.top-nav a { background: var(--surface); border: 1px solid var(--line); border-radius: 5px; font-size: 13px !important; padding: 5px 8px !important; text-decoration: none; }
.note-page main { width: 100%; }
.note-detail { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 30px; }
.note-detail header { min-height: 0; padding-right: 0; position: relative !important; }
.note-detail h1 { font-size: clamp(34px, 5vw, 56px); }
.note-meta { background: #f3f5f9; border: 1px solid var(--line); border-radius: 7px; box-shadow: 0 6px 18px rgb(31 51 92 / 6%); display: grid; gap: 8px; max-width: min(38vw, 310px); padding: 10px; position: absolute; right: 0; top: 0; }
.note-meta-row { display: grid; gap: 4px; justify-items: end; }
.note-meta-row > span { color: var(--muted); font-size: 11px; font-weight: 800; letter-spacing: 0; line-height: 1.1; text-transform: uppercase; }
.note-meta-row > div { display: flex; flex-wrap: wrap; gap: 5px; justify-content: flex-end; min-width: 0; }
.note-meta-row b, .note-meta-row a { background: #e3e9f4; border-radius: 999px; color: var(--accent-strong); display: inline-block; font-size: 12px !important; font-weight: 800; line-height: 1.15 !important; max-width: 100%; overflow-wrap: anywhere; padding: 3px 7px !important; text-decoration: none; }
.content { line-height: 1.7; margin-top: 28px; }
.content h1, .content h2, .content h3 { line-height: 1.2; margin-top: 28px; }
.content h1 { font-size: 32px; }
.content h2 { font-size: 26px; }
.content h3 { font-size: 21px; }
.content code, .content pre { background: #f1eee6; border-radius: 6px; }
.content code { padding: 2px 5px; }
.content pre { overflow: auto; padding: 14px; }
.content img { border-radius: 8px; cursor: zoom-in; display: inline-block; height: auto; margin: 14px 10px 14px 0; max-height: 250px; max-width: 250px; object-fit: contain; vertical-align: top; }
.note-karte-von-barovia .content img.vault-embed { display: block !important; max-height: none !important; max-width: 100% !important; width: 100% !important; }
.image-lightbox { align-items: center; background: rgb(0 0 0 / 82%); cursor: zoom-out; display: none; inset: 0; justify-content: center; overflow: auto; padding: 24px; position: fixed; z-index: 1000; }
.image-lightbox.is-open { display: flex; }
.image-lightbox img { border-radius: 8px; box-shadow: 0 20px 80px rgb(0 0 0 / 55%); max-height: calc(100vh - 48px); max-width: calc(100vw - 48px); object-fit: contain; transform-origin: center; }
.image-lightbox.is-zoomable { cursor: zoom-in; }
.image-lightbox.is-zoomable img { max-height: none; max-width: none; }
.content table { border-collapse: collapse; display: block; max-width: 100%; overflow: auto; }
.content th, .content td { border: 1px solid var(--line); padding: 8px; vertical-align: top; }
.project-overview { display: grid; gap: 24px; }
.project-summary-grid { display: grid; gap: 30px; grid-template-columns: minmax(0, 1fr) minmax(280px, .95fr); }
.project-status { display: grid; gap: 18px; }
.project-text-box h2, .milestone-panel h2 { color: #343a3d; font-size: 20px; margin: 0 0 9px; }
.project-text-box > div { background: #f4f6f9; border: 1px solid #d7dde7; border-left: 4px solid var(--accent); border-radius: 5px; line-height: 1.5; min-height: 88px; padding: 12px; }
.project-file-meta { display: grid; gap: 4px; margin: 0; }
.project-file-meta div { display: flex; gap: 8px; min-width: 0; }
.project-file-meta dt { font-weight: 800; }
.project-file-meta dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.milestone-list { display: grid; gap: 5px; }
.milestone-item { align-items: center; display: flex; gap: 9px; min-height: 29px; }
.milestone-item span { align-items: center; background: #fff; border: 2px solid #adb6c6; border-radius: 3px; color: #fff; display: inline-flex; flex: 0 0 25px; font-size: 16px; font-weight: 900; height: 25px; justify-content: center; }
.milestone-item.is-done span { background: var(--accent-strong); border-color: var(--accent-strong); }
.project-groups { display: grid; gap: 8px 14px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.project-group { background: #f7f8fb; border: 1px solid #bcc7d9; border-radius: 5px; overflow: hidden; }
.project-group summary { align-items: center; color: var(--accent-strong); cursor: pointer; display: flex; font-size: 17px; font-weight: 800; gap: 8px; list-style: none; min-height: 52px; padding: 10px 14px; }
.project-group summary::-webkit-details-marker { display: none; }
.project-group summary::after { content: "⌄"; font-size: 20px; line-height: 1; margin-left: auto; transform: rotate(-90deg); transition: transform .16s ease; }
.project-group[open] summary::after { transform: rotate(0); }
.project-group summary span { color: var(--accent-strong); }
.project-field-table { border: 1px solid #c7d0df; border-radius: 4px; margin: 0 14px 14px; overflow: hidden; }
.project-field-head, .project-field-row { display: grid; grid-template-columns: minmax(140px, .72fr) minmax(0, 1.28fr); }
.project-field-head { background: var(--accent-strong); color: #fff; }
.project-field-head strong { padding: 8px 10px; }
.project-field-head strong + strong { border-left: 1px solid #fff; }
.project-field-row { align-items: stretch; background: #f4f6fa; border-top: 1px solid #c7d0df; }
.project-field-row > strong { align-content: center; display: grid; padding: 9px 10px; }
.project-field-value { align-items: start; background: #e8edf5; border-left: 1px solid #c7d0df; display: flex; gap: 7px; min-height: 42px; min-width: 0; overflow-wrap: anywhere; padding: 8px 10px; }
.project-field-value > span:last-child { min-width: 0; overflow-wrap: anywhere; }
.project-field-value.is-empty { color: #8791a2; }
.project-field-value.is-select { background: #eef1f6; padding-right: 28px; position: relative; }
.project-field-value.is-select::after { color: var(--accent-strong); content: "⌄"; position: absolute; right: 10px; top: 8px; }
.project-field-value.is-date { align-items: center; }
.project-field-value.is-textarea { line-height: 1.45; min-height: 105px; white-space: normal; }
.project-field-value.is-textarea:not(.is-empty) { color: #33405a; }
.field-icon { color: #66758e; flex: 0 0 auto; }
.project-single-field { border-top: 1px solid #c7d0df; padding: 12px 14px 14px; }
.project-single-field > strong { display: block; margin-bottom: 6px; }
.project-single-field .project-field-value { border: 1px solid #c7d0df; min-height: 135px; }
.image-gallery { margin: 12px 0 22px; }
.image-gallery-horizontal { display: flex; gap: 14px; overflow-x: auto; padding: 0 0 10px; scroll-snap-type: x proximity; }
.image-gallery figure { flex: 0 0 auto; margin: 0; scroll-snap-align: start; }
.content .image-gallery img { background: #fff; border: 1px solid var(--line); display: block; margin: 0; max-height: 520px; max-width: min(1100px, 82vw); width: auto; }
.image-gallery figcaption { color: var(--muted); font-size: 11px; margin-top: 4px; }
.task-query { display: grid; gap: 5px; margin: 10px 0 24px; }
.task-item { align-items: flex-start; display: flex; gap: 9px; margin-left: var(--task-indent); min-height: 30px; padding: 3px 0; }
.task-checkbox { align-items: center; background: #fff; border: 2px solid #75839c; border-radius: 3px; color: #fff; display: inline-flex; flex: 0 0 21px; font-size: 13px; font-weight: 900; height: 21px; justify-content: center; margin-top: 2px; }
.task-done { color: #7d8379; }
.task-done .task-checkbox { background: var(--accent-strong); border-color: var(--accent-strong); }
.task-done > span:last-child { text-decoration: line-through; }
.task-progress .task-checkbox { background: #e1e8f5; color: var(--accent-strong); }
.task-cancelled { color: var(--muted); text-decoration: line-through; }
.task-count { color: var(--muted); font-size: 13px; margin: 8px 0 0; }
.meta-bind-value { background: #f4f6f9; border: 1px solid #d7dde7; border-radius: 5px; padding: 10px; }
.inline-meta-toggle { background: #fff; border: 2px solid #aab4c5; border-radius: 3px; color: #fff; display: inline-flex; height: 22px; justify-content: center; margin-right: 5px; vertical-align: middle; width: 22px; }
.inline-meta-toggle.is-done { background: var(--accent-strong); border-color: var(--accent-strong); }
.obsidian-note { box-shadow: inset 0 0 0 1px rgb(33 59 120 / 10%); }
.note-detail { font-size: 13px; }
.note-detail h1 { font-size: clamp(20px, 2.5vw, 28px); line-height: 1.15; }
.content { font-size: 13px; line-height: 1.5; margin-top: 18px; }
.content h1 { font-size: 19px; }
.content h2 { font-size: 17px; }
.content h3 { font-size: 15px; }
.content h4, .content h5, .content h6 { font-size: 14px; }
.task-item { font-size: 13px; line-height: 1.35; min-height: 25px; }
.kanban-board { align-items: start; display: flex; gap: 12px; margin: 0 -12px; overflow-x: auto; padding: 4px 12px 18px; }
.kanban-column { background: #e8edf5; border: 1px solid #bdc9dc; border-radius: 5px; flex: 0 0 290px; max-height: calc(100vh - 190px); overflow: auto; padding: 9px; }
.kanban-column > header { align-items: center; display: flex; justify-content: space-between; margin-bottom: 9px; min-height: 35px; position: sticky; top: 0; z-index: 2; }
.kanban-column > header h2 { color: var(--accent-strong); font-size: 16px; margin: 0; }
.kanban-column > header span { color: var(--muted); font-size: 12px; }
.kanban-cards { display: grid; gap: 7px; }
.kanban-card { background: #fff; border: 1px solid #c8d1df; border-radius: 3px; display: block; font-size: 13px; line-height: 1.25; padding: 8px 9px; text-decoration: none; }
.kanban-card:hover { background: #f6f8fc; border-color: #8298bc; }
.kanban-card.is-heading { color: #29313d; font-weight: 800; }
.note-projektphasen .note-column { padding-left: 18px; padding-right: 18px; }
.note-projektphasen .note-detail { overflow: hidden; }
.note-preview { background: #fff; border: 1px solid #aebbd0; border-radius: 7px; box-shadow: 0 18px 55px rgb(20 35 70 / 28%); display: none; height: min(72vh, 760px); overflow: hidden; position: fixed; right: 22px; top: 110px; width: min(760px, calc(100vw - 44px)); z-index: 300; }
.note-preview.is-open { display: grid; grid-template-rows: auto minmax(0, 1fr); }
.note-preview-bar { align-items: center; background: #edf1f7; border-bottom: 1px solid var(--line); display: flex; gap: 9px; justify-content: flex-end; padding: 7px 9px; }
.note-preview-bar strong { color: var(--accent-strong); margin-right: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.note-preview-bar a, .note-preview-bar button { background: #fff; border: 1px solid #b9c4d5; border-radius: 4px; color: var(--accent-strong); cursor: pointer; font: inherit; padding: 4px 7px; text-decoration: none; }
.note-preview-content { overflow: auto; padding: 18px; user-select: text; }
.note-preview-content .note-detail { border: 0; box-shadow: none; padding: 0; }
.note-preview-content .note-detail > header { min-height: 0; padding-right: 0; }
.note-preview-content .note-meta, .note-preview-content .relation-panel { display: none; }
.project-maps { display: grid; gap: 22px; }
.map-intro { color: var(--muted); margin: 0; }
.map-legend { display: flex; flex-wrap: wrap; gap: 7px 14px; }
.map-status { align-items: center; display: inline-flex; gap: 6px; }
.map-status::before { background: #7b8493; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 0 0 1px #7b8493; content: ""; height: 11px; width: 11px; }
.map-status.acquisition::before, .map-pin.acquisition { background: #7485ad; }
.map-status.development::before, .map-pin.development { background: #3f6db5; }
.map-status.construction::before, .map-pin.construction { background: #d4872c; }
.map-status.built::before, .map-pin.built { background: #253b78; }
.country-map-section h2 { color: var(--accent-strong); margin-bottom: 8px; }
.project-map { background: #e9edf3; border: 1px solid var(--line); border-radius: 6px; height: 540px; overflow: hidden; }
.map-progress { color: var(--muted); font-size: 12px; margin: 5px 0 0; }
.map-pin { border: 2px solid #fff; border-radius: 50% 50% 50% 0; box-shadow: 0 1px 4px rgb(0 0 0 / 45%); height: 18px; transform: rotate(-45deg); width: 18px; }
.map-pin.other { background: #7b8493; }
.leaflet-popup-content { font-size: 13px; line-height: 1.35; }
.leaflet-popup-content a { color: var(--accent-strong); font-weight: 800; }
.note-malduk-charakterblatt .note-detail header { min-height: 58px; }
.note-malduk-charakterblatt .content { color: #261c16; font-size: 13px; line-height: 1.35; margin-top: 12px; }
.note-malduk-charakterblatt .content h1 { display: none; }
.note-malduk-charakterblatt .content h2 { border-bottom: 2px solid #7d2925; color: #3a2118; font-size: 17px; letter-spacing: 0; margin: 16px 0 7px; padding-bottom: 3px; text-transform: uppercase; }
.note-malduk-charakterblatt .content h3 { color: #63362c; font-size: 13px; margin: 9px 0 4px; text-transform: uppercase; }
.note-malduk-charakterblatt .content img.vault-embed { float: right; margin: 0 0 8px 14px; max-height: 190px; max-width: 190px; }
.note-malduk-charakterblatt .content ul { margin: 4px 0; padding-left: 18px; }
.note-malduk-charakterblatt .content li { margin: 1px 0; }
.note-malduk-charakterblatt .content table { background: rgb(255 252 244 / 72%); border-collapse: separate; border-spacing: 0; display: table; font-size: 12px; margin: 5px 0 8px; overflow: visible; width: 100%; }
.note-malduk-charakterblatt .content th { background: #564334; color: #fff8e8; font-size: 11px; letter-spacing: 0; text-transform: uppercase; }
.note-malduk-charakterblatt .content th, .note-malduk-charakterblatt .content td { border-color: #c7b28c; padding: 4px 6px; }
.note-malduk-charakterblatt .content table:nth-of-type(1) th { background: #394c59; text-align: center !important; }
.note-malduk-charakterblatt .content table:nth-of-type(1) td { font-size: 21px; font-weight: 900; line-height: 1; text-align: center !important; }
.note-malduk-charakterblatt .content table:nth-of-type(1) td:first-child { color: #766a5a; font-size: 10px; font-weight: 900; text-transform: uppercase; }
.note-malduk-charakterblatt .content table:nth-of-type(1) tbody tr:nth-child(2) td { color: #766a5a; font-size: 10px; font-weight: 800; }
.note-malduk-charakterblatt .content table:nth-of-type(2), .note-malduk-charakterblatt .content table:nth-of-type(3), .note-malduk-charakterblatt .content table:nth-of-type(4), .note-malduk-charakterblatt .content table:nth-of-type(5), .note-malduk-charakterblatt .content table:nth-of-type(6), .note-malduk-charakterblatt .content table:nth-of-type(7), .note-malduk-charakterblatt .content table:nth-of-type(8), .note-malduk-charakterblatt .content table:nth-of-type(9), .note-malduk-charakterblatt .content table:nth-of-type(10) { width: auto; }
.note-malduk-charakterblatt .content > p strong { color: #7d2925; }
.note-malduk-charakterblatt .content > ul:last-child li { background: #fffaf0; border: 1px solid #d2bc93; border-left: 4px solid #7d2925; border-radius: 4px; margin: 5px 0; padding: 5px 7px; }
@media print {
  body.note-malduk-charakterblatt { background: #fff; }
  .note-malduk-charakterblatt .top-nav, .note-malduk-charakterblatt .relation-panel, .note-malduk-charakterblatt .note-meta { display: none !important; }
  .note-malduk-charakterblatt .note-detail { border: 0; box-shadow: none; padding: 10mm; }
  .note-malduk-charakterblatt .content { font-size: 9.5px; line-height: 1.18; }
  .note-malduk-charakterblatt .content h2 { font-size: 12px; margin-top: 8px; }
  .note-malduk-charakterblatt .content h3 { font-size: 10px; margin-top: 5px; }
  .note-malduk-charakterblatt .content th, .note-malduk-charakterblatt .content td { padding: 2px 4px; }
  .note-malduk-charakterblatt .content img.vault-embed { max-height: 120px; max-width: 120px; }
}
.callout, blockquote { border-left: 4px solid var(--accent); background: #f2eee6; border-radius: 6px; margin: 14px 0; padding: 10px 14px; }
.callout summary { cursor: pointer; font-weight: 800; list-style-position: outside; padding: 2px 0; }
.callout summary::marker { color: var(--accent-strong); }
.callout-body { margin-top: 12px; }
.callout-body > :first-child { margin-top: 0; }
.callout-body > :last-child { margin-bottom: 0; }
.callout-body blockquote { background: transparent; margin-left: 0; }
.wiki-link { color: var(--accent-strong); font-weight: 700; }
.missing-link { color: var(--warn); }
.relation-panel { display: grid; align-content: start; gap: 16px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.relation-panel section {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 6px 18px rgb(31 51 92 / 6%);
  padding: 16px;
}
.relation-panel .relation-list a,
.relation-panel .relation-list span {
  background: #f5f7fa;
  border-color: #d7dde7;
  font-size: 13px;
  line-height: 1.2;
  min-height: 32px;
  padding: 7px 10px;
}
.relation-panel .muted { font-size: 13px; line-height: 1.2; }
.note-feedback {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 6px 18px rgb(31 51 92 / 6%);
  margin: 18px 0;
  padding: 18px;
}
.note-feedback-heading { align-items: end; display: flex; gap: 24px; justify-content: space-between; }
.note-feedback-heading h2 { color: var(--accent-strong); font-size: 18px; margin: 2px 0 0; }
.note-feedback-heading p { color: var(--muted); font-size: 12px; line-height: 1.4; margin: 0; max-width: 520px; }
.note-feedback-heading .eyebrow { font-size: 10px; }
.note-feedback-form { display: grid; gap: 12px; margin-top: 16px; }
.note-feedback-form .feedback-trap { display: none; }
.note-feedback-form label { display: grid; gap: 5px; }
.note-feedback-form label > span { color: var(--accent-strong); font-size: 12px; font-weight: 800; }
.note-feedback-form input,
.note-feedback-form textarea {
  background: #f7f9fc;
  border: 1px solid #c8d1df;
  border-radius: 5px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  padding: 9px 10px;
  resize: vertical;
}
.note-feedback-form input:focus,
.note-feedback-form textarea:focus { border-color: var(--accent-strong); box-shadow: 0 0 0 3px rgb(33 59 120 / 12%); outline: 0; }
.note-feedback-actions { align-items: center; display: flex; gap: 12px; }
.note-feedback-actions button {
  background: var(--accent-strong);
  border: 0;
  border-radius: 5px;
  color: #fff;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 800;
  padding: 9px 14px;
}
.note-feedback-actions button:disabled { cursor: wait; opacity: .65; }
.note-feedback-status { color: var(--muted); font-size: 12px; margin: 0; }
.note-feedback-status.is-success { color: #205f46; font-weight: 700; }
.note-feedback-status.is-error { color: #9a2f36; font-weight: 700; }
@media (max-width: 860px) {
  .site-header { grid-template-columns: 1fr; position: static; }
  .header-brand { justify-content: center; }
  .header-stats { grid-template-columns: repeat(4, minmax(64px, 1fr)); max-width: none; order: 3; }
  .header-search { justify-self: stretch; max-width: none; }
  .site-layout { grid-template-columns: 1fr; }
  .site-sidebar { border-bottom: 1px solid var(--line); border-right: 0; height: auto; max-height: 58vh; position: static; }
  .relation-panel { grid-template-columns: 1fr; }
  .note-feedback-heading { align-items: start; flex-direction: column; gap: 8px; }
  .project-summary-grid, .project-groups { grid-template-columns: 1fr; }
  .note-detail header { padding-right: 0; }
  .note-meta { margin-top: 12px; max-width: none; position: static; }
  .note-meta-row { justify-items: start; }
  .note-meta-row > div { justify-content: flex-start; }
}
@media (max-width: 520px) {
  .site-header { padding: 10px; }
  .site-header img { height: 40px; max-width: 155px; }
  .site-header .brand-title { margin-left: 10px; }
  .site-header .brand-title strong { font-size: 21px; }
  .header-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .note-detail { padding: 20px; }
}`;
}

function js() {
  return `async function bootSearch() {
  const input = document.querySelector("#site-search");
  const results = document.querySelector("#search-results");
  if (!input || !results) return;
  const shell = input.closest(".search-shell");

  const rootPrefix = window.location.pathname.includes("/notes/") ? "../" : "";
  const notes = await fetch(rootPrefix + "api/index.json").then((response) => response.json()).catch(() => []);
  const haystack = notes.map((note) => ({
    ...note,
    aliases: normalizeAliases(note.frontmatter?.aliases || note.frontmatter?.alias || []),
    text: [note.title, ...normalizeAliases(note.frontmatter?.aliases || note.frontmatter?.alias || [])].join(" ").toLowerCase()
  }));

  const resultLinks = () => Array.from(results.querySelectorAll("a"));
  const focusResult = (index) => {
    const links = resultLinks();
    if (!links.length) return false;
    const next = ((index % links.length) + links.length) % links.length;
    links[next].focus();
    links[next].scrollIntoView({ block: "nearest" });
    return true;
  };
  const focusSearchInput = () => {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  };

  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase();
    results.innerHTML = "";
    shell?.classList.remove("has-results");
    shell?.style.setProperty("--search-shift", "0px");
    if (!query) return;

    const matches = haystack.filter((note) => note.text.includes(query)).slice(0, 10);
    results.innerHTML = matches.length
      ? matches.map((note) => '<a href="' + rootPrefix + note.url + '"><strong>' + escapeHtml(note.title) + '</strong>' + (note.aliases.length ? '<span>' + escapeHtml(note.aliases.join(", ")) + '</span>' : '') + '</a>').join("")
      : '<p class="muted">Keine Treffer.</p>';
    shell?.classList.add("has-results");
    updateSearchDropdown(shell, results);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && focusResult(0)) {
      event.preventDefault();
    } else if (event.key === "ArrowUp" && focusResult(-1)) {
      event.preventDefault();
    }
  });

  results.addEventListener("keydown", (event) => {
    const links = resultLinks();
    const index = links.indexOf(document.activeElement);
    if (index === -1) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusResult(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusResult(index - 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      focusSearchInput();
    } else if (event.key === "Enter") {
      event.preventDefault();
      window.location.href = links[index].href;
    }
  });

  window.addEventListener("resize", () => updateSearchDropdown(shell, results));
}

function updateSearchDropdown(shell, results) {
  if (!shell || !results || !shell.classList.contains("has-results")) return;
  shell.style.setProperty("--search-shift", "0px");
  const rect = shell.getBoundingClientRect();
  const gap = 7;
  const below = Math.max(0, window.innerHeight - rect.bottom - gap);
  const wanted = Math.min(results.scrollHeight, window.innerHeight * 0.9);
  const maxShift = Math.max(0, rect.top - gap);
  const shift = Math.min(Math.max(0, wanted - below), maxShift);
  shell.style.setProperty("--search-shift", shift ? "-" + shift + "px" : "0px");
  shell.style.setProperty("--search-space-below", (below + shift) + "px");
}

function normalizeAliases(value) {
  const aliases = Array.isArray(value) ? value : [value];
  return aliases.map((item) => String(item || "").trim()).filter(Boolean);
}

function bootImageLightbox() {
  const images = document.querySelectorAll(".content img");
  if (!images.length) return;

  const lightbox = document.createElement("div");
  lightbox.className = "image-lightbox";
  lightbox.setAttribute("role", "dialog");
  lightbox.setAttribute("aria-modal", "true");
  lightbox.innerHTML = '<img alt="">';
  document.body.appendChild(lightbox);

  const lightboxImage = lightbox.querySelector("img");
  let zoom = 1;
  let maxZoom = 1;
  const applyZoom = () => {
    lightboxImage.style.width = lightboxImage.dataset.fitWidth ? (Number(lightboxImage.dataset.fitWidth) * zoom) + "px" : "";
    lightboxImage.style.height = "auto";
  };
  const close = () => {
    lightbox.classList.remove("is-open");
    lightbox.classList.remove("is-zoomable");
    lightboxImage.removeAttribute("src");
    lightboxImage.removeAttribute("style");
    lightboxImage.removeAttribute("data-fit-width");
  };

  images.forEach((image) => {
    image.addEventListener("click", () => {
      const isMap = document.body.classList.contains("note-karte-von-barovia") && image.classList.contains("vault-embed");
      zoom = 1;
      maxZoom = isMap ? 2 : 1;
      lightboxImage.src = image.currentSrc || image.src;
      lightboxImage.alt = image.alt || "";
      lightbox.classList.toggle("is-zoomable", isMap);
      lightbox.classList.add("is-open");
      lightboxImage.onload = () => {
        if (!isMap) return;
        const fitWidth = Math.min(lightboxImage.naturalWidth, window.innerWidth - 48);
        lightboxImage.dataset.fitWidth = String(fitWidth);
        applyZoom();
      };
    });
  });

  lightbox.addEventListener("wheel", (event) => {
    if (!lightbox.classList.contains("is-zoomable")) return;
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    zoom = Math.min(maxZoom, Math.max(0.3, zoom + direction * 0.15));
    applyZoom();
  }, { passive: false });

  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) close();
  });
  lightboxImage.addEventListener("click", () => {
    if (!lightbox.classList.contains("is-zoomable")) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

function bootFolderTree() {
  const tree = document.querySelector(".category-tree");
  if (!tree) return;
  const storageKey = "iaccess-folder-tree-open";
  let stored = [];
  try {
    stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
  } catch {
    stored = [];
  }
  const openIds = new Set(Array.isArray(stored) ? stored : []);
  const details = Array.from(tree.querySelectorAll("details[data-tree-id]"));
  details.forEach((item) => {
    if (openIds.has(item.dataset.treeId)) item.open = true;
    item.addEventListener("toggle", () => {
      const next = details.filter((entry) => entry.open).map((entry) => entry.dataset.treeId);
      localStorage.setItem(storageKey, JSON.stringify(next));
    });
  });

  const currentPath = decodeURIComponent(window.location.pathname).replace(/\\/+$/, "");
  const active = Array.from(tree.querySelectorAll("a.tree-note")).find((link) => {
    const linkPath = decodeURIComponent(new URL(link.href, window.location.href).pathname).replace(/\\/+$/, "");
    return linkPath === currentPath;
  });
  if (!active) return;
  active.classList.add("is-active");
  active.setAttribute("aria-current", "page");
  let parent = active.parentElement;
  while (parent && parent !== tree) {
    if (parent.matches?.("details[data-tree-id]")) parent.open = true;
    parent = parent.parentElement;
  }
  localStorage.setItem(storageKey, JSON.stringify(details.filter((entry) => entry.open).map((entry) => entry.dataset.treeId)));
  requestAnimationFrame(() => active.scrollIntoView({ block: "nearest" }));
}

function bootNotePreviews() {
  if (!document.querySelector("[data-preview-url]")) return;
  const preview = document.createElement("aside");
  preview.className = "note-preview";
  preview.setAttribute("aria-label", "Notizvorschau");
  preview.innerHTML = '<div class="note-preview-bar"><strong>Vorschau</strong><a href="#">Öffnen</a><button type="button" aria-label="Schließen">×</button></div><div class="note-preview-content"></div>';
  document.body.appendChild(preview);
  const title = preview.querySelector("strong");
  const openLink = preview.querySelector("a");
  const closeButton = preview.querySelector("button");
  const content = preview.querySelector(".note-preview-content");
  const cache = new Map();
  let closeTimer = 0;
  let requestId = 0;

  const cancelClose = () => window.clearTimeout(closeTimer);
  const close = () => {
    cancelClose();
    preview.classList.remove("is-open");
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer = window.setTimeout(close, 260);
  };
  const open = async (link) => {
    cancelClose();
    const url = new URL(link.dataset.previewUrl, window.location.href).href;
    title.textContent = link.textContent.trim() || "Vorschau";
    openLink.href = url;
    preview.classList.add("is-open");
    const id = ++requestId;
    if (cache.has(url)) {
      content.innerHTML = cache.get(url);
      return;
    }
    content.innerHTML = '<p class="muted">Vorschau wird geladen…</p>';
    const html = await fetch(url).then((response) => response.ok ? response.text() : "").catch(() => "");
    if (id !== requestId) return;
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const article = parsed.querySelector(".note-detail");
    const markup = article ? article.outerHTML : '<p class="muted">Keine Vorschau verfügbar.</p>';
    cache.set(url, markup);
    content.innerHTML = markup;
    content.scrollTop = 0;
  };

  document.addEventListener("pointerover", (event) => {
    const link = event.target.closest?.("[data-preview-url]");
    if (!link || link.contains(event.relatedTarget)) return;
    open(link);
  });
  document.addEventListener("pointerout", (event) => {
    const link = event.target.closest?.("[data-preview-url]");
    if (!link || link.contains(event.relatedTarget)) return;
    scheduleClose();
  });
  preview.addEventListener("pointerenter", cancelClose);
  preview.addEventListener("pointerleave", scheduleClose);
  closeButton.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

function bootProjectMaps() {
  const dataElement = document.querySelector("#project-map-data");
  if (!dataElement || !window.L) return;
  let projects = [];
  try {
    projects = JSON.parse(dataElement.textContent || "[]");
  } catch {
    return;
  }
  const settings = {
    DE: { center: [51.1, 10.4], zoom: 6 },
    FR: { center: [46.6, 2.4], zoom: 6 },
    JP: { center: [36.2, 138.2], zoom: 5 }
  };
  const maps = new Map();
  document.querySelectorAll(".project-map[data-country]").forEach((element) => {
    const country = element.dataset.country;
    const setting = settings[country];
    const map = L.map(element, { scrollWheelZoom: true }).setView(setting.center, setting.zoom);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    maps.set(country, { map, bounds: [] });
  });

  const markerFor = (project) => {
    if (!project.coordinates || !maps.has(project.country)) return;
    const target = maps.get(project.country);
    const icon = L.divIcon({
      className: "map-pin-shell",
      html: '<div class="map-pin ' + escapeHtml(project.status) + '"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 18],
      popupAnchor: [0, -17]
    });
    L.marker(project.coordinates, { icon }).addTo(target.map)
      .bindPopup('<a href="' + escapeHtml(project.url) + '">' + escapeHtml(project.title) + '</a><br>' + escapeHtml(project.location || ""));
    target.bounds.push(project.coordinates);
  };

  projects.filter((project) => project.coordinates).forEach(markerFor);
  const cacheKey = "iaccess-project-geocoding-v1";
  let cache = {};
  try {
    cache = JSON.parse(localStorage.getItem(cacheKey) || "{}");
  } catch {
    cache = {};
  }
  const missing = projects.filter((project) => !project.coordinates && project.location);
  const updateProgress = () => {
    for (const country of Object.keys(settings)) {
      const countryProjects = projects.filter((project) => project.country === country);
      const located = countryProjects.filter((project) => project.coordinates).length;
      const progress = document.querySelector('[data-map-progress="' + country + '"]');
      if (progress) progress.textContent = located + " von " + countryProjects.length + " Projekten verortet";
    }
  };
  const fitMaps = () => {
    for (const target of maps.values()) {
      if (target.bounds.length > 1) target.map.fitBounds(target.bounds, { padding: [24, 24], maxZoom: 11 });
    }
  };
  updateProgress();
  fitMaps();

  const geocode = async (project) => {
    const key = project.country + "|" + project.location.toLowerCase();
    if (Array.isArray(cache[key])) return cache[key];
    const url = "https://geocoding-api.open-meteo.com/v1/search?name=" + encodeURIComponent(project.location) + "&count=1&language=de&format=json&countryCode=" + project.country;
    const result = await fetch(url).then((response) => response.ok ? response.json() : null).catch(() => null);
    const hit = result?.results?.[0];
    const coordinates = hit ? [hit.latitude, hit.longitude] : null;
    cache[key] = coordinates;
    localStorage.setItem(cacheKey, JSON.stringify(cache));
    return coordinates;
  };
  let cursor = 0;
  const worker = async () => {
    while (cursor < missing.length) {
      const project = missing[cursor++];
      project.coordinates = await geocode(project);
      if (project.coordinates) markerFor(project);
      updateProgress();
      await new Promise((resolve) => window.setTimeout(resolve, 180));
    }
  };
  Promise.all([worker(), worker(), worker()]).then(fitMaps);
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function bootNoteFeedback() {
  document.querySelectorAll(".note-feedback-form").forEach((form) => {
    const status = form.querySelector(".note-feedback-status");
    const button = form.querySelector('button[type="submit"]');
    const linkField = form.querySelector('input[name="Notiz-Link"]');
    const timeField = form.querySelector('input[name="Zeitpunkt"]');
    if (linkField) linkField.value = window.location.href;
    if (timeField) timeField.value = new Date().toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "medium" });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      status.className = "note-feedback-status";
      status.textContent = "";
      if (timeField) timeField.value = new Date().toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "medium" });

      if (form.action.endsWith("/FORM_ID")) {
        status.classList.add("is-error");
        status.textContent = "Die Kommentarfunktion ist noch nicht aktiviert.";
        return;
      }

      button.disabled = true;
      button.textContent = "Wird abgeschickt...";
      try {
        const response = await fetch(form.action, {
          method: "POST",
          body: new FormData(form),
          headers: { Accept: "application/json" }
        });
        if (!response.ok) throw new Error("Formspree request failed");
        form.reset();
        if (linkField) linkField.value = window.location.href;
        if (timeField) timeField.value = new Date().toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "medium" });
        status.classList.add("is-success");
        status.textContent = "Die Anmerkung wurde erfolgreich abgeschickt.";
      } catch {
        status.classList.add("is-error");
        status.textContent = "Die Anmerkung konnte nicht abgeschickt werden. Bitte versuchen Sie es erneut.";
      } finally {
        button.disabled = false;
        button.textContent = "Anmerkung abschicken";
      }
    });
  });
}

bootSearch();
bootImageLightbox();
bootFolderTree();
bootNotePreviews();
bootProjectMaps();
bootNoteFeedback();`;
}
