// FRONT—app.js
const BACKEND = window.location.origin; // auto pour Render ou local

// UI refs
const $url = document.getElementById("url");
const $wait = document.getElementById("wait");
const $debug = document.getElementById("debug");
const $start = document.getElementById("start");
const $download = document.getElementById("download");
const $logs = document.getElementById("logs");
const $status = document.getElementById("status");
const $filename = document.getElementById("filename");

// restore last prefs
$url.value = localStorage.getItem("webtoon_last_url") || "";
$wait.value = localStorage.getItem("webtoon_wait") || "0";
$debug.checked = localStorage.getItem("webtoon_debug") === "1";

let jobId = null;
let fileName = "";
let es = null;

function log(line) {
  $logs.textContent += (typeof line === "string" ? line : JSON.stringify(line)) + "\n";
  $logs.scrollTop = $logs.scrollHeight;
}
function setStatus(text, type = "info") {
  const color = type === "ok" ? "var(--ok)" : type === "err" ? "var(--err)" : "#111";
  $status.style.color = color;
  $status.textContent = text;
}
function setDownloadingReady(ready) {
  $download.disabled = !ready;
  $download.className = ready ? "btn ok" : "btn dis";
}
function setBusy(busy) {
  $start.disabled = busy;
  $start.className = busy ? "btn dis" : "btn primary";
}

async function startJob() {
  const url = $url.value.trim();
  const wait = Number($wait.value || 0);
  const debug = !!$debug.checked;

  if (!url) {
    setStatus("❌ Merci de coller une URL.", "err");
    return;
  }

  // persist
  localStorage.setItem("webtoon_last_url", url);
  localStorage.setItem("webtoon_wait", String(wait));
  localStorage.setItem("webtoon_debug", debug ? "1" : "0");

  // vider l'input après lancement
  $url.value = "";

  setBusy(true);
  setDownloadingReady(false);
  $logs.textContent = "";
  setStatus("⏳ Lancement…");

  try {
    const res = await fetch(`${BACKEND}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, wait, debug })
    });

    if (!res.ok) {
      let msg = "Erreur de démarrage backend";
      try {
        const j = await res.json();
        if (j?.error) msg = j.error;
      } catch {}
      setBusy(false);
      setStatus("❌ " + msg, "err");
      return;
    }

    const data = await res.json();
    jobId = data.jobId;
    fileName = data.fileName || "episode.pdf";
    $filename.textContent = fileName ? `(${fileName})` : "";
    setStatus("🚀 En cours…");

    // SSE pour logs + fin
    if (es) { es.close(); es = null; }
    es = new EventSource(`${BACKEND}/events/${jobId}`);

    es.onopen = () => log("🔌 Connexion SSE ouverte");
    es.onerror = () => log("⚠️ Erreur SSE (fallback polling)");

    es.onmessage = (ev) => {
      const msg = ev.data;

      if (msg.startsWith("📄 PDF généré :") || msg.startsWith("PDF généré :")) {
        setStatus("✅ Terminé", "ok");
        setDownloadingReady(true);
        setBusy(false);
      }

      if (msg === "__DONE__") {
        setStatus("✅ Terminé", "ok");
        setDownloadingReady(true);
        setBusy(false);
        es.close();
      } else if (msg === "__ERROR__") {
        // le polling précisera l'errorMessage
        setStatus("❌ Erreur pendant le traitement", "err");
        setBusy(false);
        es.close();
      } else {
        log(msg);
      }
    };

    // Fallback: polling statut si SSE foire
    let pollStop = false;
    const poll = async () => {
      if (pollStop || !jobId) return;
      try {
        const r = await fetch(`${BACKEND}/status/${jobId}`);
        if (r.ok) {
          const j = await r.json();
          if (j.status === "done") {
            setStatus("✅ Terminé", "ok");
            setDownloadingReady(true);
            setBusy(false);
            pollStop = true;
            return;
          }
          if (j.status === "error") {
            setStatus("❌ " + (j.errorMessage || "Erreur pendant le traitement"), "err");
            setBusy(false);
            pollStop = true;
            return;
          }
        }
      } catch {}
      setTimeout(poll, 2000);
    };
    poll();

  } catch (e) {
    console.error(e);
    setBusy(false);
    setStatus("❌ Erreur réseau", "err");
  }
}

function downloadFile() {
  if (!jobId) return;
  const a = document.createElement("a");
  a.href = `${BACKEND}/result/${jobId}`;
  a.download = fileName || "episode.pdf";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

$start.addEventListener("click", startJob);
$download.addEventListener("click", downloadFile);
$url.addEventListener("keydown", (e) => { if (e.key === "Enter") startJob(); });
$filename.textContent = fileName ? `(${fileName})` : "";
document.getElementById("jobid").textContent = jobId; // ajoute un petit span dans l'UI
