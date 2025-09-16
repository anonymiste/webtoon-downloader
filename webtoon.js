#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
try { require.resolve('sharp'); } catch { require.resolve('@img/sharp'); }
const sharp = require('sharp');
const sanitize = require('sanitize-filename');
const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get("/", (req, res) => {
  res.send("🚀 Webtoon Downloader API is running on Render with Chromium!");
});

app.get("/screenshot", async (req, res) => {
  try {
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();
    await page.goto("https://example.com", { waitUntil: "networkidle2" });
    const screenshot = await page.screenshot({ encoding: "base64" });

    await browser.close();

    res.send(`<img src="data:image/png;base64,${screenshot}" />`);
  } catch (error) {
    console.error("❌ Puppeteer error:", error);
    res.status(500).send("Erreur Puppeteer: " + error.message);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});


(async () => {
  let browser;
  try {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    /** ---- Config de base ---- */
    const UA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

    // ➜ Utilise Chrome system (Render fournit /usr/bin/google-chrome)
    const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';

    browser = await puppeteer.launch({
      headless: true,
      executablePath: CHROME_PATH,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process'
      ],
      defaultViewport: { width: 1280, height: 1800 }
    });

    /* ---------- CLI helpers ---------- */
    function parseCliArgs(argv) {
      let url = '', outDir = 'images', pdfName = 'episode.pdf', debug = false, wait = 0;
      const rest = [];
      for (const a of argv.slice(2)) {
        if (a === '--debug') { debug = true; continue; }
        if (a.startsWith('--wait=')) { wait = Number(a.split('=')[1] || 0); continue; }
        rest.push(a);
      }
      if (rest.length === 0) {
        console.log('Usage: node webtoon.js <URL> [outDir] [pdfName] [--debug] [--wait=ms]');
        process.exit(1);
      }
      url = rest[0];
      if (rest[1]) { if (/\.pdf$/i.test(rest[1])) pdfName = rest[1]; else outDir = rest[1]; }
      if (rest[2]) { if (/\.pdf$/i.test(rest[2])) pdfName = rest[2]; else outDir = rest[2]; }
      return { url, outDirArg: outDir, pdfName, debug, wait };
    }

    function dirFromUrlSmart(href) {
      const _san = (s) =>
        s.normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/gi, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
          .toLowerCase()
          .slice(0, 80);
      const isMean = (t) =>
        t &&
        !['viewer', 'read', 'reader', 'manga', 'comic', 'webtoon', 'webtoons', 'series', 'title', 'chapters', 'chapter', 'episode', 'ep', 'view', 'fr', 'en', 'es', 'ko'].includes(
          t.toLowerCase()
        );
      try {
        const u = new URL(href);
        const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const L = parts.length;
        const rx = [/(ep|episode)[\s\-_]*([0-9]+)$/i, /(ch|chap|chapter)[\s\-_]*([0-9]+)$/i, /^([0-9]+)$/i];
        let epToken = '';
        for (let i = L - 1; i >= 0 && !epToken; i--) {
          for (const r of rx) {
            const m = parts[i].match(r);
            if (m) {
              const num = m[2] || m[1];
              const tag = (m[1] || '').toLowerCase();
              const p = /chap|chapter|ch/i.test(tag) ? 'ch' : 'ep';
              epToken = `${p}${num}`;
              break;
            }
          }
        }
        if (!epToken) {
          const q = ['episode_no', 'ep', 'episode', 'chapter', 'ch']
            .map((k) => u.searchParams.get(k))
            .find((v) => v && /^\d+$/.test(v));
          if (q) epToken = `ep${q}`;
        }
        let series = '';
        if (epToken) {
          let epIdx = -1;
          for (let i = L - 1; i >= 0 && epIdx === -1; i--) {
            if (
              new RegExp(
                epToken.replace(/^ep/i, '(ep|episode)').replace(/^ch/i, '(ch|chap|chapter)'),
                'i'
              ).test(parts[i])
            )
              epIdx = i;
          }
          const cand = (epIdx > 0 ? parts.slice(0, epIdx) : parts).filter(isMean);
          const tail = cand.slice(-2).filter(isMean);
          series = _san(tail.join('-')) || 'episode';
        } else {
          const tail = parts.filter(isMean).slice(-2);
          series = _san(tail.join('-')) || 'episode';
        }
        let base = series;
        if (epToken) {
          const epSan = _san(epToken);
          if (!new RegExp(`(^|-)${epSan}(-|$)`).test(base)) base += `-${epSan}`;
        }
        return base || 'episode';
      } catch {
        return 'episode';
      }
    }

    function normalizeUrl(input) {
      if (!input) throw new Error('URL manquante');
      try {
        return new URL(input).href;
      } catch {}
      if (/^viewer\?/i.test(input) || /^\/?viewer\?/i.test(input))
        return 'https://www.webtoons.com/en/viewer?' + input.replace(/^\/?viewer\?/, '');
      if (input.startsWith('/')) return 'https://www.webtoons.com' + input;
      return 'https://' + input;
    }

    /* ---------- page helpers ---------- */
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
          if (rect.width > 50 && rect.height > 50)
            items.push({ src: src.split('#')[0], y: Math.round(rect.top + scrollY) });
        };
        document.querySelectorAll('img').forEach((img) => {
          const rect = img.getBoundingClientRect();
          let final = img.currentSrc || img.src || '';
          const ss = img.getAttribute('srcset');
          if (ss) final = pickLargestFromSrcset(ss) || final;
          push(final, rect);
        });
        document.querySelectorAll('source[srcset]').forEach((s) => {
          const rect = s.parentElement?.getBoundingClientRect?.() || { width: 0, height: 0, top: 0 };
          push(pickLargestFromSrcset(s.getAttribute('srcset')), rect);
        });
        document.querySelectorAll('*').forEach((el) => {
          const bg = getComputedStyle(el).backgroundImage || '';
          const m = bg.match(/url\((['"]?)(.*?)\1\)/);
          if (m && m[2]) push(m[2], el.getBoundingClientRect());
        });
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

    async function collectAllImages(page) {
      await autoScroll(page.mainFrame());
      for (const fr of page.frames()) {
        if (fr === page.mainFrame()) continue;
        try {
          await autoScroll(fr);
        } catch {}
      }
      let all = [];
      for (const fr of page.frames()) {
        try {
          all = all.concat(await collectFromFrame(fr));
        } catch {}
      }
      const seen = new Set();
      const out = [];
      all.sort((a, b) => a.y - b.y).forEach((it) => {
        if (!seen.has(it.src)) {
          seen.add(it.src);
          out.push(it);
        }
      });
      return out.map((it, i) => ({ ...it, idx: i }));
    }

    async function downloadViaPuppeteer(page, images, outputDir) {
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      const saved = [];
      const want = new Map(images.map((i) => [i.src, i]));
      const pending = new Map();

      const nameFor = (url, idx) => {
        const base = path.basename(new URL(url).pathname);
        const ext = (base.split('.').pop() || '').toLowerCase();
        const n = String(idx).padStart(4, '0');
        return ['jpg', 'jpeg', 'png', 'webp', 'avif'].includes(ext) ? `${n}.${ext}` : `${n}.jpg`;
      };

      const onResp = async (response) => {
        try {
          if (response.request().resourceType() !== 'image') return;
          const url = response.url().split('#')[0];
          const meta = want.get(url);
          if (!meta || pending.has(url)) return;
          const p = (async () => {
            const buf = await response.buffer();
            let out = path.join(outputDir, nameFor(url, meta.idx));
            const lower = out.toLowerCase();
            if (lower.endsWith('.webp') || lower.endsWith('.avif')) {
              out = out.replace(/\.(webp|avif)$/i, '.png');
              await sharp(buf).png({ compressionLevel: 9 }).toFile(out);
            } else {
              fs.writeFileSync(out, buf);
            }
            console.log('💾 Image sauvegardée :', out);
            saved.push(out);
            return out;
          })();
          pending.set(url, p);
        } catch {}
      };

      page.on('response', onResp);

      for (const { src } of images) {
        await page.evaluate(async (s) => {
          try {
            const el = new Image();
            el.decoding = 'sync';
            el.referrerPolicy = 'no-referrer-when-downgrade';
            el.src = new URL(s, location.href).href;
            await el.decode().catch(() => {});
          } catch {}
        }, src);
      }

      await page.waitForNetworkIdle({ idleTime: 1500, timeout: 30000 }).catch(() => {});
      await Promise.all([...pending.values()]);
      page.off('response', onResp);

      return saved.sort();
    }

    // fallback + pdf builder (inchangés de ta version)

    async function screenshotFallback(page, outDir) {
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

      const total = await page.evaluate(
        () =>
          Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight,
            document.body.offsetHeight,
            document.documentElement.offsetHeight,
            document.body.clientHeight,
            document.documentElement.clientHeight
          )
      );

      let vp = { height: 1800, width: 1280 };
      try {
        vp = await page.viewport();
      } catch {}
      const step = vp.height;
      const overlap = 40;

      let y = 0,
        idx = 0;
      const parts = [];

      while (y < total) {
        await page.evaluate((_y) => window.scrollTo(0, _y), y);
        await sleep(300);

        const fname = path.join(outDir, `shot_${String(idx).padStart(4, '0')}.png`);
        await page.screenshot({ path: fname, fullPage: false });
        parts.push(fname);

        idx++;
        const next = y + step - overlap;
        if (next <= y) break;
        y = next;

        if (idx > 1000) break;
      }

      console.log(`💾 ${parts.length} captures sauvegardées (fallback rafale).`);
      return parts;
    }

    async function imagesToPdf(files, pdfPath) {
      if (!files.length) throw new Error('No images to build PDF');
      const doc = new PDFDocument({ autoFirstPage: false });
      const stream = fs.createWriteStream(pdfPath);
      doc.pipe(stream);

      for (const f of files) {
        try {
          const meta = await sharp(f).metadata();
          const w = meta.width,
            h = meta.height;
          if (!w || !h) throw new Error('Missing dimensions');

          let final = f;
          const lower = f.toLowerCase();
          if (!lower.endsWith('.jpg') && !lower.endsWith('.jpeg') && !lower.endsWith('.png')) {
            final = f.replace(/\.[^.]+$/, '.png');
            await sharp(f).png().toFile(final);
          }

          doc.addPage({ size: [w, h], margins: { top: 0, left: 0, right: 0, bottom: 0 } });
          doc.image(final, 0, 0, { width: w, height: h });
        } catch (e) {
          console.log(`⚠️ Skip: ${f} - ${e.message}`);
        }
      }

      doc.end();
      await new Promise((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
      });

      for (const f of files) {
        try {
          fs.unlinkSync(f);
          console.log(`🗑️ Supprimé : ${f}`);
        } catch {}
      }
    }

    /* -------- MAIN -------- */
    const { url, outDirArg, pdfName, debug, wait } = parseCliArgs(process.argv);
    const finalUrl = normalizeUrl(url);

    const outDir = outDirArg && outDirArg !== 'images' ? outDirArg : dirFromUrlSmart(finalUrl);
    const finalPdf =
      pdfName && pdfName !== 'episode.pdf' ? pdfName : path.basename(outDir) + '.pdf';
    const pdfPath = path.join(outDir, finalPdf);

    const page = await browser.newPage();
    await page.setUserAgent(UA);

    console.log(`🌐 ${finalUrl}`);
    await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
    if (wait > 0) await sleep(wait);

    const images = await collectAllImages(page);
    console.log(`📸 ${images.length} images détectées (après tri). Téléchargement…`);

    let files = await downloadViaPuppeteer(page, images, outDir);
    console.log(`✅ ${files.length}/${images.length} sauvegardées.`);

    if (!files.length) {
      console.log('⚠️ Aucune image récupérée — fallback multi-captures…');
      files = await screenshotFallback(page, outDir);
    }

    if (!files.length) {
      console.log('⚠️ Aucune image récupérée — fallback screenshots scroll…');
      files = await screenshotFallback(page, outDir);
    }

    console.log('🧩 Construction PDF depuis', files.length, 'image(s) →', pdfPath);
    await imagesToPdf(files, pdfPath);
    console.log(`📄 PDF généré : ${pdfPath}`);
  } catch (e) {
    console.error('Erreur:', e);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
