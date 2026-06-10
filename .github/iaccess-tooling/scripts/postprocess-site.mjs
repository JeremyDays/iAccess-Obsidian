import fs from "node:fs/promises";
import path from "node:path";

const siteDir = path.resolve(process.argv[2] || "");
const mergedSlug = "zutzen-berkholz-meyenburg-c";
const mergedFileName = "zützen-berkholz-meyenburg (c).md";

if (!siteDir) {
  console.error('Usage: node scripts/postprocess-site.mjs "C:\\Path\\To\\GeneratedSite"');
  process.exit(1);
}

const stat = await fs.stat(siteDir).catch(() => null);
if (!stat?.isDirectory()) {
  throw new Error(`Generated site directory not found: ${siteDir}`);
}

const mergedHtmlPath = path.join(siteDir, "notes", `${mergedSlug}.html`);
const mergedApiPath = path.join(siteDir, "api", "notes", `${mergedSlug}.json`);
const mergedProjectExists = Boolean(
  await fs.stat(mergedHtmlPath).catch(() => null)
  || await fs.stat(mergedApiPath).catch(() => null)
);

const files = await walk(siteDir);
const htmlFiles = files.filter((file) => file.toLowerCase().endsWith(".html"));

for (const file of htmlFiles) {
  let html = await fs.readFile(file, "utf8");
  html = removeDashboardStat(html, "Aufgegeben");

  if (mergedProjectExists) {
    html = decrementDashboardStat(html, "Projekte gesamt");
    html = decrementDashboardStat(html, "In Akquise");
    html = removeMergedProjectLinks(html);
    html = decrementTreeCount(html, "Projekte");
    html = decrementTreeCount(html, "Projekte/F - Leads");
    html = decrementTreeCount(html, "Projekte/F - Leads/F1 - Warm-Akquise");
  }

  await fs.writeFile(file, html, "utf8");
}

await patchCss(path.join(siteDir, "assets", "app.css"));

if (mergedProjectExists) {
  await fs.rm(mergedHtmlPath, { force: true });
  await fs.rm(mergedApiPath, { force: true });
  await patchIndex(path.join(siteDir, "api", "index.json"));
  await patchGraph(path.join(siteDir, "api", "graph.json"));
  await patchNoteApis(path.join(siteDir, "api", "notes"));
}

console.log(`Post-processed ${htmlFiles.length} HTML files in ${siteDir}`);
if (mergedProjectExists) {
  console.log("Removed merged project Zützen-Berkholz-Meyenburg (C); separate projects remain.");
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

function removeDashboardStat(html, label) {
  const escaped = escapeRegExp(label);
  return html.replace(
    new RegExp(`<div><span>${escaped}<\\/span><strong>[^<]*<\\/strong><\\/div>`, "g"),
    ""
  );
}

function decrementDashboardStat(html, label) {
  const escaped = escapeRegExp(label);
  return html.replace(
    new RegExp(`(<div><span>${escaped}<\\/span><strong>)([\\d.]+)(<\\/strong><\\/div>)`, "g"),
    (_, start, value, end) => {
      const number = Number(String(value).replaceAll(".", ""));
      return Number.isFinite(number) && number > 0
        ? `${start}${new Intl.NumberFormat("de-DE").format(number - 1)}${end}`
        : `${start}${value}${end}`;
    }
  );
}

function removeMergedProjectLinks(html) {
  return html
    .replace(
      new RegExp(`<a\\b[^>]*href="(?:\\.\\.\\/notes\\/)?${mergedSlug}\\.html"[^>]*>[\\s\\S]*?<\\/a>`, "gi"),
      ""
    )
    .replace(
      new RegExp(`<a\\b[^>]*data-note-slug="${mergedSlug}"[^>]*>[\\s\\S]*?<\\/a>`, "gi"),
      ""
    );
}

function decrementTreeCount(html, treeId) {
  const escaped = escapeRegExp(treeId);
  return html.replace(
    new RegExp(`(<details class="tree-node[^"]*" data-tree-id="${escaped}">\\s*<summary><span>[^<]+<\\/span><strong>)(\\d+)(<\\/strong>)`, "g"),
    (_, start, value, end) => `${start}${Math.max(0, Number(value) - 1)}${end}`
  );
}

async function patchCss(file) {
  const css = await fs.readFile(file, "utf8");
  const marker = "/* iAccess compact two-row header */";
  const withoutOldPatch = css.includes(marker) ? css.slice(0, css.indexOf(marker)).trimEnd() : css.trimEnd();
  const patch = `

${marker}
@media (min-width: 861px) {
  .site-header {
    align-items: center;
    gap: 7px 14px;
    grid-template-columns: minmax(300px, auto) minmax(0, 1fr);
    min-height: 126px;
  }
  .header-stats {
    grid-template-columns:
      repeat(7, minmax(68px, 1fr))
      repeat(2, minmax(104px, 1.2fr))
      minmax(148px, 1.55fr);
    max-width: none;
  }
  .header-search {
    grid-column: 1 / -1;
    justify-self: end;
    max-width: 300px;
  }
  .site-sidebar {
    height: calc(100vh - 126px);
    top: 126px;
  }
}
`;
  await fs.writeFile(file, `${withoutOldPatch}${patch}`, "utf8");
}

async function patchIndex(file) {
  const index = JSON.parse(await fs.readFile(file, "utf8"));
  const filtered = index
    .filter((note) => note.slug !== mergedSlug && !isMergedPath(note.relativePath))
    .map(cleanNoteRecord);
  await fs.writeFile(file, `${JSON.stringify(filtered, null, 2)}\n`, "utf8");
}

async function patchGraph(file) {
  const graph = JSON.parse(await fs.readFile(file, "utf8"));
  graph.nodes = (graph.nodes || []).filter((node) => node.id !== mergedSlug);
  graph.edges = (graph.edges || []).filter((edge) =>
    edge.source !== mergedSlug
    && edge.target !== mergedSlug
    && edge.from !== mergedSlug
    && edge.to !== mergedSlug
  );
  await fs.writeFile(file, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
}

async function patchNoteApis(dir) {
  const entries = await fs.readdir(dir).catch(() => []);
  await Promise.all(entries.filter((name) => name.endsWith(".json")).map(async (name) => {
    const file = path.join(dir, name);
    const source = await fs.readFile(file, "utf8");
    if (!isMergedPath(source)) return;
    const note = JSON.parse(source);
    const cleaned = cleanNoteRecord(note);
    await fs.writeFile(file, `${JSON.stringify(cleaned, null, 2)}\n`, "utf8");
  }));
}

function cleanNoteRecord(note) {
  if (Array.isArray(note.links)) {
    note.links = note.links.filter((link) =>
      link.slug !== mergedSlug
      && !isMergedPath(link.target)
      && normalize(link.label) !== normalize("Zützen-Berkholz-Meyenburg (C)")
    );
  }
  if (typeof note.markdown === "string") {
    note.markdown = note.markdown
      .split(/\r?\n/)
      .filter((line) => !isMergedPath(line))
      .join("\n");
  }
  return note;
}

function isMergedPath(value) {
  const normalized = normalize(value);
  return normalized.includes(mergedSlug)
    || normalized.includes(normalize(mergedFileName.replace(/\.md$/i, "")));
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
