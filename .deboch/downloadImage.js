const fs = require("fs");
const axios = require("axios");

async function  download(url, path) {
    try {
        const response = await axios({
            url,
            method: "GET",
            responseType: "stream",
        });

        response.data.pipe(fs.createWriteStream(path));

        console.log(`Image téléchargée avec succès : ${path}`);
    } catch(error) {
         console.error('Erreur lors du téléchargement : ', error.message);
    }
}

download("https://www.webtoons.com/fr/romance/bittersweet-sweetheart/ep-1/viewer?title_no=8395&episode_no=1", "image.pdf");

// meCode