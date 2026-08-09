// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const ocr = require("./services/ocr");
const sheetsStore = require("./services/googleStore");
const photoStore = require("./services/photoStore");
const excelExport = require("./services/excelExport");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 Mo max par photo
});

// ---------------------------------------------------------------------------
// POST /api/scan
// Reçoit une photo, fait l'OCR, renvoie un brouillon des champs à valider.
// N'écrit encore RIEN dans le Google Sheet (validation obligatoire avant).
// ---------------------------------------------------------------------------
app.post("/api/scan", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Aucune photo reçue." });
    }

    const rawText = await ocr.recognizeText(req.file.buffer);
    const fields = ocr.parseFields(rawText);

    res.json({
      ok: true,
      draft: {
        numeroTranche: fields.numeroTranche,
        numeroIdentification: fields.numeroIdentification,
        texte: fields.texte,
        rawText: fields.rawText,
      },
    });
  } catch (err) {
    console.error("Erreur /api/scan :", err);
    res.status(500).json({ error: "Échec de la lecture OCR.", detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/validate
// Reçoit les champs CORRIGÉS par l'utilisateur + la photo, et enregistre
// définitivement dans le Google Sheet partagé + Google Drive.
// ---------------------------------------------------------------------------
app.post("/api/validate", upload.single("photo"), async (req, res) => {
  try {
    const { numeroTranche, numeroIdentification, texte } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "Photo manquante." });
    }

    const now = new Date();
    const dateHeure = now.toLocaleString("fr-FR", {
      timeZone: process.env.TZ || "Europe/Paris",
    });

    const filename = `etiquette_${uuidv4()}.jpg`;
    const photoUrl = await photoStore.uploadPhoto(req.file.buffer, filename);

    await sheetsStore.appendRow({
      numeroTranche: numeroTranche || "",
      numeroIdentification: numeroIdentification || "",
      texte: texte || "",
      dateHeure,
      photoUrl,
    });

    res.json({ ok: true, photoUrl, dateHeure });
  } catch (err) {
    console.error("Erreur /api/validate :", err);
    res.status(500).json({ error: "Échec de l'enregistrement.", detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/export-excel
// Génère et télécharge un vrai fichier .xlsx à partir de toutes les données
// actuellement dans le Google Sheet partagé.
// ---------------------------------------------------------------------------
app.get("/api/export-excel", async (req, res) => {
  try {
    const rows = await sheetsStore.getAllRows();
    const buffer = await excelExport.exportRowsToBuffer(rows);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="etiquettes_${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx"`
    );
    res.send(buffer);
  } catch (err) {
    console.error("Erreur /api/export-excel :", err);
    res.status(500).json({ error: "Échec de l'export.", detail: err.message });
  }
});

// Petite route de contrôle pour vérifier que le serveur + Google Sheet répondent
app.get("/api/health", async (req, res) => {
  try {
    await sheetsStore.ensureSheetReady();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
  try {
    await sheetsStore.ensureSheetReady();
    console.log("Google Sheet prêt.");
  } catch (err) {
    console.warn(
      "⚠️  Impossible d'initialiser le Google Sheet au démarrage :",
      err.message
    );
  }
});
