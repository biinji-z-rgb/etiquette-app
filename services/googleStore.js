// services/googleStore.js
// Utilise un compte de service Google (gratuit) pour écrire chaque scan dans
// un Google Sheet PARTAGÉ (visible depuis tous les téléphones).
// Le stockage des PHOTOS se fait séparément via services/photoStore.js
// (Cloudinary), car les comptes de service Google n'ont aucun quota de
// stockage sur Drive (voir photoStore.js pour le détail).

const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

function getAuth() {
  // La clé du compte de service est fournie en variable d'environnement
  // GOOGLE_SERVICE_ACCOUNT_KEY (le contenu JSON du fichier téléchargé sur Google Cloud,
  // mis sur UNE seule ligne). Voir README.md pour la procédure complète.
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error(
      "Variable d'environnement GOOGLE_SERVICE_ACCOUNT_KEY manquante (voir README.md)"
    );
  }
  const credentials = JSON.parse(raw);
  return new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
}

const SPREADSHEET_ID = () => process.env.GOOGLE_SHEET_ID;
const SHEET_TAB_NAME = "Etiquettes";

const HEADERS = [
  "Numéro de tranche",
  "Numéro d'identification",
  "Texte",
  "Date et heure",
  "Photo",
];

async function getSheetsClient() {
  const auth = getAuth();
  return google.sheets({ version: "v4", auth });
}

/** Crée l'onglet + l'entête s'ils n'existent pas encore. À appeler une fois au démarrage. */
async function ensureSheetReady() {
  const sheets = await getSheetsClient();
  const spreadsheetId = SPREADSHEET_ID();

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(
    (s) => s.properties.title === SHEET_TAB_NAME
  );

  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_TAB_NAME } } }],
      },
    });
  }

  const range = `${SHEET_TAB_NAME}!A1:E1`;
  const current = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  if (!current.data.values || current.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
  }
}

/** Ajoute une ligne au Google Sheet partagé. */
async function appendRow({
  numeroTranche,
  numeroIdentification,
  texte,
  dateHeure,
  photoUrl,
}) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID(),
    range: `${SHEET_TAB_NAME}!A:E`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [
        [numeroTranche, numeroIdentification, texte, dateHeure, photoUrl],
      ],
    },
  });
}

/** Récupère toutes les lignes (sans l'entête) pour générer l'export .xlsx. */
async function getAllRows() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID(),
    range: `${SHEET_TAB_NAME}!A2:E`,
  });
  return res.data.values || [];
}

let cachedNumericSheetId = null;

/** Récupère l'ID numérique interne de l'onglet (nécessaire pour supprimer des lignes). */
async function getNumericSheetId() {
  if (cachedNumericSheetId !== null) return cachedNumericSheetId;
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID() });
  const tab = meta.data.sheets.find((s) => s.properties.title === SHEET_TAB_NAME);
  if (!tab) throw new Error(`Onglet "${SHEET_TAB_NAME}" introuvable.`);
  cachedNumericSheetId = tab.properties.sheetId;
  return cachedNumericSheetId;
}

/** Vide toutes les lignes de données (garde l'entête). */
async function clearAllRows() {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID(),
    range: `${SHEET_TAB_NAME}!A2:E`,
  });
}

/**
 * Supprime une ligne précise (index 0 = première ligne de données, sous
 * l'entête). Correspond à l'index renvoyé par getAllRows().
 */
async function deleteRow(dataRowIndex) {
  const sheets = await getSheetsClient();
  const sheetId = await getNumericSheetId();
  // +1 car la ligne 0 de la grille est l'entête ; la donnée d'index 0 est
  // donc la ligne 1 de la grille (0-based), soit la ligne 2 affichée dans Sheets.
  const startIndex = dataRowIndex + 1;
  const endIndex = startIndex + 1;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID(),
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex,
              endIndex,
            },
          },
        },
      ],
    },
  });
}

module.exports = {
  ensureSheetReady,
  appendRow,
  getAllRows,
  clearAllRows,
  deleteRow,
  HEADERS,
};
