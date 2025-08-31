

#!/usr/bin/env node
/* eslint-disable no-console */
const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// 1) Servir les fichiers index.html, app.js, style.css
app.use(express.static(__dirname));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ====== health & diag ======
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/diag", (_req, res) => {
  const webtoonPath = path.join(__dirname, "webtoon.js");
  res.json({
    node: process.version,
    cwd: process.cwd(),
    exists_webtoon_js: fs.existsSync(webtoonPath),
    webtoon_path: webtoonPath,
    env: {
      PUPPETEER_EXECUTABLE_PATH: !!process.env.PUPPETEER_EXECUTABLE_PATH,
      CHROME_PATH: !!process.env.CHROME_PATH,
      PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR || null
    }
  });
});

// ====== util nom de dossier ======
function dirFromUrlSmart(href) {
  const _sanitize = (s) =>
    s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/gi, "-").replace(/-+/g, "-")
      .replace(/^-|-$/g, "").toLowerCase().slice(0, 80);
  const isMeaningful = (t) =>
    t && ![
      "viewer","read","reader","manga","comic","webtoon","webtoons",
      "series","title","chapters","chapter","episode","ep","view","fr","en","es","ko"
    ].includes(t.toLowerCase());
  try {
    const u = new URL(href);
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const L = parts.length;
    const epRegexes = [
      /(ep|episode)[\s\-_]*([0-9]+)$/i,
      /(ch|chap|chapter)[\s\-_]*([0-9]+)$/i,
      /^([0-9]+)$/i,
    ];
    let epToken = "";
    for (let i = L - 1; i >= 0 && !epToken; i--) {
      for (const rx of epRegexes) {
        const m = parts[i].match(rx);
        if (m) {
          const num = m[2] || m[1];
          const tag = (m[1] || "").toLowerCase();
          const prefix = /chap|chapter|ch/i.test(tag) ? "ch" : "ep";
          epToken = `${prefix}${num}`;
          break;
        }
      }
    }
    if (!epToken) {
      const q = ["episode_no", "ep", "episode", "chapter", "ch"]
        .map((k) => u.searchParams.get(k))
        .find((v) => v && /^\d+$/.test(v));
      if (q) epToken = `ep${q}`;
    }
    let series = "";
    if (epToken) {
      let epIdx = -1;
      for (let i = L - 1; i >= 0 && epIdx === -1; i--) {
        if (
          new RegExp(
            epToken
              .replace(/^ep/i, "(ep|episode)")
              .replace(/^ch/i, "(ch|chap|chapter)"),
            "i",
          ).test(parts[i])
        ) epIdx = i;
      }
      const candidates = (epIdx > 0 ? parts.slice(0, epIdx) : parts).filter(isMeaningful);
      const tail = candidates.slice(-2).filter(isMeaningful);
      series = _sanitize(tail.join("-")) || "episode";
    } else {
      const tail = parts.filter(isMeaningful).slice(-2);
      series = _sanitize(tail.join("-")) || "episode";
    }
    let base = series;
    if (epToken) {
      const epSan = _sanitize(epToken);
      if (!new RegExp(`(^|-)${epSan}(-|$)`).test(base)) base += `-${epSan}`;
    }
    return base || "episode";
  } catch {
    return "episode";
  }
}

// ====== SSE ======
const clients = new Map(); // jobId -> Set(res)
const jobs = new Map();    // jobId -> { status, pdfPath, outDir, fileName, errorMessage }

// émettre aux abonnés SSE
function sendEvent(jobId, event) {
  const subs = clients.get(jobId);
  if (!subs) return;
  const data = typeof event === "string" ? event : JSON.stringify(event);
  for (const res of subs) res.write(`data: ${data}\n\n`);
}

app.get("/events/:jobId", (req, res) => {
  const { jobId } = req.params;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write("retry: 1000\n\n");
  const hb = setInterval(() => { res.write(": ping\n\n"); }, 15000);

  if (!clients.has(jobId)) clients.set(jobId, new Set());
  clients.get(jobId).add(res);

  req.on("close", () => {
    clearInterval(hb);
    clients.get(jobId)?.delete(res);
    if (clients.get(jobId)?.size === 0) clients.delete(jobId);
  });
}); // <-- on ferme BIEN la route SSE ici

// ====== helper persistance meta ======
function saveMeta(job) {
  try {
    const metaPath = path.join(job.outDir, "meta.json");
    fs.writeFileSync(metaPath, JSON.stringify(job, null, 2));
  } catch {}
}

// ====== Lancement job ======
app.post("/start", (req, res) => {
  try {
    const { url, debug = false, wait = 0 } = req.body || {};
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "URL manquante ou invalide" });
    }

    const scriptPath = path.join(__dirname, "webtoon.js");
    if (!fs.existsSync(scriptPath)) {
      console.error("webtoon.js introuvable:", scriptPath);
      return res.status(500).json({ error: "webtoon.js introuvable sur le serveur" });
    }

    const jobId = Date.now().toString();
    const seriesDir = dirFromUrlSmart(url);
    const outDir = path.join(__dirname, "jobs", jobId, seriesDir);
    const fileName = `${seriesDir}.pdf`;
    const pdfPath = path.join(outDir, fileName);

    fs.mkdirSync(outDir, { recursive: true }); // créer d'abord le dossier
    const logErrPath = path.join(outDir, "stderr.log");
    fs.writeFileSync(logErrPath, ""); // reset log d'erreur du job

    const initMeta = { status: "started", pdfPath, outDir, fileName, errorMessage: null };
    jobs.set(jobId, initMeta);
    saveMeta(initMeta);

    const args = [scriptPath, url, outDir, fileName];
    if (debug) args.push("--debug");
    if (wait && Number(wait) > 0) args.push(`--wait=${Number(wait)}`);

    console.log("Spawning:", process.execPath, args.join(" "));
    const child = spawn(process.execPath, args, { cwd: __dirname });

    let stderrBuf = "";

    child.on("error", (err) => {
      console.error("spawn error:", err);
      const j = jobs.get(jobId) || initMeta;
      const withErr = { ...j, status: "error", errorMessage: "Spawn error: " + err.message };
      jobs.set(jobId, withErr);
      saveMeta(withErr);
      sendEvent(jobId, "__ERROR__");
    });

    // répondre tout de suite
    res.json({ jobId, fileName });

    child.stdout.on("data", (chunk) => sendEvent(jobId, chunk.toString()));
    child.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      stderrBuf += s;
      try { fs.appendFileSync(logErrPath, s); } catch {}
      // en SSE, on push des lignes bien séparées
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) sendEvent(jobId, "ERR: " + line);
      }
    });

    child.on("close", (code, signal) => {
      const ok = code === 0 && fs.existsSync(pdfPath);
      if (ok) {
        const j = jobs.get(jobId) || initMeta;
        const done = { ...j, status: "done" };
        jobs.set(jobId, done);
        saveMeta(done);
        sendEvent(jobId, `📄 PDF généré : ${pdfPath}`);
        sendEvent(jobId, "__DONE__");
        return;
      }

      // Construire un message d'erreur solide
      const tail = stderrBuf.split(/\r?\n/).slice(-15).join("\n").trim();
      let msg =
        /Could not find Chrome/i.test(stderrBuf) ? "Chromium introuvable (vérifie l’install Puppeteer)"
        : /ERR_NAME_NOT_RESOLVED|ERR_BLOCKED_BY_CLIENT|ERR_CONNECTION/i.test(stderrBuf) ? "Erreur réseau/chargement (URL, consentement cookies, adblock)"
        : tail || `Process exited with code=${code}, signal=${signal}`;

      const j = jobs.get(jobId) || initMeta;
      const errJ = { ...j, status: "error", errorMessage: msg };
      jobs.set(jobId, errJ);
      saveMeta(errJ);

      // Lien vers le log sur disque pour lecture complète
      sendEvent(jobId, `ERR: Voir le log: ${logErrPath}`);
      sendEvent(jobId, "__ERROR__");
    });
  } catch (e) {
    console.error("/start exception:", e);
    return res.status(500).json({ error: e.message || "Erreur interne" });
  }
});

// ====== status (avec relecture disque si redémarrage) & download ======
app.get("/status/:jobId", (req, res) => {
  const { jobId } = req.params;
  let job = jobs.get(jobId);

  if (!job) {
    try {
      const jobRoot = path.join(__dirname, "jobs", jobId);
      if (fs.existsSync(jobRoot)) {
        const dirs = fs.readdirSync(jobRoot, { withFileTypes: true }).filter(d => d.isDirectory());
        for (const d of dirs) {
          const metaP = path.join(jobRoot, d.name, "meta.json");
          if (fs.existsSync(metaP)) {
            job = JSON.parse(fs.readFileSync(metaP, "utf8"));
            jobs.set(jobId, job); // rehydrate
            break;
          }
        }
      }
    } catch {}
  }

  if (!job) return res.status(404).json({ status: "unknown" });
  res.json({ status: job.status, fileName: job.fileName, errorMessage: job.errorMessage });
});

app.get("/result/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).send("Job inconnu");
  if (!fs.existsSync(job.pdfPath)) return res.status(404).send("PDF pas prêt");
  res.download(job.pdfPath, job.fileName);
});

// ====== boot ======
const PORT = Number(process.env.PORT) || 4000;

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

console.log('🟡 Booting server…');

try {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
  });

  server.on('error', (err) => {
    console.error('❌ app.listen error:', err && err.code ? err.code : err);
    process.exit(1);
  });
} catch (e) {
  console.error('❌ listen threw:', e);
  process.exit(1);
}

// meCode
