const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { downloadWebtoon } = require("./webtoon");

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir le front-end statique
app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(path.join(__dirname, "downloads")));

// Route racine
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Route pour générer le PDF
app.post("/download", async (req, res) => {
  try {
    const { url, wait = 0, debug = false } = req.body;
    if (!url) return res.status(400).json({ error: "URL manquante" });

    // Crée le dossier downloads si nécessaire
    if (!fs.existsSync(path.join(__dirname, "downloads"))) {
      fs.mkdirSync(path.join(__dirname, "downloads"), { recursive: true });
    }

    console.log(`📥 Nouvelle demande : ${url}`);
    const options = { wait: Number(wait), debug: Boolean(debug) };

    // Appelle ton module webtoon.js
    const pdfPath = await downloadWebtoon(url, options);

    // Renvoie le chemin relatif pour le téléchargement côté front
    const fileName = path.basename(pdfPath);
    res.json({ success: true, pdf: `/downloads/${fileName}`, fileName });
  } catch (err) {
    console.error("❌ Erreur download:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Démarre le serveur
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
