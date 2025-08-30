const puppeteer = require('puppeteer');

async function savePageAsPDF(url, outputFile) {
    try {
        // Lance un navigateur Chrome/Chromium
        const browser = await puppeteer.launch({
            headless: true, // pas d'interface graphique
            defaultViewport: null, // utiliser toute la page
        });

        const page = await browser.newPage();

        // User-Agent réaliste pour éviter blocage
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log(`Chargement de la page : ${url}`);

        // Aller sur la page, sans timeout et sans attendre trop longtemps
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 0 });

        // Scroll automatique pour charger toutes les images lazy
        await autoScroll(page);

        // Attendre que les images soient présentes
        await page.waitForSelector('img', { timeout: 10000 });

        // Récupérer les URLs des images pour vérification
        const imgUrls = await page.$$eval('img', imgs => imgs.map(img => img.src));
        console.log("Images trouvées :", imgUrls);

        console.log(`💾 Sauvegarde en PDF : ${outputFile}`);

        // Sauvegarde en PDF
        await page.pdf({
            path: outputFile,
            format: "A4",
            printBackground: true,
        });

        await browser.close();
        console.log("✅ Terminé !");

    } catch (err) {
        console.error("❌ Erreur :", err);
    }
};

// Fonction de scroll automatique
async function autoScroll(page){
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;
                if(totalHeight >= document.body.scrollHeight){
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}

// Récupère l’URL et le nom du fichier depuis la ligne de commande
const args = process.argv.slice(2);
if (args.length < 2) {
    console.log("Usage: node saveToPDF.js <URL> <nom_fichier.pdf>");
    process.exit(1);
}

const url = args[0];
const outputFile = args[1];

savePageAsPDF(url, outputFile);
