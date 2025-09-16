#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const PDFDocument = require('pdfkit');
let sharp;
try {
  // try to load sharp normally
  sharp = require('sharp');
} catch (err) {
  // if you have alternative packaging for sharp, keep fallback logic here
  try { sharp = require('@img/sharp'); } catch (e) { sharp = null; }
}
const sanitize = require('sanitize-filename');

(async () => {
  let browser;
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    /** ---- Config de base ---- */
    const UA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
    const TMP_DIR = process.env.TMPDIR || '/tmp';

    /** ---------- launch chromium (puppeteer-core + sparticuz) ---------- */
    browser = await puppeteer.launch({
      headless: chromium.headless,
      executablePath: await chromium.executablePath(),
      args: chromium.args.concat([
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
      ]),
      defaultViewport: { width: 1280, height: 1800 },
    });

    /* ---------- CLI helpers ---------- */
    function parseCliArgs(argv) {
      let url = '',
        outDir = 'images',
        pdfName = 'episode.pdf',
        debug = false,
        wait = 0;
      const rest = [];
      for (const a of argv.slice(2)) {
        if (a === '--debug') {
          debug = true;
          continue;
        }
        if (a.startsWith('--wait=')) {
          wait = Number(a.split('=')[1] || 0);
          continue;
        }
        rest.push(a);
      }
      if (rest.length === 0) {
        console.log(
          'Usage: node webtoon.js <URL> [outDir] [pdfName] [--debug] [--wait=ms]'
        );
        process.exit(1);
      }
      url = rest[0];
      if (rest[1]) {
        if (/\.pdf$/i.test(rest[1])) pdfName = rest[1];
        else outDir = rest[1];
      }
      if (rest[2]) {
        if (/\.pdf$/i.test(rest[2])) pdfName = rest[2];
        else outDir = rest[2];
      }
      return { url, outDirArg: outDir, pdfName, debug, wait };
    }

    function dirFromUrlSmart(href) {
      const _san = (s) =>
        s
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/gi, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
          .toLowerCase()
          .slice(0, 80);
      const isMean = (t) =>
        t &&
        ![
          'viewer',
          'read',
          'reader',
          'manga',
          'comic',
          'webtoon',
          'webtoons',
          'series',
          'title',
          'chapters',
          'chapter',
          'episode',
          'ep',
          'view',
          'fr',
          'en',
          'es',
          'ko',
        ].includes(t.toLowerCase());
      try {
        const u = new URL(href);
        const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const L = parts.length;
        const rx = [
          /(ep|episode)[\s\-_]*([0-9]+)$/i,
          /(ch|chap|chapter)[\s\-_]*([0-9]+)$/i,
          /^([0-9]+)$/i,
        ];
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
                epToken
                  .replace(/^ep/i, '(ep|episode)')
                  .replace(/^ch/i, '(ch|chap|chapter)'),
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
          if (rect.width > 50 && rect.height > 50) items.push({ src: src.split('#')[0], y: Math.round(rect.top + scrollY) });
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
        items.sort((a, b) => a.y - b.y).forEach((it) => {
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

    async function downloadViaPuppeteer(page, images, outputDir, debug = false) {
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      const saved = [];
      const want = new Map(images.map((i) => [i.src, i]));
      const pending = new Map();

      const nameFor = (url, idx) => {
        try {
          const u = new URL(url);
          const base = path.basename(u.pathname) || '';
          const ext = (base.split('.').pop() || '').toLowerCase();
          const n = String(idx).padStart(4, '0');
          return ['jpg', 'jpeg', 'png', 'webp', 'avif'].includes(ext) ? `${n}.${ext}` : `${n}.jpg`;
        } catch {
          return `${String(idx).padStart(4, '0')}.jpg`;
        }
      };

      const onResp = async (response) => {
        try {
          const headers = response.headers();
          const ct = (headers['content-type'] || '').toLowerCase();
          if (!ct.startsWith('image/')) return;
          const url = response.url().split('#')[0];
          const meta = want.get(url);
          if (!meta || pending.has(url)) return;
          const p = (async () => {
            const buf = await response.buffer();
            let out = path.join(outputDir, nameFor(url, meta.idx));
            const lower = out.toLowerCase();
            if ((lower.endsWith('.webp') || lower.endsWith('.avif')) && sharp) {
              out = out.replace(/\.(webp|avif)$/i, '.png');
              await sharp(buf).png({ compressionLevel: 9 }).toFile(out);
            } else {
              fs.writeFileSync(out, buf);
            }
            if (debug) console.log('💾 Image saved:', out);
            saved.push(out);
            return out;
          })();
          pending.set(url, p);
        } catch (err) {
          if (debug) console.warn('onResp error', err);
        }
      };

      page.on('response', onResp);

      // Trigger browser to (re)load each image URL so responses are emitted
      for (const { src } of images) {
        try {
          await page.evaluate(
            async (s) => {
              try {
                const el = new Image();
                el.decoding = 'sync';
                el.referrerPolicy = 'no-referrer-when-downgrade';
                el.src = new URL(s, location.href).href;
                await el.decode().catch(() => {});
              } catch {}
            },
            src
          );
        } catch {}
      }

      // wait a short time for responses to arrive, then wait pending promises
      await page.waitForTimeout(1500);
      await Promise.all([...pending.values()]).catch(() => {});
      page.off('response', onResp);

      return saved.sort();
    }

    // Fallback : multi-captures successives, triées et renvoyées pour le PDF
    async function screenshotFallback(page, outDir) {
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

      // Hauteur totale de la page
      const total = await page.evaluate(() =>
        Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight,
          document.body.offsetHeight,
          document.documentElement.offsetHeight,
          document.body.clientHeight,
          document.documentElement.clientHeight
        )
      );

      // Viewport et step (tu peux mettre un petit chevauchement si besoin)
      let vp = { height: 1800, width: 1280 };
      try {
        vp = await page.viewport();
      } catch {}
      const step = vp.height; // hauteur de défilement
      const overlap = 40; // ex: 40 si tu veux un léger recouvrement

      let y = 0,
        idx = 0;
      const parts = [];

      while (y < total) {
        // Scroll à la position y
        await page.evaluate((_y) => window.scrollTo(0, _y), y);
        await sleep(300);

        const fname = path.join(outDir, `shot_${String(idx).padStart(4, '0')}.png`);
        await page.screenshot({ path: fname, fullPage: false });
        parts.push(fname);

        idx++;
        const next = y + step - overlap;
        if (next <= y) break; // garde-fou
        y = next;

        if (idx > 1000) break; // hard safety
      }

      console.log(`💾 ${parts.length} captures sauvegardées (fallback rafale).`);
      return parts;
    }

    /** Construit le PDF avec pages à la taille exacte des images */
    async function imagesToPdf(files, pdfPath) {
      if (!files.length) throw new Error('No images to build PDF');
      const doc = new PDFDocument({ autoFirstPage: false });
      const stream = fs.createWriteStream(pdfPath);
      doc.pipe(stream);

      for (const f of files) {
        try {
          let meta;
          if (sharp) {
            meta = await sharp(f).metadata();
          } else {
            // fallback: try to read via PDFKit dimensions approximation (not ideal)
            meta = { width: 800, height: 1200 };
          }
          const w = meta.width,
            h = meta.height;
          if (!w || !h) throw new Error('Missing dimensions');

          let final = f;
          const lower = f.toLowerCase();
          if (!lower.endsWith('.jpg') && !lower.endsWith('.jpeg') && !lower.endsWith('.png')) {
            final = f.replace(/\.[^.]+$/, '.png');
            if (sharp) await sharp(f).png().toFile(final);
          }

          doc.addPage({ size: [w, h], margins: { top: 0, left: 0, right: 0, bottom: 0 } });
          doc.image(final, 0, 0, { width: w, height: h });
        } catch (e) {
          console.log(`⚠️ Skip: ${f} - ${e.message}`);
        }
      }

      doc.end();

      // attendre que le PDF soit bien écrit
      await new Promise((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
      });

      // maintenant, supprimer les images (sécurisé)
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

    // If running on Render (ephemeral FS), write into TMP_DIR, otherwise use provided outDirArg
    const baseOutName = outDirArg && outDirArg !== 'images' ? outDirArg : dirFromUrlSmart(finalUrl);
    const outDir = path.join(TMP_DIR, baseOutName);
    const finalPdf = pdfName && pdfName !== 'episode.pdf' ? pdfName : `${path.basename(baseOutName)}.pdf`;
    const pdfPath = path.join(outDir, finalPdf);

    if (debug) console.log('DEBUG: outDir=', outDir, 'pdfPath=', pdfPath, 'finalUrl=', finalUrl);

    const page = await browser.newPage();
    await page.setUserAgent(UA);

    console.log(`🌐 ${finalUrl}`);
    await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
    if (wait > 0) await sleep(wait);

    const images = await collectAllImages(page);
    console.log(`📸 ${images.length} images détectées (après tri). Téléchargement…`);

    let files = await downloadViaPuppeteer(page, images, outDir, debug);
    console.log(`✅ ${files.length}/${images.length} sauvegardées.`);

    if (!files.length) {
      console.log('⚠️ Aucune image récupérée — fallback multi-captures…');
      files = await screenshotFallback(page, outDir); // ← renvoie la liste des shots
    }

    if (!files.length) {
      console.log('⚠️ Aucune image récupérée — fallback screenshots scroll…');
      files = await screenshotFallback(page, outDir);
    }

    console.log('🧩 Construction PDF depuis', files.length, 'image(s) →', pdfPath);
    await imagesToPdf(files, pdfPath);
    console.log(`📄 PDF généré : ${pdfPath}`);

    // option: print location to stdout for caller
    console.log(`OUTPUT_PDF=${pdfPath}`);
  } catch (e) {
    console.error('❌ Erreur:', e);
    process.exit(1);
  } finally {
    try {
      if (browser) await browser.close();
    } catch (e) {
      console.warn('Erreur lors de la fermeture du browser:', e);
    }
  }
})();
