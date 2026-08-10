// services/ocr.js
// OCR 100% gratuit avec Tesseract.js (tourne sur le serveur, aucune clé API,
// aucun coût).
//
// MÉTHODE "MULTI-PASSAGES" : les étiquettes existent en polarités opposées
// (texte clair sur fond foncé pour certaines, texte foncé sur fond clair pour
// d'autres) et avec un éclairage/reflets variables. Un seul traitement fixe
// ne peut pas bien gérer tous les cas. On génère donc PLUSIEURS versions
// prétraitées de la même photo, on fait lire chacune par l'OCR, et on garde
// automatiquement le résultat dans lequel Tesseract est le plus confiant.
// C'est plus lent (quelques secondes de plus) mais nettement plus fiable.

const { createWorker } = require("tesseract.js");
const sharp = require("sharp");

const TESSERACT_PARAMS = {
  // PSM 6 = "un seul bloc de texte uniforme", adapté à une étiquette.
  tessedit_pageseg_mode: "6",
  // Les étiquettes sont des codes alphanumériques en MAJUSCULES : on
  // interdit à l'OCR de proposer des minuscules ou symboles qu'il "invente"
  // parfois (ex: "vl" au lieu de "VL", "@" parasite...).
  tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .-/:",
  // Désactive la correction automatique basée sur le dictionnaire français :
  // contre-productive sur des codes/références (ex: "DEBIT" corrigé à tort
  // vers un autre mot proche du dictionnaire).
  load_system_dawg: "0",
  load_freq_dawg: "0",
};

/**
 * Calcule une image en niveaux de gris à partir du MINIMUM des 3 canaux
 * (R, G, B) de chaque pixel, plutôt que la formule de luminance standard.
 *
 * Pourquoi : la luminance classique donne un poids très fort au vert. Un
 * fond vert saturé peut alors ressortir presque aussi clair qu'un texte
 * blanc, ce qui détruit le contraste. Le "canal minimum" résout ça : du
 * blanc pur garde une valeur haute (R, G et B sont tous élevés), alors
 * qu'une couleur saturée (peu importe laquelle) a toujours au moins un
 * canal bas — donc un minimum bas. Résultat : le texte blanc reste clair,
 * et N'IMPORTE QUEL fond coloré ressort sombre, quelle que soit sa teinte.
 */
async function minChannelGrayscale(sharpInstance) {
  const redBuf = await sharpInstance.clone().extractChannel("red").toBuffer();
  const greenBuf = await sharpInstance.clone().extractChannel("green").toBuffer();
  const blueBuf = await sharpInstance.clone().extractChannel("blue").toBuffer();

  return sharp(redBuf)
    .composite([
      { input: greenBuf, blend: "darken" },
      { input: blueBuf, blend: "darken" },
    ])
    .removeAlpha()
    .toColorspace("b-w")
    .toBuffer();
}

/**
 * Génère plusieurs versions prétraitées de la photo, pensées pour couvrir
 * les cas courants : texte foncé sur fond clair, texte clair sur fond foncé,
 * texte clair sur fond COLORÉ (vert, bleu...), et une version "douce" sans
 * binarisation forcée pour les cas intermédiaires.
 */
async function buildVariants(buffer) {
  const targetWidth = 2000;

  const oriented = sharp(buffer).rotate();
  const meta = await oriented.metadata();

  let base = sharp(buffer).rotate();
  if (!meta.width || meta.width < targetWidth) {
    base = base.resize({ width: targetWidth });
  } else if (meta.width > 2600) {
    base = base.resize({ width: 2600 });
  }
  const baseBuffer = await base.toBuffer();

  // Version de base : niveaux de gris classiques + contraste adaptatif local.
  const soft = await sharp(baseBuffer)
    .grayscale()
    .median(1)
    .clahe({ width: 40, height: 40, maxSlope: 3 })
    .sharpen({ sigma: 1.2 })
    .toBuffer();

  const binaryNormal = await sharp(soft).threshold(140).toBuffer();
  const binaryInverted = await sharp(soft).threshold(140).negate().toBuffer();

  // Version "canal minimum" : spécifiquement pour texte clair sur fond
  // coloré (vert, bleu, rouge...), voir minChannelGrayscale() ci-dessus.
  const minChannel = await minChannelGrayscale(sharp(baseBuffer));
  const minChannelEnhanced = await sharp(minChannel)
    .median(1)
    .clahe({ width: 40, height: 40, maxSlope: 3 })
    .sharpen({ sigma: 1.2 })
    .toBuffer();
  const minChannelBinary = await sharp(minChannelEnhanced).threshold(120).toBuffer();

  return [
    { label: "doux", buffer: soft },
    { label: "binaire", buffer: binaryNormal },
    { label: "binaire inversé", buffer: binaryInverted },
    { label: "fond coloré", buffer: minChannelBinary },
  ];
}

/**
 * Fait lire une image par Tesseract et renvoie le texte + un score de
 * confiance moyen (0-100).
 */
async function runOcrOnce(worker, buffer) {
  const {
    data: { text, confidence },
  } = await worker.recognize(buffer);
  return { text: (text || "").trim(), confidence: confidence || 0 };
}

/**
 * Lance l'OCR sur l'image en testant plusieurs prétraitements, et renvoie
 * le texte du passage le plus fiable (meilleure confiance moyenne, ou à
 * défaut le texte le plus long en cas d'égalité).
 */
async function recognizeText(buffer) {
  const variants = await buildVariants(buffer);

  const worker = await createWorker("fra");
  try {
    await worker.setParameters(TESSERACT_PARAMS);

    const results = [];
    for (const variant of variants) {
      try {
        const result = await runOcrOnce(worker, variant.buffer);
        results.push({ ...result, label: variant.label });
      } catch (err) {
        console.warn(`OCR échoué sur variante "${variant.label}" :`, err.message);
      }
    }

    if (results.length === 0) return "";

    results.sort((a, b) => {
      // Priorité à la confiance moyenne de Tesseract ; en cas de quasi-égalité
      // (moins de 5 points d'écart), on préfère le texte le plus long, qui
      // indique souvent une lecture plus complète.
      if (Math.abs(b.confidence - a.confidence) > 5) {
        return b.confidence - a.confidence;
      }
      return b.text.length - a.text.length;
    });

    return results[0].text;
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
    const firstLineMatch = lines[0].match(
      /^(\d{1,3})\s+([A-Z]{1,4}\s*\d{1,4}\s*[A-Z]{1,4})/i
    );

    if (firstLineMatch) {
      numeroTranche = firstLineMatch[1].trim();
      numeroIdentification = firstLineMatch[2].replace(/\s+/g, " ").trim();
      texte = lines.slice(1).join(" ").trim();
    } else {
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
