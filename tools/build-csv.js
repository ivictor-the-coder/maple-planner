// Renders guide-graph.json into a compact CSV for Google Sheets upload.
// Usage: node build-csv.js [outputPath]
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const graph = JSON.parse(fs.readFileSync(path.join(DIR, "guide-graph.json"), "utf8"));
const OUT = process.argv[2] || path.join(DIR, "MapleStory-Progression-Guide.csv");

function q(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const line = (arr) => arr.map(q).join(",");

const out = [];
const tabs = [...graph.tabs].sort((a, b) => a.order - b.order);

out.push(line([graph.meta.title, graph.meta.gameVersion, graph.meta.gameVersionName]));
out.push(line(["patch " + graph.meta.patchDate, "built " + graph.meta.lastBuilt, graph.meta.region + " / " + graph.meta.worldAssumption]));
out.push("");

for (const tab of tabs) {
  const nodes = graph.nodes.filter((n) => n.tab === tab.id);
  if (!nodes.length) continue;
  out.push(line(["## " + tab.name.toUpperCase()]));
  for (const node of nodes) {
    out.push(line(["# " + node.title]));
    if (node.type === "table" && node.headers) {
      out.push(line(node.headers));
      for (const r of node.rows) out.push(line(r));
    } else {
      for (const r of node.rows) out.push(line([Array.isArray(r) ? r[0] : r]));
    }
    if (node.notes) out.push(line(["NOTE", node.notes]));
    out.push(line(["src", node.source + " | verified " + node.lastVerified + " | " + node.patchVersion + " | " + node.id]));
    out.push("");
  }
}

const csv = out.join("\n");
fs.writeFileSync(OUT, csv, "utf8");
console.log("wrote " + OUT);
console.log("chars: " + csv.length + ", lines: " + out.length);
