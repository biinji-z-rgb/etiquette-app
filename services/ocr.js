// services/ocr.js
// OCR 100% gratuit avec Tesseract.js (tourne sur le serveur, aucune clé API,
// aucun coût). La précision est ensuite sécurisée par l'étape de VALIDATION
// manuelle côté app (l'utilisateur voit et corrige les champs avant l'enregistrement).

const { createWorker } = require("tesseract.js");
const sharp = require("sharp");

/**
 * Prépare l'image pour l'OCR : agrandit si besoin, passe en niveaux de gris,
 * réduit le bruit, égalise le contraste localement (gère bien les reflets et
 * ombres sur du métal/plastique), puis renforce la netteté.
 *
 * Important : on n'utilise PLUS de seuillage noir & blanc strict (threshold).
 * Sur une étiquette avec un léger reflet ou un éclairage inégal, un seuil fixe
 * "mange" une partie des lettres d'un côté de l'image. L'égalisation adaptative
 * (CLAHE) s'ajuste localement et donne un texte bien plus lisible pour l'OCR.
 */
async function preprocessImage(buffer) {
  const meta = await sharp(buffer).metadata();
  const targetWidth = 1600;
  let pipeline = sharp(buffer);

  if (!meta.width || meta.width < targetWidth) {
    pipeline = pipeline.resize({ width: targetWidth });
  }

  return pipeline
    .grayscale()
    .median(1) // léger débruitage (grain capteur du téléphone)
    .clahe({ width: 40, height: 40, maxSlope: 3 }) // contraste adaptatif local
    .sharpen({ sigma: 1.2 })
    .toBuffer();
}

/**
 * Lance l'OCR sur l'image (buffer) et renvoie le texte brut détecté.
 */
async function recognizeText(buffer) {
  const processed = await preprocessImage(buffer);

  const worker = await createWorker("fra");
  try {
    await worker.setParameters({
      // PSM 6 = "un seul bloc de texte uniforme", adapté à une étiquette.
      tessedit_pageseg_mode: "6",
      // Les étiquettes sont des codes alphanumériques en MAJUSCULES : on
      // interdit à l'OCR de proposer des minuscules ou symboles qu'il
      // "invente" parfois (ex: "vl" au lieu de "VL", "@" parasite...).
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .-/:",
      // Désactive la correction automatique basée sur le dictionnaire
      // français : très utile pour du texte normal, mais contre-productive
      // sur des codes/références (ex: "DEBIT" corrigé à tort vers un autre
      // mot proche du dictionnaire).
      load_system_dawg: "0",
      load_freq_dawg: "0",
    });
    const {
      data: { text },
    } = await worker.recognize(processed);
    return text;
  } finally {
    await worker.terminate();
  }
}

/**
 * Essaie de deviner automatiquement les champs à partir du texte OCR.
 *
 * Format réel des étiquettes (confirmé) :
 *   Ligne 1 : "<chiffre de tranche>  <lettres> <nombre> <lettres>"
 *             ex. "2 STR 215 VL"  ou  "1 JDT 899 CR"
 *   Lignes suivantes (optionnelles) : texte libre
 *             ex. "SOUP.SUR.SECON" / "031RP"
 *
 *   => Numéro de tranche         = le chiffre isolé en tout début de ligne 1
 *   => Numéro d'identification   = le reste de la ligne 1 ("STR 215 VL")
 *   => Texte                     = tout ce qui suit sur les lignes d'après
 *
 * Si le format ne matche pas (photo floue, étiquette différente...), les
 * champs restent vides et l'utilisateur les remplit/corrige manuellement
 * dans l'écran de validation - rien n'est jamais perdu.
 */
function parseFields(rawText) {
  const lines = rawText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let numeroTranche = "";
  let numeroIdentification = "";
  let texte = "";

  if (lines.length > 0) {
    // Ligne 1 attendue : un chiffre, puis lettres/chiffres (ex: "2 STR 215 VL")
    const firstLineMatch = lines[0].match(
      /^(\d{1,3})\s+([A-Z]{1,4}\s*\d{1,4}\s*[A-Z]{1,4})/i
    );

    if (firstLineMatch) {
      numeroTranche = firstLineMatch[1].trim();
      // normalise les espaces multiples dans l'identifiant
      numeroIdentification = firstLineMatch[2].replace(/\s+/g, " ").trim();
      texte = lines.slice(1).join(" ").trim();
    } else {
      // Le format attendu n'a pas été reconnu : on ne devine rien pour la
      // tranche/l'identification, tout le texte brut part dans "texte"
      // pour que l'utilisateur puisse corriger facilement.
      texte = lines.join(" | ");
    }
  }

  return {
    numeroTranche,
    numeroIdentification,
    texte,
    rawText,
  };
}

module.exports = { recognizeText, parseFields };
