// app.js (ESM)
import * as pdfjsLib from "https://unpkg.com/pdfjs-dist@4.6.82/build/pdf.min.mjs";

const $ = (id) => document.getElementById(id);

function setSummary(text){
  const el = document.getElementById("summary");
  if (el) el.textContent = text;
}

function setStatus(text){
  const el = document.getElementById("statusLine");
  if (el) el.textContent = text;
}


// Clause heading pattern: "2.4 ..." / "п. 2.4 ..." etc.
const CL_START_RE = /^\s*(?:п\.?\s*|пп\.?\s*|пункт\s*|подпункт\s*)?(?<num>\d+(?:\.\d+){0,6})\s*(?:[)\.\-–:]\s+|\s+)(?<rest>.*)$/i;
const WS_RE = /\s+/g;

function normalizeWS(s){ return (s||"").replace(WS_RE," ").trim(); }

function applyIgnore(text, ignoreRegexes){
  let t = text || "";
  for(const rgx of ignoreRegexes) t = t.replace(rgx,"");
  return t;
}

function sortClauseRef(a,b){
  const pa=a.split(".").map(x=>parseInt(x,10));
  const pb=b.split(".").map(x=>parseInt(x,10));
  const n=Math.max(pa.length,pb.length);
  for(let i=0;i<n;i++){
    const va=Number.isFinite(pa[i])?pa[i]:1e9;
    const vb=Number.isFinite(pb[i])?pb[i]:1e9;
    if(va!==vb) return va-vb;
  }
  return a.localeCompare(b);
}

// Ratcliff/Obershelp similarity (close to Python difflib.SequenceMatcher)
function longestCommonSubstring(a,b){
  const n=a.length, m=b.length;
  let bestLen=0, bestEnd=0;
  const prev=new Array(m+1).fill(0);
  const curr=new Array(m+1).fill(0);
  for(let i=1;i<=n;i++){
    for(let j=1;j<=m;j++){
      if(a[i-1]===b[j-1]){
        curr[j]=prev[j-1]+1;
        if(curr[j]>bestLen){bestLen=curr[j];bestEnd=i;}
      }else curr[j]=0;
    }
    for(let j=0;j<=m;j++) prev[j]=curr[j];
  }
  return {bestLen,bestEnd};
}
function roMatches(a,b){
  if(!a||!b) return 0;
  const {bestLen,bestEnd}=longestCommonSubstring(a,b);
  if(bestLen===0) return 0;
  const aStart=bestEnd-bestLen;
  const mid=a.slice(aStart,bestEnd);
  const bStart=b.indexOf(mid);
  const left=roMatches(a.slice(0,aStart), b.slice(0,bStart));
  const right=roMatches(a.slice(bestEnd), b.slice(bStart+bestLen));
  return bestLen+left+right;
}
function similarityRatio(a,b){
  const A=a||"", B=b||"";
  if(!A && !B) return 1.0;
  const matches=roMatches(A,B);
  return (2*matches)/(A.length+B.length);
}

// ---- parsing ----
async function docxToText(file){
  const ab = await file.arrayBuffer();
  const res = await window.mammoth.extractRawText({ arrayBuffer: ab });
  return (res.value || "").trim();
}
async function pdfToText(file){
  const ab = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: ab });
  const pdf = await loadingTask.promise;
  const pages = [];
  for(let i=1;i<=pdf.numPages;i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map(it=>it.str).join(" "));
  }
  return pages.join("\n").trim();
}
function extractClausesFromText(text){
  const lines=(text||"").split(/\r?\n/).map(l=>l.replace(/\s+$/g,""));
  const clauses=new Map();
  let current=null;
  for(const ln of lines){
    if(!ln.trim()) continue;
    const m=ln.match(CL_START_RE);
    if(m && m.groups?.num){
      current=m.groups.num;
      if(!clauses.has(current)) clauses.set(current, []);
      const rest=(m.groups.rest||"").trim();
      if(rest) clauses.get(current).push(rest);
      continue;
    }
    if(!current) continue;
    clauses.get(current).push(ln.trim());
  }
  const out=new Map();
  for(const [k, parts] of clauses.entries()){
    const joined=parts.join("\n");
    out.set(k, joined.trim());
  }
  return out;
}
async function fileToParsed(file){
  const name=file.name.toLowerCase();
  let text="";
  if(name.endsWith(".docx")) text=await docxToText(file);
  else if(name.endsWith(".pdf")) text=await pdfToText(file);
  else throw new Error("Unsupported file: "+file.name);
  return { text, clauses: extractClausesFromText(text) };
}

// ---- compare ----
function compareClauses(etalonMap, clientMap, opts){
  const diffs=[];
  const ignoreRegexes=opts.ignoreRegexes||[];
  const simThreshold=opts.similarityThreshold ?? 0.985;

  // missing / changed
  for(const [ref, etText] of etalonMap.entries()){
    if(!clientMap.has(ref)){
      diffs.push({ clause_ref: ref, diff_type: "MISSING" });
      continue;
    }
    const clText=clientMap.get(ref) || "";
    const a = normalizeWS(applyIgnore(etText, ignoreRegexes)).toLowerCase();
    const b = normalizeWS(applyIgnore(clText, ignoreRegexes)).toLowerCase();
    const sim = similarityRatio(a,b);
    if(sim < simThreshold){
      diffs.push({ clause_ref: ref, diff_type: "CHANGED", similarity: sim });
    }
  }

  // extra
  for(const [ref] of clientMap.entries()){
    if(!etalonMap.has(ref)){
      diffs.push({ clause_ref: ref, diff_type: "EXTRA" });
    }
  }

  diffs.sort((x,y)=> {
    const c=sortClauseRef(x.clause_ref, y.clause_ref);
    return c!==0?c:x.diff_type.localeCompare(y.diff_type);
  });
  return diffs;
}

function classifyStatus(diffs, criticalSet, criticalMinSim){
  if(!diffs.length) return "OK";
  for(const d of diffs){
    if(criticalSet.has(d.clause_ref)){
      if(d.diff_type==="MISSING") return "NOT_APPLIED";
      if(d.diff_type==="CHANGED" && (d.similarity ?? 0) < criticalMinSim) return "NOT_APPLIED";
    }
  }
  return "DIFFS";
}

function badgeClass(status){
  if(status==="OK") return "ok";
  if(status==="NOT_APPLIED") return "bad";
  if(status==="NEEDS_REVIEW") return "warn";
  return "warn";
}
function statusText(status){
  if(status==="OK") return "всё внесено";
  if(status==="NOT_APPLIED") return "изменения не внесены";
  if(status==="NEEDS_REVIEW") return "нужна ручная проверка";
  return "есть расхождения";
}

function pillClass(t){
  if(t==="MISSING") return "missing";
  if(t==="EXTRA") return "extra";
  return "changed";
}

// ---- inline diff rendering (split view) ----
// Uses global Diff from jsdiff (cdnjs).
function splitDiffHtml(leftText, rightText){
  const parts = window.Diff.diffWordsWithSpace(leftText || "", rightText || "");
  let leftHtml = "";
  let rightHtml = "";
  for(const p of parts){
    const safe = escapeHtml(p.value);
    if(p.added){
      // appears only in right
      rightHtml += `<span class="added">${safe}</span>`;
    } else if(p.removed){
      // appears only in left
      leftHtml += `<span class="removed">${safe}</span>`;
    } else {
      leftHtml += safe;
      rightHtml += safe;
    }
  }
  return { leftHtml, rightHtml };
}

function escapeHtml(s){
  return (s||"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// ---- DOCX export (one file per counterparty) ----
function sanitizeFilename(name){
  return (name||"контрагент").replace(/[\\/:*?"<>|]+/g, "_").trim() || "контрагент";
}

function textRunsFromDiffParts(parts, side){
  // side: "left" shows removed; "right" shows added
  const runs = [];
  for(const p of parts){
    const val = p.value || "";
    const isAdded = !!p.added;
    const isRemoved = !!p.removed;
    if(side==="left" && isAdded) continue;
    if(side==="right" && isRemoved) continue;

    const style = {};
    if(side==="left" && isRemoved) style.strike = true;
    if(side==="right" && isAdded) style.bold = true;

    // preserve \n using break runs
    const lines = val.split("\n");
    for(let i=0;i<lines.length;i++){
      const text = lines[i];
      if(i===0){
        runs.push(new window.docx.TextRun({ text, ...style }));
      } else {
        runs.push(new window.docx.TextRun({ text, break: 1, ...style }));
      }
    }
  }
  if(!runs.length) runs.push(new window.docx.TextRun(""));
  return runs;
}

async function exportCounterpartyDocx(counterparty, etalonClauses, clientClauses, criticalSet){
  const d = window.docx;
  const children = [];

  children.push(new d.Paragraph({ text: `Контрагент: ${counterparty.name}`, heading: d.HeadingLevel.HEADING_1 }));
  children.push(new d.Paragraph({ text: `Статус: ${statusText(counterparty.status)} (${counterparty.status})` }));
  if(counterparty.source_file) children.push(new d.Paragraph({ text: `Файл: ${counterparty.source_file}`, spacing: { after: 200 }}));

  const diffs = counterparty.diffs || [];
  if(!diffs.length){
    children.push(new d.Paragraph({ text: "Расхождений не выявлено.", spacing: { before: 200 }}));
  } else {
    for(const item of diffs){
      const ref = item.clause_ref;
      const typ = item.diff_type;
      const isCrit = criticalSet.has(ref);

      children.push(new d.Paragraph({
        text: `п. ${ref} — ${typ}${isCrit ? " (CRITICAL)" : ""}`,
        heading: d.HeadingLevel.HEADING_2,
        spacing: { before: 250, after: 120 }
      }));

      let leftText = "";
      let rightText = "";
      if(typ==="MISSING"){
        leftText = etalonClauses.get(ref) || "";
        rightText = "— отсутствует —";
      } else if(typ==="EXTRA"){
        leftText = "— отсутствует —";
        rightText = clientClauses.get(ref) || "";
      } else {
        leftText = etalonClauses.get(ref) || "";
        rightText = clientClauses.get(ref) || "";
      }

      // Build table with 2 columns: Etalon vs Document
      const tableRows = [];

      // header row
      tableRows.push(new d.TableRow({
        children: [
          new d.TableCell({
            width: { size: 50, type: d.WidthType.PERCENTAGE },
            children: [ new d.Paragraph({ text: "Эталон", bold: true }) ],
          }),
          new d.TableCell({
            width: { size: 50, type: d.WidthType.PERCENTAGE },
            children: [ new d.Paragraph({ text: "Документ", bold: true }) ],
          }),
        ],
      }));

      if(typ==="CHANGED"){
        const parts = window.Diff.diffWordsWithSpace(leftText, rightText);
        const leftRuns = textRunsFromDiffParts(parts, "left");
        const rightRuns = textRunsFromDiffParts(parts, "right");

        tableRows.push(new d.TableRow({
          children: [
            new d.TableCell({
              width: { size: 50, type: d.WidthType.PERCENTAGE },
              children: [ new d.Paragraph({ children: leftRuns }) ],
            }),
            new d.TableCell({
              width: { size: 50, type: d.WidthType.PERCENTAGE },
              children: [ new d.Paragraph({ children: rightRuns }) ],
            }),
          ],
        }));
      } else {
        // no diff, just full texts
        tableRows.push(new d.TableRow({
          children: [
            new d.TableCell({
              width: { size: 50, type: d.WidthType.PERCENTAGE },
              children: [ new d.Paragraph({ children: textRunsFromDiffParts([{value:leftText}], "left") }) ],
            }),
            new d.TableCell({
              width: { size: 50, type: d.WidthType.PERCENTAGE },
              children: [ new d.Paragraph({ children: textRunsFromDiffParts([{value:rightText}], "right") }) ],
            }),
          ],
        }));
      }

      const table = new d.Table({
        width: { size: 100, type: d.WidthType.PERCENTAGE },
        rows: tableRows,
      });

      children.push(table);

      if(item.similarity !== undefined && typ==="CHANGED"){
        children.push(new d.Paragraph({ text: `Similarity: ${(item.similarity||0).toFixed(3)}`, spacing: { before: 80 } }));
      }
    }
  }

  const doc = new d.Document({
    sections: [{ properties: {}, children }],
  });

  const blob = await d.Packer.toBlob(doc);
  const filename = sanitizeFilename(counterparty.name) + ".docx";
  downloadBlob(filename, blob);
}

// ---- UI ----
let etalonParsed = null;
let clientFiles = [];
let lastRunState = null; // store parsed maps for docx export per client

function setRunEnabled(){
  $("runBtn").disabled = !(etalonParsed && clientFiles.length);
}

$("etalonFile").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  etalonParsed = null;
  $("etalonMeta").textContent = "";
  if(!f){ setRunEnabled(); return; }

  $("etalonMeta").textContent = "Читаю эталон…";
  try{
    const parsed = await fileToParsed(f);
    etalonParsed = { file: f, ...parsed };
    $("etalonMeta").textContent = `OK: ${parsed.text.length.toLocaleString("ru-RU")} символов, пунктов ${parsed.clauses.size}`;
  }catch(err){
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
  setStatus("");
  setSummary("Загрузите эталон и документы, затем нажмите «Сравнить».");
  $("results").innerHTML = "";
  $("etalonMeta").textContent = "";
  $("clientsMeta").textContent = "";
  etalonParsed = null;
  clientFiles = [];
  lastRunState = null;
  setRunEnabled();
});

$("runBtn").addEventListener("click", async () => {
  setStatus("Думаю...");
  setSummary("");
  $("results").innerHTML = "";
  lastRunState = { clients: new Map() };

  const criticalSet = new Set(($("criticalClauses").value || "").split(",").map(s=>s.trim()).filter(Boolean));
  const similarityThreshold = parseFloat($("similarityThreshold").value || "0.985");
  const criticalMinSim = parseFloat($("criticalMinSim").value || "0.97");

  const ignoreLines = ($("ignoreRegexes").value || "").split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const ignoreRegexes = [];
  for(const line of ignoreLines){
    try{ ignoreRegexes.push(new RegExp(line, "ig")); }catch{}
  }

  const results = [];
  for(const f of clientFiles){
    const name = f.name.replace(/\.(docx|pdf)$/i, "");
    try{
      const parsed = await fileToParsed(f);
      if(!parsed.text || parsed.text.length < 50 || parsed.clauses.size === 0){
        results.push({ name, status: "NEEDS_REVIEW", diffs: [], source_file: f.name });
        continue;
      }
      const diffs = compareClauses(etalonParsed.clauses, parsed.clauses, { similarityThreshold, ignoreRegexes });
      const status = classifyStatus(diffs, criticalSet, criticalMinSim);
      results.push({ name, status, diffs, source_file: f.name });
      lastRunState.clients.set(name, { file: f, parsed });
    }catch(err){
      console.error(err);
      results.push({ name, status: "NEEDS_REVIEW", diffs: [], source_file: f.name, error: err?.message || String(err) });
    }
  }

  renderSummary(results);
  renderResults(results, criticalSet);
  lastRunState.criticalSet = criticalSet;

  setStatus("");
});

function renderSummary(results){
  // Сводная строка убрана по запросу.
  setSummary("");
}

function renderResults(results, criticalSet){
  const root = $("results");

  results.forEach((r, idx) => {
    const wrap = document.createElement("section");
    wrap.className = "counterparty";

    const header = document.createElement("div");
    header.className = "counterparty-header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "counterparty-title";
    const h3 = document.createElement("h3");
    h3.textContent = `${idx+1}. ${r.name}`;
    const badge = document.createElement("span");
    badge.className = "badge " + badgeClass(r.status);
    badge.textContent = statusText(r.status);
    titleWrap.appendChild(h3);
    titleWrap.appendChild(badge);

    header.appendChild(titleWrap);

    const actions = document.createElement("div");
    actions.className = "actions";
    const btnDocx = document.createElement("button");
    btnDocx.textContent = "Скачать DOCX";
    btnDocx.disabled = (r.status === "NEEDS_REVIEW"); // still allow? but no
    btnDocx.onclick = async () => {
      const client = lastRunState?.clients?.get(r.name);
      if(!client){
        alert("Не найдено состояние сравнения для этого контрагента. Запустите сравнение заново.");
        return;
      }
      btnDocx.disabled = true;
      btnDocx.textContent = "Генерация…";
      try{
        await exportCounterpartyDocx(r, etalonParsed.clauses, client.parsed.clauses, criticalSet);
      }finally{
        btnDocx.disabled = (r.status === "NEEDS_REVIEW");
        btnDocx.textContent = "Скачать DOCX";
      }
    };
    actions.appendChild(btnDocx);
    header.appendChild(actions);

    wrap.appendChild(header);

    const meta = document.createElement("div");
    meta.className = "small";
    meta.textContent = `Файл: ${r.source_file} • Расхождений: ${r.diffs.length}`;
    wrap.appendChild(meta);

    if(r.diffs.length){
      const diffsWrap = document.createElement("div");
      diffsWrap.className = "diffs";

      r.diffs.forEach((d) => {
        const det = document.createElement("details");
        det.className = "diff-item";

        const sum = document.createElement("summary");
        const left = document.createElement("div");
        left.className = "meta-row";
        const ref = document.createElement("span");
        ref.textContent = `п. ${d.clause_ref}`;
        const pill = document.createElement("span");
        pill.className = "pill " + pillClass(d.diff_type);
        pill.textContent = d.diff_type;
        left.appendChild(ref);
        left.appendChild(pill);

        if(criticalSet.has(d.clause_ref)){
          const crit = document.createElement("span");
          crit.className = "pill";
          crit.textContent = "CRITICAL";
          left.appendChild(crit);
        }

        sum.appendChild(left);

        const rightMeta = document.createElement("div");
        rightMeta.className = "small";
        if(d.diff_type === "CHANGED" && d.similarity !== undefined){
          rightMeta.textContent = `similarity=${(d.similarity||0).toFixed(3)}`;
        } else {
          rightMeta.textContent = "";
        }
        sum.appendChild(rightMeta);

        det.appendChild(sum);

        const content = document.createElement("div");
        content.className = "split";
        content.dataset.rendered = "0";

        const colL = document.createElement("div");
        colL.className = "col";
        const hL = document.createElement("h4");
        hL.textContent = "Эталон";
        const tL = document.createElement("div");
        tL.className = "text";
        tL.textContent = "…";
        colL.appendChild(hL);
        colL.appendChild(tL);

        const colR = document.createElement("div");
        colR.className = "col";
        const hR = document.createElement("h4");
        hR.textContent = "Документ";
        const tR = document.createElement("div");
        tR.className = "text";
        tR.textContent = "…";
        colR.appendChild(hR);
        colR.appendChild(tR);

        content.appendChild(colL);
        content.appendChild(colR);
        det.appendChild(content);

        det.addEventListener("toggle", () => {
          if(!det.open) return;
          if(content.dataset.rendered === "1") return;

          // Lazy render: compute split diff/full text
          const client = lastRunState?.clients?.get(r.name);
          const et = etalonParsed?.clauses;
          const cl = client?.parsed?.clauses;

          let leftText = "";
          let rightText = "";
          if(d.diff_type === "MISSING"){
            leftText = et?.get(d.clause_ref) || "";
            rightText = "— отсутствует —";
            tL.textContent = leftText;
            tR.textContent = rightText;
          } else if(d.diff_type === "EXTRA"){
            leftText = "— отсутствует —";
            rightText = cl?.get(d.clause_ref) || "";
            tL.textContent = leftText;
            tR.textContent = rightText;
          } else {
            leftText = et?.get(d.clause_ref) || "";
            rightText = cl?.get(d.clause_ref) || "";
            const { leftHtml, rightHtml } = splitDiffHtml(leftText, rightText);
            tL.innerHTML = leftHtml;
            tR.innerHTML = rightHtml;
          }

          content.dataset.rendered = "1";
        });

        diffsWrap.appendChild(det);
      });

      wrap.appendChild(diffsWrap);
    }

    root.appendChild(wrap);
  });
}

// Simple blob downloader for docx export
function downloadBlob(filename, blob){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}