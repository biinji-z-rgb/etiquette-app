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

module.exports = {
  ensureSheetReady,
  appendRow,
  getAllRows,
  HEADERS,
};
