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

// ---- util ----
function dirFromUrlSmart(href) {
  const _sanitize = (s) =>
    s
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 80);
  const isMeaningful = (t) =>
    t &&
    ![
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
        ) {
          epIdx = i;
        }
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
    base = base || "episode";
    return base;
  } catch {
    return "episode";
  }
}

// ====== SSE state ======
const clients = new Map(); // jobId -> Set(res)
const jobs = new Map();    // jobId -> { status, pdfPath, outDir, fileName }

function sendEvent(jobId, event) {
  const subs = clients.get(jobId);
  if (!subs) return;
  const data = typeof event === "string" ? event : JSON.stringify(event);
  for (const res of subs) res.write(`data: ${data}\n\n`);
}

// SSE route
app.get("/events/:jobId", (req, res) => {
  const { jobId } = req.params;
  // CORS pour file:// ou autres origines
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
});

// Start job
app.post("/start", async (req, res) => {
  try {
    const { url, debug = false, wait = 0 } = req.body || {};
    if (!url) return res.status(400).json({ error: "URL manquante" });

    const jobId = Date.now().toString();
    const seriesDir = dirFromUrlSmart(url);
    const outDir = path.join(__dirname, "jobs", jobId, seriesDir);
    const fileName = `${seriesDir}.pdf`;
    const pdfPath = path.join(outDir, fileName);
    fs.mkdirSync(outDir, { recursive: true });
    jobs.set(jobId, { status: "started", pdfPath, outDir, fileName });

    const args = [path.join(__dirname, "webtoon.js"), url, outDir, fileName];
    if (debug) args.push("--debug");
    if (wait && Number(wait) > 0) args.push(`--wait=${Number(wait)}`);

    const child = spawn(process.execPath, args, { cwd: __dirname });

    child.stdout.on("data", (chunk) => sendEvent(jobId, chunk.toString()));
    child.stderr.on("data", (chunk) => sendEvent(jobId, "ERR: " + chunk.toString()));
    child.on("close", (code) => {
      if (code === 0 && fs.existsSync(pdfPath)) {
        jobs.set(jobId, { status: "done", pdfPath, outDir, fileName });
        sendEvent(jobId, "📄 PDF généré : " + pdfPath);
        sendEvent(jobId, "__DONE__");
      } else {
        jobs.set(jobId, { status: "error", pdfPath, outDir, fileName });
        sendEvent(jobId, "__ERROR__");
      }
    });
    res.json({ jobId, fileName });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Download
app.get("/result/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).send("Job inconnu");
  if (!fs.existsSync(job.pdfPath)) return res.status(404).send("PDF pas prêt");
  res.download(job.pdfPath, job.fileName);
});

// Status
app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: "unknown" });
  res.json({ status: job.status, fileName: job.fileName });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🌐 Backend prêt sur http://localhost:${PORT}`));
