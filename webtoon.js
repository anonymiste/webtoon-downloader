#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const sanitize = require('sanitize-filename');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ---- Config de base ---- */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** Scroll jusqu’à stabilisation du contenu */
async function autoScroll(frame) {
  await frame.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let last = 0,
      stable = 0;
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

/** Collecte images (img/srcset/background-image) dans un frame */
async function collectFromFrame(frame) {
  return await frame.evaluate(() => {
    const pickLargestFromSrcset = (srcset) => {
      try {
        const parts = srcset.split(',').map((s) => s.trim());
        const parsed = parts.map((p) => {
          const [u, sz] = p.split(/\s+/);
          const val = sz?.endsWith('w')
            ? parseInt(sz)
            : sz?.endsWith('x')
            ? parseFloat(sz) * 1000
            : 0;
          return { u, val };
        });
        parsed.sort((a, b) => b.val - a.val);
        const best = parsed[0]?.u || '';
        return best ? new URL(best, location.href).href : '';
      } catch {
        return '';
      }
    };

    const items = [];
    const push = (src, rect) => {
      if (!src) return;
      try {
        src = new URL(src, location.href).href;
      } catch {}
      if (rect.width > 50 && rect.height > 50) {
        items.push({
          src: src.split('#')[0],
          y: Math.round(rect.top + scrollY),
        });
      }
    };

    // <img> + srcset
    document.querySelectorAll('img').forEach((img) => {
      const rect = img.getBoundingClientRect();
      let final = img.currentSrc || img.src || '';
      const srcset = img.getAttribute('srcset');
      if (srcset) final = pickLargestFromSrcset(srcset) || final;
      push(final, rect);
    });

    // <source srcset> (picture)
    document.querySelectorAll('source[srcset]').forEach((s) => {
      const rect =
        s.parentElement?.getBoundingClientRect?.() || { width: 0, height: 0, top: 0 };
      const ss = s.getAttribute('srcset');
      if (ss) push(pickLargestFromSrcset(ss), rect);
    });

    // background-image
    document.querySelectorAll('*').forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage || '';
      const m = bg.match(/url\((['"]?)(.*?)\1\)/);
      if (m && m[2]) push(m[2], el.getBoundingClientRect());
    });

    // tri + dédup
    const seen = new Set();
    const out = [];
    items
      .sort((a, b) => a.y - b.y)
      .forEach((it) => {
        if (!seen.has(it.src)) {
          seen.add(it.src);
          out.push(it);
        }
      });
    return out;
  });
}

/** Collecte toutes les images de la page */
async function collectAllImages(page) {
  await autoScroll(page.mainFrame());
  let all = [];
  for (const fr of page.frames()) {
    try {
      all = all.concat(await collectFromFrame(fr));
    } catch {}
  }
  const seen = new Set(),
    out = [];
  all
    .sort((a, b) => a.y - b.y)
    .forEach((it) => {
      if (!seen.has(it.src)) {
        seen.add(it.src);
        out.push(it);
      }
    });
  return out.map((it, i) => ({ ...it, idx: i }));
}

/** Télécharge via Puppeteer */
async function downloadViaPuppeteer(page, images, outputDir) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const saved = [];
  for (const { src, idx } of images) {
    try {
      const view = path.join(outputDir, `${String(idx).padStart(4, '0')}.png`);
      const resp = await page.goto(src, { waitUntil: 'networkidle0' });
      const buf = await resp.buffer();
      await sharp(buf).png().toFile(view);
      saved.push(view);
    } catch {}
  }
  return saved;
}

/** Construit le PDF */
async function imagesToPdf(files, pdfPath) {
  if (!files.length) throw new Error('No images to build PDF');
  const doc = new PDFDocument({ autoFirstPage: false });
  doc.pipe(fs.createWriteStream(pdfPath));

  for (const f of files) {
    try {
      const meta = await sharp(f).metadata();
      const w = meta.width,
        h = meta.height;
      doc.addPage({ size: [w, h], margins: { top: 0, left: 0, right: 0, bottom: 0 } });
      doc.image(f, 0, 0, { width: w, height: h });
    } catch (e) {
      console.log(`⚠️ Skip: ${f} - ${e.message}`);
    }
  }
  doc.end();
}

/** -------- MAIN -------- */
(async () => {
  const url = process.argv[2];
  const outDir = process.argv[3] || 'images';
  const pdfName = process.argv[4] || 'episode.pdf';

  if (!url) {
    console.log('Usage: node webtoon.js <URL> [dossier_images] [nom_pdf]');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
    ],
    defaultViewport: { width: 1280, height: 1800 },
  });
  const page = await browser.newPage();
  await page.setUserAgent(UA);

  console.log(`🌐 ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 0 });

  const images = await collectAllImages(page);
  console.log(`📸 ${images.length} images détectées`);
  const files = await downloadViaPuppeteer(page, images, outDir);

  const pdfPath = path.join(outDir, sanitize(pdfName));
  await imagesToPdf(files, pdfPath);
  console.log(`📄 PDF généré : ${pdfPath}`);

  await browser.close();
})();
