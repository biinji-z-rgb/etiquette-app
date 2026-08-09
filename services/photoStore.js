// services/photoStore.js
// Stocke les photos sur Cloudinary (offre gratuite, aucune carte bancaire requise).
//
// Pourquoi pas Google Drive ? Un compte de service Google n'a AUCUN quota de
// stockage personnel (0 octet) : il ne peut donc jamais déposer de fichier
// dans Drive, même dans un dossier partagé en "Éditeur" avec lui. C'est une
// limite de Google (voir "storageQuotaExceeded"), pas un bug de cette app.
// Cloudinary est un hébergeur d'images gratuit qui fonctionne très bien avec
// une simple clé API, sans ce problème.

const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/**
 * Upload une photo (buffer) sur Cloudinary et renvoie son URL publique.
 */
function uploadPhoto(buffer, filename) {
  return new Promise((resolve, reject) => {
    if (
      !process.env.CLOUDINARY_CLOUD_NAME ||
      !process.env.CLOUDINARY_API_KEY ||
      !process.env.CLOUDINARY_API_SECRET
    ) {
      return reject(
        new Error(
          "Variables CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET manquantes (voir README.md)"
        )
      );
    }

    const publicId = filename.replace(/\.[^/.]+$/, "");
    const stream = cloudinary.uploader.upload_stream(
      { folder: "etiquettes", public_id: publicId, resource_type: "image" },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

module.exports = { uploadPhoto };
