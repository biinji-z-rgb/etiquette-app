// services/excelExport.js
// Génère un vrai fichier .xlsx (téléchargeable) à partir des lignes stockées
// dans le Google Sheet partagé. Utilise exceljs (équivalent Node d'openpyxl).

const ExcelJS = require("exceljs");
const { HEADERS } = require("./googleStore");

async function buildWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Etiquette Scanner";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Etiquettes");

  sheet.columns = [
    { header: HEADERS[0], key: "tranche", width: 22 },
    { header: HEADERS[1], key: "id", width: 24 },
    { header: HEADERS[2], key: "texte", width: 40 },
    { header: HEADERS[3], key: "date", width: 20 },
    { header: HEADERS[4], key: "photo", width: 45 },
  ];

  // Style de l'entête
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, name: "Arial", color: { argb: "FFFFFFFF" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF2F5233" },
  };
  headerRow.alignment = { vertical: "middle", horizontal: "center" };

  rows.forEach((r) => {
    const [tranche, id, texte, date, photoUrl] = r;
    const row = sheet.addRow({
      tranche,
      id,
      texte,
      date,
      photo: photoUrl,
    });
    row.font = { name: "Arial", size: 11 };
    // La colonne photo devient un vrai lien cliquable vers l'image (Google Drive)
    if (photoUrl) {
      const photoCell = row.getCell("photo");
      photoCell.value = { text: "Voir la photo", hyperlink: photoUrl };
      photoCell.font = { name: "Arial", size: 11, color: { argb: "FF1155CC" }, underline: true };
    }
  });

  sheet.getColumn("date").alignment = { horizontal: "left" };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  return workbook;
}

async function exportRowsToBuffer(rows) {
  const workbook = await buildWorkbook(rows);
  return workbook.xlsx.writeBuffer();
}

module.exports = { exportRowsToBuffer };
