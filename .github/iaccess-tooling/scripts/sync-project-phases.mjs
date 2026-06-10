import fs from "node:fs/promises";
import path from "node:path";

const sharedDir = path.resolve(process.argv[2] || "");
const apply = process.argv.includes("--apply");
const projectsDir = path.join(sharedDir, "Projekte");
const targetFile = path.join(sharedDir, "0 - Übersicht", "Projektphasen.md");

if (!sharedDir) {
  console.error('Usage: node scripts/sync-project-phases.mjs "C:\\Path\\To\\Shared" [--apply]');
  process.exit(1);
}

const columns = [
  {
    title: "Baureife Projekte",
    roots: [
      { folder: "A0 - In Betrieb", heading: "In Betrieb" },
      { folder: "A1 - Inbetriebnahme", heading: "Nacharbeiten" },
      { folder: "A2 - Im Bau", heading: "Im Bau" }
    ]
  },
  { title: "Bauantragsverfahren", roots: [{ folder: "B - BaugenehmigungV" }] },
  { title: "Bauleitplanungsverfahren", roots: [{ folder: "C - BaurechtV" }] },
  { title: "Bezug-Projekte", roots: [{ folder: "D1 - Bezugsprojekte" }] },
  { title: "Kaufprojekte", roots: [{ folder: "D2 - Kaufprojekte DD" }] },
  { title: "Akquise", roots: [{ folder: "E - Akquise" }] },
  { title: "Leads", roots: [{ folder: "F - Leads" }] }
];

const sections = [];
for (const column of columns) {
  const lines = [`## ###### **${column.title}**`, ""];
  for (const root of column.roots) {
    const rootDir = path.join(projectsDir, root.folder);
    const entries = await projectEntries(rootDir, sharedDir);
    if (!entries.length) continue;

    if (root.heading) lines.push(`- [ ] **${root.heading}**`);
    let previousGroup = null;
    for (const entry of entries) {
      if (entry.group && entry.group !== previousGroup) {
        if (entry.group !== root.heading) lines.push(`- [ ] **${entry.group}**`);
        previousGroup = entry.group;
      }
      lines.push(`- [ ] [[${entry.target}|${entry.title}]]`);
    }
    lines.push("");
  }
  sections.push(lines.join("\n").trimEnd());
}

const output = `---
kanban-plugin: board
---

${sections.join("\n\n\n")}

%% kanban:settings
\`\`\`
{"kanban-plugin":"board","list-collapse":[false,false,false,false,false,false,false]}
\`\`\`
%%
`;

if (apply) {
  await fs.writeFile(targetFile, output, "utf8");
  console.log(`Updated ${targetFile}`);
} else {
  process.stdout.write(output);
}

async function projectEntries(rootDir, sharedRoot) {
  const files = await walkMarkdown(rootDir);
  return files
    .map((file) => {
      const relativeToRoot = path.relative(rootDir, file).replaceAll("\\", "/");
      const parts = relativeToRoot.split("/");
      const title = path.basename(file, ".md");
      const groupParts = parts.slice(0, -1).map(cleanFolderLabel);
      return {
        title,
        target: path.relative(sharedRoot, file).replaceAll("\\", "/").replace(/\.md$/i, ""),
        group: groupParts.join(" / "),
        sortKey: relativeToRoot
      };
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey, "de", { numeric: true, sensitivity: "base" }));
}

async function walkMarkdown(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkMarkdown(fullPath);
    return entry.isFile() && entry.name.toLowerCase().endsWith(".md") ? [fullPath] : [];
  }));
  return files.flat();
}

function cleanFolderLabel(value) {
  return String(value)
    .replace(/^[A-Z]?\d+\s*-\s*/i, "")
    .replaceAll("_", " ")
    .trim();
}
