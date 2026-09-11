// Renders guide-graph.json into a multi-tab .xlsx.
// Usage: node build-sheet.js [outputPath]
// The graph is the source of truth; this file only draws it.

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const DIR = __dirname;
const GRAPH = path.join(DIR, "guide-graph.json");
const OUT = process.argv[2] || path.join(DIR, "MapleStory-Progression-Guide.xlsx");

const INK = "FF12201C";
const HEADER_BG = "FF1E4A40";
const HEADER_FG = "FFF2F7F4";
const TITLE_FG = "FF1E4A40";
const BAND = "FFEDF3F0";
const MUTED = "FF6B7A74";
const RULE = "FFC7D4CD";

function thin(color) {
  return { style: "thin", color: { argb: color } };
}

function build() {
  const graph = JSON.parse(fs.readFileSync(GRAPH, "utf8"));
  const wb = new ExcelJS.Workbook();
  wb.creator = "MapleStory guide builder";
  wb.created = new Date();

  const tabs = [...graph.tabs].sort((a, b) => a.order - b.order);

  for (const tab of tabs) {
    const nodes = graph.nodes.filter((n) => n.tab === tab.id);
    const ws = wb.addWorksheet(tab.name, {
      views: [{ state: "frozen", ySplit: 2 }],
      properties: { defaultRowHeight: 16 },
    });

    // --- sheet masthead ---
    const mast = ws.addRow([tab.name.toUpperCase()]);
    mast.font = { name: "Calibri", size: 15, bold: true, color: { argb: TITLE_FG } };
    mast.height = 24;

    const sub = ws.addRow([
      `${graph.meta.gameVersion} — ${graph.meta.gameVersionName}   ·   patch ${graph.meta.patchDate}   ·   built ${graph.meta.lastBuilt}   ·   ${graph.meta.region}, ${graph.meta.worldAssumption}`,
    ]);
    sub.font = { name: "Calibri", size: 9, italic: true, color: { argb: MUTED } };
    ws.addRow([]);

    const widths = [];
    const noteRows = [];

    function track(values) {
      values.forEach((v, i) => {
        const len = String(v == null ? "" : v).length;
        widths[i] = Math.max(widths[i] || 0, len);
      });
    }

    for (const node of nodes) {
      // section title
      const t = ws.addRow([node.title]);
      t.font = { name: "Calibri", size: 12, bold: true, color: { argb: TITLE_FG } };
      t.height = 20;
      t.getCell(1).border = { bottom: thin(RULE) };

      if (node.type === "table" && node.headers) {
        const hr = ws.addRow(node.headers);
        hr.font = { name: "Calibri", size: 10, bold: true, color: { argb: HEADER_FG } };
        hr.height = 18;
        node.headers.forEach((_, i) => {
          const c = hr.getCell(i + 1);
          c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_BG } };
          c.alignment = { vertical: "middle", wrapText: true };
        });
        track(node.headers);

        node.rows.forEach((r, idx) => {
          const dr = ws.addRow(r);
          dr.font = { name: "Calibri", size: 10, color: { argb: INK } };
          r.forEach((_, i) => {
            const c = dr.getCell(i + 1);
            c.alignment = { vertical: "top", wrapText: true };
            c.border = { bottom: thin(RULE) };
            if (idx % 2 === 1) {
              c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
            }
          });
          track(r);
        });
      } else {
        // list: one column of statements
        node.rows.forEach((r) => {
          const text = Array.isArray(r) ? r[0] : r;
          const dr = ws.addRow(["•", text]);
          dr.font = { name: "Calibri", size: 10, color: { argb: INK } };
          dr.getCell(1).alignment = { vertical: "top", horizontal: "center" };
          dr.getCell(2).alignment = { vertical: "top", wrapText: true };
          track(["•", text]);
        });
      }

      if (node.notes) {
        const nr = ws.addRow(["", node.notes]);
        nr.font = { name: "Calibri", size: 9, italic: true, color: { argb: MUTED } };
        nr.getCell(2).alignment = { vertical: "top", wrapText: true };
        noteRows.push(nr.number);
        track(["", node.notes]);
      }

      const meta = ws.addRow([
        "",
        `source: ${node.source}   ·   verified: ${node.lastVerified}   ·   ${node.patchVersion}   ·   id: ${node.id}`,
      ]);
      meta.font = { name: "Calibri", size: 8, color: { argb: MUTED } };
      ws.addRow([]);
    }

    // --- column widths ---
    const MAXW = 62;
    ws.columns.forEach((col, i) => {
      let w = (widths[i] || 12) + 3;
      if (w > MAXW) w = MAXW;
      if (w < 10) w = 10;
      col.width = w;
    });
    // the long prose column in list sections should not be starved
    if (ws.columnCount >= 2 && (ws.getColumn(2).width || 0) < 40) {
      ws.getColumn(2).width = Math.min(MAXW, Math.max(40, ws.getColumn(2).width || 0));
    }
    ws.getColumn(1).width = Math.min(ws.getColumn(1).width || 12, 40);

    // notes rows span the sheet more comfortably
    noteRows.forEach((rn) => {
      const last = Math.max(2, ws.columnCount);
      try {
        ws.mergeCells(rn, 2, rn, last);
      } catch (e) {
        /* already merged or single column */
      }
    });
  }

  return wb.xlsx.writeFile(OUT).then(() => {
    console.log("wrote " + OUT);
    console.log("tabs: " + tabs.length + ", nodes: " + graph.nodes.length);
  });
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
