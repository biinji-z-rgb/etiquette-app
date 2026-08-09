// services/ocr.js
// OCR 100% gratuit avec Tesseract.js (tourne sur le serveur, aucune clé API,
// aucun coût). La précision est ensuite sécurisée par l'étape de VALIDATION
// manuelle côté app (l'utilisateur voit et corrige les champs avant l'enregistrement).

const { createWorker } = require("tesseract.js");
const sharp = require("sharp");

/**
 * Prépare l'image pour l'OCR : agrandit si besoin, passe en niveaux de gris,
 * renforce le contraste et la netteté. Ça améliore nettement la lecture de
 * texte gravé/imprimé sur des étiquettes métalliques ou plastiques.
 */
async function preprocessImage(buffer) {
  const meta = await sharp(buffer).metadata();
  let pipeline = sharp(buffer);

  // Agrandit les petites photos pour donner plus de détail à l'OCR
  if (meta.width && meta.width < 1200) {
    pipeline = pipeline.resize({ width: 1200 });
  }

  return pipeline
    .grayscale()
    .normalize() // étire le contraste sur toute la plage disponible
    .sharpen()
    .threshold(150) // noir & blanc franc : aide beaucoup sur du texte gravé
    .toBuffer();
}

/**
 * Lance l'OCR sur l'image (buffer) et renvoie le texte brut détecté.
 * lang "fra" = français. On peut mettre "fra+eng" si les étiquettes
 * mélangent des mots anglais/techniques.
 */
async function recognizeText(buffer) {
  const processed = await preprocessImage(buffer);

  const worker = await createWorker("fra");
  try {
    // PSM 6 = "un seul bloc de texte uniforme", plus adapté à une étiquette
    // qu'à une page complète.
    await worker.setParameters({ tessedit_pageseg_mode: "6" });
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
