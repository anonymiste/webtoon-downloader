const express = require("express");
const cors = require("cors");
const { downloadWebtoon } = require("./webtoon");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("🚀 Webtoon Downloader API is running on Render with Chromium!");
});

// Endpoint principal : POST /download { "url": "https://..." }
app.post("/download", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL manquante" });

    console.log(`📥 Reçu pour téléchargement: ${url}`);
    const pdfPath = await downloadWebtoon(url);

    res.json({ success: true, pdf: pdfPath });
  } catch (err) {
    console.error("❌ Erreur download:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
