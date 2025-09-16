const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
try { require.resolve("sharp"); } catch { require.resolve("@img/sharp"); }
const sharp = require("sharp");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");

/**
 * Télécharge un webtoon et le convertit en PDF
 * @param {string} inputUrl - URL du webtoon
 * @returns {string} pdfPath - chemin du PDF généré
 */
async function downloadWebtoon(inputUrl) {
  let browser;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /** ------------ helpers (copiés de ton code) ------------ */
  function normalizeUrl(input) {
    if (!input) throw new Error("URL manquante");
    try {
      return new URL(input).href;
    } catch {}
    if (/^viewer\?/i.test(input) || /^\/?viewer\?/i.test(input))
      return "https://www.webtoons.com/en/viewer?" + input.replace(/^\/?viewer\?/, "");
    if (input.startsWith("/")) return "https://www.webtoons.com" + input;
    return "https://" + input;
  }

  async function autoScroll(frame) {
    await frame.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let last = 0, stable = 0;
      for (let i = 0; i < 150; i++) {
        window.scrollBy(0, window.innerHeight);
        await sleep(400);
        const h = document.scrollingElement.scrollHeight;
        if (h === last) {
          if (++stable >= 3) break;
        } else {
          stable = 0;
          last = h;
        }
      }
      window.scrollTo(0, 0);
    });
  }

  async function collectAllImages(page) {
    await autoScroll(page.mainFrame());
    let all = [];
    for (const fr of page.frames()) {
      try {
        all = all.concat(await fr.evaluate(() => {
          const imgs = [];
          document.querySelectorAll("img").forEach(img => {
            if (img.src) imgs.push({ src: img.src, y: img.getBoundingClientRect().top });
          });
          return imgs;
        }));
      } catch {}
    }
    const seen = new Set();
    return all
      .sort((a, b) => a.y - b.y)
      .filter(it => { if (seen.has(it.src)) return false; seen.add(it.src); return true; });
  }

  async function imagesToPdf(files, pdfPath) {
    if (!files.length) throw new Error("Aucune image à convertir");
    const doc = new PDFDocument({ autoFirstPage: false });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    for (const f of files) {
      try {
        const meta = await sharp(f).metadata();
        const w = meta.width, h = meta.height;
        doc.addPage({ size: [w, h], margins: { top: 0, left: 0, right: 0, bottom: 0 } });
        doc.image(f, 0, 0, { width: w, height: h });
      } catch (e) {
        console.log(`⚠️ Skip: ${f} - ${e.message}`);
      }
    }

    doc.end();
    await new Promise((resolve, reject) => {
      stream.on("finish", resolve);
      stream.on("error", reject);
    });

    return pdfPath;
  }

  /** ------------ MAIN ------------ */
  try {
    const url = normalizeUrl(inputUrl);

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 0 });
    await sleep(2000);

    const images = await collectAllImages(page);
    console.log(`📸 ${images.length} images détectées`);

    // Téléchargement local
    const outDir = "downloads";
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const files = [];
    let idx = 0;
    for (const it of images) {
      const view = await page.goto(it.src);
      const buf = await view.buffer();
      const fname = path.join(outDir, `img_${String(idx++).padStart(4, "0")}.jpg`);
      fs.writeFileSync(fname, buf);
      files.push(fname);
    }

    const pdfPath = path.join(outDir, "episode.pdf");
    await imagesToPdf(files, pdfPath);

    console.log(`📄 PDF généré: ${pdfPath}`);
    return pdfPath;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { downloadWebtoon };
