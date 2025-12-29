// app.js (ESM)
import * as pdfjsLib from "https://unpkg.com/pdfjs-dist@4.6.82/build/pdf.min.mjs";

const $ = (id) => document.getElementById(id);

const CL_START_RE = /^\s*(?:п\.?\s*|пп\.?\s*|пункт\s*|подпункт\s*)?(?<num>\d+(?:\.\d+){0,6})\s*(?:[)\.\-–:]\s+|\s+)(?<rest>.*)$/i;
const WS_RE = /\s+/g;

function normalizeWS(s) {
  return (s || "").replace(WS_RE, " ").trim();
}
function excerpt(s, limit = 260) {
  const t = (s || "").trim();
  if (t.length <= limit) return t;
  return t.slice(0, limit).trimEnd() + "…";
}
function sortClauseRef(a, b) {
  const pa = a.split(".").map(x => parseInt(x, 10));
  const pb = b.split(".").map(x => parseInt(x, 10));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const va = (Number.isFinite(pa[i]) ? pa[i] : 1e9);
    const vb = (Number.isFinite(pb[i]) ? pb[i] : 1e9);
    if (va !== vb) return va - vb;
  }
  return a.localeCompare(b);
}

// Ratcliff/Obershelp similarity (близко к Python difflib.SequenceMatcher ratio)
function longestCommonSubstring(a, b) {
  const n = a.length, m = b.length;
  let bestLen = 0, bestEnd = 0;
  const prev = new Array(m + 1).fill(0);
  const curr = new Array(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > bestLen) {
          bestLen = curr[j];
          bestEnd = i;
        }
      } else {
        curr[j] = 0;
      }
    }
    for (let j = 0; j <= m; j++) prev[j] = curr[j];
  }
  return { bestLen, bestEnd };
}

function roMatches(a, b) {
  if (!a || !b) return 0;
  const { bestLen, bestEnd } = longestCommonSubstring(a, b);
  if (bestLen === 0) return 0;
  const aStart = bestEnd - bestLen;
  const mid = a.slice(aStart, bestEnd);
  const bStart = b.indexOf(mid);
  const left = roMatches(a.slice(0, aStart), b.slice(0, bStart));
  const right = roMatches(a.slice(bestEnd), b.slice(bStart + bestLen));
  return bestLen + left + right;
}

function similarityRatio(a, b) {
  const A = a || "", B = b || "";
  if (A.length === 0 && B.length === 0) return 1.0;
  const matches = roMatches(A, B);
  return (2 * matches) / (A.length + B.length);
}

function applyIgnore(text, ignoreRegexes) {
  let t = text || "";
  for (const rgx of ignoreRegexes) t = t.replace(rgx, "");
  return t;
}

function extractClausesFromText(text) {
  const lines = (text || "").split(/\r?\n/).map(l => l.replace(/\s+$/g, ""));
  const clauses = new Map();
  let current = null;

  for (const ln of lines) {
    if (!ln.trim()) {
      if (current && clauses.get(current)?.length) {
        const arr = clauses.get(current);
        if (arr[arr.length - 1] !== "") arr.push("");
      }
      continue;
    }
    const m = ln.match(CL_START_RE);
    if (m && m.groups?.num) {
      current = m.groups.num;
      if (!clauses.has(current)) clauses.set(current, []);
      const rest = (m.groups.rest || "").trim();
      if (rest) clauses.get(current).push(rest);
      continue;
    }
    if (!current) continue;
    clauses.get(current).push(ln.trim());
  }

  const out = new Map();
  for (const [k, parts] of clauses.entries()) {
    const joined = parts.join("\n");
    const norm = joined.split("\n").map(normalizeWS).join("\n").trim();
    out.set(k, norm);
  }
  return out;
}

async function docxToText(file) {
  const ab = await file.arrayBuffer();
  const res = await window.mammoth.extractRawText({ arrayBuffer: ab });
  return (res.value || "").trim();
}
async function pdfToText(file) {
  const ab = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: ab });
  const pdf = await loadingTask.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map(it => it.str).join(" "));
  }
  return pages.join("\n").trim();
}
async function fileToParsed(file) {
  const name = file.name.toLowerCase();
  let text = "";
  if (name.endsWith(".docx")) text = await docxToText(file);
  else if (name.endsWith(".pdf")) text = await pdfToText(file);
  else throw new Error("Unsupported file: " + file.name);
  return { text, clauses: extractClausesFromText(text) };
}

function compareClauses(etalonMap, clientMap, opts) {
  const diffs = [];
  const ignoreRegexes = opts.ignoreRegexes || [];
  const simThreshold = opts.similarityThreshold ?? 0.985;

  for (const [ref, etText] of etalonMap.entries()) {
    if (!clientMap.has(ref)) {
      diffs.push({ clause_ref: ref, diff_type: "MISSING", similarity: 0.0, etalon_excerpt: excerpt(etText), client_excerpt: "(отсутствует)" });
      continue;
    }
    const clText = clientMap.get(ref) || "";
    const a = normalizeWS(applyIgnore(etText, ignoreRegexes)).toLowerCase();
    const b = normalizeWS(applyIgnore(clText, ignoreRegexes)).toLowerCase();
    const sim = similarityRatio(a, b);
    if (sim < simThreshold) {
      diffs.push({ clause_ref: ref, diff_type: "CHANGED", similarity: sim, etalon_excerpt: excerpt(etText), client_excerpt: excerpt(clText) });
    }
  }
  for (const [ref, clText] of clientMap.entries()) {
    if (!etalonMap.has(ref)) {
      diffs.push({ clause_ref: ref, diff_type: "EXTRA", similarity: 0.0, etalon_excerpt: "(нет в эталоне)", client_excerpt: excerpt(clText) });
    }
  }
  diffs.sort((x, y) => {
    const c = sortClauseRef(x.clause_ref, y.clause_ref);
    return c !== 0 ? c : x.diff_type.localeCompare(y.diff_type);
  });
  return diffs;
}

function classifyStatus(diffs, criticalSet, criticalMinSim) {
  if (!diffs.length) return "OK";
  for (const d of diffs) {
    if (criticalSet.has(d.clause_ref)) {
      if (d.diff_type === "MISSING") return "NOT_APPLIED";
      if (d.diff_type === "CHANGED" && (d.similarity ?? 0) < criticalMinSim) return "NOT_APPLIED";
    }
  }
  return "DIFFS";
}

function badgeClass(status) {
  if (status === "OK") return "ok";
  if (status === "NOT_APPLIED") return "bad";
  if (status === "NEEDS_REVIEW") return "warn";
  return "warn";
}
function statusText(status) {
  if (status === "OK") return "OK";
  if (status === "NOT_APPLIED") return "изменения не внесены";
  if (status === "NEEDS_REVIEW") return "нужна ручная проверка";
  return "есть расхождения";
}

function buildSummary(results, maxDiffs, criticalSet) {
  const lines = [];
  results.forEach((r, idx) => {
    const i = idx + 1;
    if (r.status === "OK") {
      lines.push(`${i}. Контрагент "${r.name}": расхождений не выявлено, все изменения внесены`);
      lines.push("");
      return;
    }
    if (r.status === "NOT_APPLIED") lines.push(`${i}. Контрагент "${r.name}": изменения не внесены`);
    else if (r.status === "NEEDS_REVIEW") {
      lines.push(`${i}. Контрагент "${r.name}": требуется ручная проверка (не удалось извлечь текст/структуру)`);
      lines.push("");
      return;
    } else lines.push(`${i}. Контрагент "${r.name}": выявлены следующие расхождения:`);

    const diffs = [...r.diffs];
    diffs.sort((a,b) => {
      const ac = criticalSet.has(a.clause_ref) ? 0 : 1;
      const bc = criticalSet.has(b.clause_ref) ? 0 : 1;
      if (ac !== bc) return ac - bc;
      const am = a.diff_type === "MISSING" ? 0 : 1;
      const bm = b.diff_type === "MISSING" ? 0 : 1;
      if (am !== bm) return am - bm;
      return (a.similarity ?? 0) - (b.similarity ?? 0);
    });

    const shown = diffs.slice(0, maxDiffs);
    shown.forEach(d => {
      if (d.diff_type === "MISSING") lines.push(`- п. ${d.clause_ref}: отсутствует пункт из эталона`);
      else if (d.diff_type === "CHANGED") lines.push(`- п. ${d.clause_ref}: отличается формулировка (similarity=${(d.similarity||0).toFixed(3)})`);
      else lines.push(`- п. ${d.clause_ref}: есть у контрагента, отсутствует в эталоне`);

      if (criticalSet.has(d.clause_ref)) {
        lines.push(`  - Эталон: ${d.etalon_excerpt}`);
        lines.push(`  - Документ: ${d.client_excerpt}`);
      }
    });
    if (diffs.length > shown.length) lines.push(`  …и ещё ${diffs.length - shown.length} расхождений (полный список в results.json)`);
    lines.push("");
  });
  return lines.join("\n").trim() + "\n";
}

function downloadBlob(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

let etalonParsed = null;
let clientFiles = [];

function setRunEnabled() {
  $("runBtn").disabled = !(etalonParsed && clientFiles.length);
}

$("etalonFile").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  etalonParsed = null;
  $("etalonMeta").textContent = "";
  if (!f) { setRunEnabled(); return; }

  $("etalonMeta").textContent = "Читаю эталон…";
  try {
    const parsed = await fileToParsed(f);
    etalonParsed = { file: f, ...parsed };
    $("etalonMeta").textContent = `OK: текст ${parsed.text.length.toLocaleString("ru-RU")} символов, пунктов ${parsed.clauses.size}`;
  } catch (err) {
    console.error(err);
    $("etalonMeta").textContent = "Ошибка чтения эталона: " + (err?.message || err);
  }
  setRunEnabled();
});

$("clientFiles").addEventListener("change", (e) => {
  clientFiles = Array.from(e.target.files || []);
  $("clientsMeta").textContent = clientFiles.length ? `Выбрано файлов: ${clientFiles.length}` : "";
  setRunEnabled();
});

$("clearBtn").addEventListener("click", () => {
  $("etalonFile").value = "";
  $("clientFiles").value = "";
  $("criticalClauses").value = "";
  $("ignoreRegexes").value = "";
  $("summary").textContent = "Загрузите эталон и документы контрагентов, затем нажмите «Сравнить».";
  $("details").innerHTML = "";
  $("downloadTxt").disabled = true;
  $("downloadJson").disabled = true;
  $("etalonMeta").textContent = "";
  $("clientsMeta").textContent = "";
  etalonParsed = null;
  clientFiles = [];
  setRunEnabled();
});

$("runBtn").addEventListener("click", async () => {
  $("summary").textContent = "Сравниваю…";
  $("details").innerHTML = "";
  $("downloadTxt").disabled = true;
  $("downloadJson").disabled = true;

  const criticalSet = new Set(($("criticalClauses").value || "").split(",").map(s => s.trim()).filter(Boolean));
  const similarityThreshold = parseFloat($("similarityThreshold").value || "0.985");
  const criticalMinSim = parseFloat($("criticalMinSim").value || "0.97");
  const maxDiffs = Math.max(1, parseInt($("maxDiffs").value || "25", 10));

  const ignoreLines = ($("ignoreRegexes").value || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const ignoreRegexes = [];
  for (const line of ignoreLines) {
    try { ignoreRegexes.push(new RegExp(line, "ig")); } catch {}
  }

  const results = [];
  for (const f of clientFiles) {
    const name = f.name.replace(/\.(docx|pdf)$/i, "");
    try {
      const parsed = await fileToParsed(f);
      if (!parsed.text || parsed.text.length < 50 || parsed.clauses.size === 0) {
        results.push({ name, status: "NEEDS_REVIEW", diffs: [], source_file: f.name });
        continue;
      }
      const diffs = compareClauses(etalonParsed.clauses, parsed.clauses, { similarityThreshold, ignoreRegexes });
      const status = classifyStatus(diffs, criticalSet, criticalMinSim);
      results.push({ name, status, diffs, source_file: f.name });
    } catch (err) {
      console.error(err);
      results.push({ name, status: "NEEDS_REVIEW", diffs: [], source_file: f.name, error: err?.message || String(err) });
    }
  }

  const summary = buildSummary(results, maxDiffs, criticalSet);
  $("summary").textContent = summary;

  const details = $("details");
  results.forEach(r => {
    const div = document.createElement("div");
    div.className = "item";
    const h = document.createElement("h4");
    h.textContent = r.name;
    const badge = document.createElement("span");
    badge.className = "badge " + badgeClass(r.status);
    badge.textContent = statusText(r.status);
    h.appendChild(badge);
    div.appendChild(h);

    const meta = document.createElement("div");
    meta.className = "small";
    meta.textContent = `Файл: ${r.source_file} • Расхождений: ${r.diffs.length}`;
    div.appendChild(meta);

    if (r.diffs.length) {
      const dWrap = document.createElement("div");
      dWrap.className = "diff";
      const top = r.diffs.slice(0, 12);
      top.forEach(d => {
        const p = document.createElement("div");
        const isCrit = criticalSet.has(d.clause_ref);
        const title = isCrit ? `п. ${d.clause_ref} (CRITICAL)` : `п. ${d.clause_ref}`;
        p.innerHTML = `<div><b>${title}</b> — ${d.diff_type}${d.diff_type==="CHANGED" ? ` (sim=${(d.similarity||0).toFixed(3)})` : ""}</div>`;
        const e1 = document.createElement("code"); e1.textContent = "Эталон: " + d.etalon_excerpt;
        const e2 = document.createElement("code"); e2.textContent = "Документ: " + d.client_excerpt;
        p.appendChild(e1); p.appendChild(e2);
        dWrap.appendChild(p);
      });
      if (r.diffs.length > top.length) {
        const more = document.createElement("div");
        more.className = "small";
        more.textContent = `…ещё ${r.diffs.length - top.length} (полный список в results.json)`;
        dWrap.appendChild(more);
      }
      div.appendChild(dWrap);
    }

    details.appendChild(div);
  });

  $("downloadTxt").disabled = false;
  $("downloadJson").disabled = false;
  $("downloadTxt").onclick = () => downloadBlob("summary.txt", summary, "text/plain;charset=utf-8");
  $("downloadJson").onclick = () => downloadBlob("results.json", JSON.stringify(results, null, 2), "application/json;charset=utf-8");
});
