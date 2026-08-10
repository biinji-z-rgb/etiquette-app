// services/photoStore.js
// Stocke les photos sur Cloudinary via un UPLOAD NON SIGNÉ.
//
// Pourquoi non signé ? L'upload "signé" classique nécessite de calculer une
// signature avec l'API Secret : la moindre variable mal copiée (espace,
// guillemet, retour à la ligne...) donne une erreur "Invalid Signature"
// difficile à diagnostiquer. L'upload NON SIGNÉ n'a besoin que du nom du
// cloud + d'un "upload preset" public : plus aucun risque de ce type
// d'erreur, et c'est tout aussi gratuit et sécurisé pour cet usage.
//
// Pourquoi pas Google Drive ? Voir la note dans googleStore.js /README.md :
// un compte de service Google n'a aucun quota de stockage sur Drive.

async function uploadPhoto(buffer, filename) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;

  if (!cloudName || !uploadPreset) {
    throw new Error(
      "Variables CLOUDINARY_CLOUD_NAME / CLOUDINARY_UPLOAD_PRESET manquantes (voir README.md)"
    );
  }

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "image/jpeg" }), filename);
  form.append("upload_preset", uploadPreset);
  form.append("folder", "etiquettes");

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    { method: "POST", body: form }
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      "Échec de l'upload Cloudinary : " +
        (data.error?.message || res.statusText)
    );
  }

  return data.secure_url;
}

module.exports = { uploadPhoto };
