// services/ocr.js
// OCR 100% gratuit avec Tesseract.js (tourne sur le serveur, aucune clé API,
// aucun coût).
//
// MÉTHODE "MULTI-PASSAGES INTELLIGENTS" : les étiquettes existent en polarités
// opposées (texte clair sur fond foncé pour certaines, texte foncé sur fond
// clair pour d'autres) et avec un éclairage/reflets variables. Un seul
// traitement fixe ne peut pas bien gérer tous les cas.
//
// Plutôt que de tester bêtement 4 versions prétraitées en série à chaque
// scan (lent), on :
//   1. Garde 2 workers Tesseract PERSISTANTS, créés une seule fois (au
//      premier scan suivant un déploiement/redémarrage), puis réutilisés
//      pour tous les scans suivants — évite de recharger le modèle de
//      langue à chaque photo (gros gain de temps à partir du 2e scan).
//   2. Analyse rapidement les couleurs moyennes de la photo pour deviner
//      quel(s) prétraitement(s) a/ont le plus de chances de fonctionner
//      (fond coloré ? fond clair ? fond sombre ?), et ne lance QUE ceux-là,
//      en parallèle sur les 2 workers.
//   3. Si le résultat n'est pas assez fiable (faible confiance), lance
//      automatiquement les variantes restantes en renfort. La fiabilité
//      finale est donc identique au système précédent (rien n'est
//      sacrifié) — seul le cas "facile" (la majorité des scans) devient
//      nettement plus rapide.

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

// En dessous de ce score de confiance moyenne (0-100), on ne fait pas
// confiance au résultat obtenu avec les variantes "rapides" choisies par
// l'heuristique, et on relance les variantes restantes en renfort.
const CONFIDENCE_FALLBACK_THRESHOLD = 45;

// ---------------------------------------------------------------------------
// POOL DE WORKERS TESSERACT PERSISTANTS
// ---------------------------------------------------------------------------
// Créés une seule fois (au premier scan après le démarrage/redéploiement du
// serveur), puis réutilisés indéfiniment pour tous les scans suivants. Deux
// workers permettent de traiter deux variantes en parallèle sans dépasser
// la mémoire disponible sur un plan gratuit.
const WORKER_POOL_SIZE = 2;
let workerPoolPromise = null;

async function getWorkerPool() {
  if (!workerPoolPromise) {
    workerPoolPromise = (async () => {
      const workers = [];
      for (let i = 0; i < WORKER_POOL_SIZE; i++) {
        const worker = await createWorker("fra");
        await worker.setParameters(TESSERACT_PARAMS);
        workers.push(worker);
      }
      console.log(`OCR : pool de ${WORKER_POOL_SIZE} workers Tesseract prêt.`);
      return workers;
    })();
  }
  return workerPoolPromise;
}

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
 * Prépare l'image de base (rotation EXIF, redimensionnement, rognage auto
 * des bords uniformes). Retourne le buffer prêt à être décliné en variantes.
 */
async function prepareBaseImage(buffer) {
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

  // Rognage automatique : élimine les bords uniformes (table, fond, cadre en
  // trop) qui n'auraient pas été parfaitement exclus par le cadrage manuel.
  try {
    return await sharp(baseBuffer).trim({ threshold: 15 }).toBuffer();
  } catch {
    // Si le rognage échoue (image trop uniforme, etc.), on garde l'originale.
    return baseBuffer;
  }
}

/**
 * Analyse rapide (quelques millisecondes, pas d'OCR) des couleurs moyennes
 * de l'image pour deviner quelles variantes de prétraitement ont le plus
 * de chances de bien fonctionner, et dans quel ordre les essayer.
 *
 * Renvoie un tableau de labels ordonnés par priorité, ex:
 *   ["fond coloré", "binaire inversé", "doux", "binaire"]
 */
async function rankVariantsByHeuristic(croppedBuffer) {
  const stats = await sharp(croppedBuffer).stats();
  const [r, g, b] = stats.channels;
  const means = [r.mean, g.mean, b.mean];
  const maxMean = Math.max(...means);
  const minMean = Math.min(...means);
  const colorfulness = maxMean - minMean; // écart entre canaux = "à quel point c'est coloré"
  const brightness = means.reduce((a, c) => a + c, 0) / means.length;

  if (colorfulness > 20) {
    // Fond nettement coloré (vert, bleu, rouge...) : le canal minimum est
    // fait exactement pour ça.
    return ["fond coloré", "binaire inversé", "doux", "binaire"];
  }
  if (brightness < 110) {
    // Fond globalement sombre / neutre (noir, gris foncé...) : texte
    // probablement clair dessus.
    return ["binaire inversé", "doux", "fond coloré", "binaire"];
  }
  // Cas le plus courant : fond clair/blanc/gris, texte foncé.
  return ["binaire", "doux", "binaire inversé", "fond coloré"];
}

/**
 * Construit le buffer prétraité correspondant à UN SEUL label de variante,
 * à la demande (pas de travail inutile sur les variantes non retenues).
 * Met en cache les étapes intermédiaires partagées ("doux" et "canal
 * minimum") au sein d'un même appel via le paramètre `cache`.
 */
async function buildVariantBuffer(label, croppedBuffer, cache) {
  if (!cache.soft) {
    cache.soft = sharp(croppedBuffer)
      .grayscale()
      .median(1)
      .clahe({ width: 40, height: 40, maxSlope: 3 })
      .sharpen({ sigma: 1.2 })
      .toBuffer();
  }
  if (!cache.minChannelBinary) {
    cache.minChannelBinary = (async () => {
      const minChannel = await minChannelGrayscale(sharp(croppedBuffer));
      const enhanced = await sharp(minChannel)
        .median(1)
        .clahe({ width: 40, height: 40, maxSlope: 3 })
        .sharpen({ sigma: 1.2 })
        .toBuffer();
      return sharp(enhanced).threshold(120).toBuffer();
    })();
  }

  switch (label) {
    case "doux":
      return cache.soft;
    case "binaire":
      return sharp(await cache.soft).threshold(140).toBuffer();
    case "binaire inversé":
      return sharp(await cache.soft).threshold(140).negate().toBuffer();
    case "fond coloré":
      return cache.minChannelBinary;
    default:
      throw new Error(`Variante OCR inconnue : ${label}`);
  }
}

/**
 * Fait lire une image par Tesseract et renvoie le texte + un score de
 * confiance moyen (0-100).
 */
async function runOcrOnce(worker, buffer, label) {
  const {
    data: { text, confidence },
  } = await worker.recognize(buffer);
  return { text: (text || "").trim(), confidence: confidence || 0, label };
}

/**
 * Lance l'OCR sur les labels demandés, en parallèle sur le pool de workers.
 */
async function runLabelsInParallel(labels, croppedBuffer, cache) {
  const pool = await getWorkerPool();
  const results = await Promise.all(
    labels.map(async (label, i) => {
      try {
        const buffer = await buildVariantBuffer(label, croppedBuffer, cache);
        const worker = pool[i % pool.length];
        return await runOcrOnce(worker, buffer, label);
      } catch (err) {
        console.warn(`OCR échoué sur variante "${label}" :`, err.message);
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

/**
 * Lance l'OCR sur l'image en testant intelligemment les prétraitements les
 * plus prometteurs en premier (en parallèle), et complète avec les autres
 * seulement si nécessaire. Renvoie le texte du passage le plus fiable.
 */
async function recognizeText(buffer) {
  const croppedBuffer = await prepareBaseImage(buffer);
  const rankedLabels = await rankVariantsByHeuristic(croppedBuffer);
  const cache = {};

  // Étape 1 : les 2 variantes jugées les plus prometteuses, en parallèle.
  const fastLabels = rankedLabels.slice(0, 2);
  let results = await runLabelsInParallel(fastLabels, croppedBuffer, cache);

  const bestSoFar = results.length
    ? Math.max(...results.map((r) => r.confidence))
    : 0;

  // Étape 2 (renfort, seulement si besoin) : si aucun résultat n'est assez
  // fiable, on teste aussi les variantes restantes. Garantit qu'on ne perd
  // jamais en fiabilité par rapport à l'ancien système "tout tester".
  if (bestSoFar < CONFIDENCE_FALLBACK_THRESHOLD) {
    const remainingLabels = rankedLabels.slice(2);
    const extraResults = await runLabelsInParallel(remainingLabels, croppedBuffer, cache);
    results = results.concat(extraResults);
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
    // Tolère un tiret ou un espace parasite entre les groupes (l'OCR n'est
    // jamais parfait à 100% : mieux vaut remplir les champs de façon
    // imparfaite - modifiable en un clic - que de tout basculer en texte brut.
    const firstLineMatch = lines[0].match(
      /^(\d{1,3})\s+([A-Z]{1,4}[\s-]{0,3}\d{1,4}[\s-]{0,3}[A-Z]{1,4})/i
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
