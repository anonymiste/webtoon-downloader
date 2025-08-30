
# Webtoon Downloader (Frontend + Backend + Script)

## Démarrage
```bash
cd finished_webtoon_app
npm i
node server.js
```
Ouvre ensuite `index.html` dans ton navigateur, colle l'URL et clique **Lancer**.

## Lancement du script seul
```bash
node webtoon.js "<URL>"              # Dossier auto basé sur l'URL + PDF auto
node webtoon.js "<URL>" outdir.pdf   # Si tu veux forcer le nom du PDF
node webtoon.js "<URL>" dossier "mon-episode.pdf" --debug --wait=3000
```

## Notes
- Le bouton **Télécharger** s'active dès qu'on voit `📄 PDF généré : ...` ou via `__DONE__`, avec polling de secours.
- Si aucune image n'est détectée, le script génère au minimum une **capture fullPage** puis une **capture scroll assemblée** et sort un PDF.
