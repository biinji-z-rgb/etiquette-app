# Scan Étiquettes → Excel partagé

App web mobile (pas d'installation, s'ouvre dans le navigateur du téléphone) qui :
1. prend une photo d'une étiquette,
2. lit le texte automatiquement (OCR gratuit, Tesseract.js),
3. te fait **valider/corriger** les champs avant enregistrement,
4. enregistre dans un **Google Sheet partagé** (visible en direct depuis tous les téléphones connectés — c'est le "fichier Excel commun"),
5. permet de **télécharger un vrai fichier .xlsx** à tout moment.

Colonnes enregistrées : `Numéro de tranche` / `Numéro d'identification` / `Texte` / `Date et heure` / `Photo` (lien).

---

## Pourquoi un Google Sheet et pas un fichier .xlsx stocké directement sur Render ?

Sur le plan **gratuit** de Render, le disque du serveur est **temporaire** : il est
effacé à chaque redéploiement et le service s'endort après 15 min d'inactivité.
Un vrai fichier Excel stocké sur le serveur serait donc perdu régulièrement, et rien
ne serait "commun" entre les téléphones de façon fiable.

Solution 100% gratuite : les données sont écrites en direct dans un **Google Sheet**
(qui EST déjà un tableur, modifiable/exportable comme un Excel). Le bouton
"Télécharger le fichier Excel" génère à la demande un vrai `.xlsx` à partir de ces
données.

## Pourquoi Cloudinary et pas Google Drive pour les photos ?

Un compte de service Google (celui qu'on crée à l'étape 1c) n'a **aucun quota de
stockage personnel** sur Drive (0 octet) : Google lui refuse donc systématiquement
le dépôt de fichiers, même dans un dossier partagé en "Éditeur" avec lui (erreur
`storageQuotaExceeded`). C'est une limite propre à Google, pas un bug de cette app,
et il n'y a pas de contournement gratuit pour un compte Gmail personnel (seuls les
comptes Google Workspace payants ont accès aux "Drives partagés" qui règlent ce
problème).

**Cloudinary** est un hébergeur d'images gratuit (sans carte bancaire requise sur
son offre gratuite) qui fonctionne simplement avec une clé API, sans ce problème de
quota. C'est lui qui stocke les photos ; le lien vers chaque photo est ensuite
enregistré dans la colonne "Photo" du Google Sheet.

---

## 1. Configuration Google (gratuit, ~10 min, une seule fois)

### a) Crée le Google Sheet partagé
1. Va sur https://sheets.google.com → crée un nouveau classeur, nomme-le par ex. `Etiquettes`.
2. Récupère son ID dans l'URL : `https://docs.google.com/spreadsheets/d/**CET_ID**/edit`.

### b) Crée un compte de service Google Cloud (gratuit)
1. Va sur https://console.cloud.google.com → crée un projet (gratuit).
2. Menu **APIs & Services → Bibliothèque** : active
   - **Google Sheets API**
   - **Google Drive API**
3. Menu **APIs & Services → Identifiants → Créer des identifiants → Compte de service**.
   Donne-lui un nom (ex. `etiquette-app`), pas besoin de rôle particulier.
4. Ouvre le compte de service créé → onglet **Clés → Ajouter une clé → JSON**.
   Un fichier `.json` se télécharge : **garde-le précieusement, il ne se retélécharge pas**.
5. Dans ce fichier JSON, repère le champ `"client_email"` (ex. `etiquette-app@mon-projet.iam.gserviceaccount.com`).

### c) Partage le Sheet avec le compte de service
1. Ouvre ton Google Sheet → bouton **Partager** → colle l'adresse `client_email` → droit **Éditeur**.

Sans cette étape, le serveur n'aura pas le droit d'écrire dedans.

### d) Crée un compte Cloudinary gratuit (pour les photos)
1. Va sur https://cloudinary.com/users/register/free et crée un compte (gratuit, aucune carte bancaire requise).
2. Une fois connecté, va sur ton **Dashboard** — tu y trouveras directement :
   - **Cloud name**
   - **API Key**
   - **API Secret** (clique sur l'œil 👁 pour l'afficher)

---

## 2. Configuration du projet

### a) En local (test avant déploiement)
```bash
cd etiquette-app
npm install
cp .env.example .env
```
Édite `.env` :
- `GOOGLE_SERVICE_ACCOUNT_KEY` : colle **tout le contenu** du fichier JSON téléchargé à
  l'étape 1b, sur une seule ligne (tu peux utiliser un outil en ligne "JSON to single line"
  ou simplement supprimer les retours à la ligne).
- `GOOGLE_SHEET_ID` : l'ID récupéré à l'étape 1a.
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` : récupérés sur
  ton Dashboard Cloudinary (étape 1d).

Puis :
```bash
npm start
```
Ouvre `http://localhost:3000` sur ton téléphone (même réseau Wi-Fi que ton PC, remplace
`localhost` par l'IP locale de ton PC, ex. `http://192.168.1.20:3000`).

---

## 3. Déploiement sur Render.com (gratuit)

1. Mets ce dossier dans un dépôt GitHub (public ou privé).
2. Sur https://render.com → **New → Web Service** → connecte le dépôt.
3. Configuration :
   - **Environment** : `Node`
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : `Free`
4. Onglet **Environment** → ajoute les variables :
   - `GOOGLE_SERVICE_ACCOUNT_KEY` (le JSON sur une ligne)
   - `GOOGLE_SHEET_ID`
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_API_KEY`
   - `CLOUDINARY_API_SECRET`
   - `TZ` = `Europe/Paris`
5. Clique **Create Web Service**. Render te donne une URL du type
   `https://etiquette-scanner.onrender.com`.

**C'est cette URL que tu ouvres sur n'importe quel téléphone** (aucune installation,
aucun store) — tous les téléphones qui l'ouvrent partagent le même Google Sheet.

> Astuce : sur iPhone/Android, dans le navigateur, "Ajouter à l'écran d'accueil" donne
> une icône comme une vraie app, sans passer par un store.

⚠️ Le plan gratuit de Render "s'endort" après 15 min sans requête : le premier scan
après une pause peut prendre 30–60 secondes le temps que le serveur se réveille.
C'est normal et gratuit — si c'est gênant, un plan payant Render (~7$/mois) supprime
cette latence.

---

## 4. Adapter la lecture automatique à tes étiquettes

Le fichier `services/ocr.js` contient la fonction `parseFields()` qui essaie de
deviner le numéro de tranche et le numéro d'identification à partir du texte lu.
Elle est volontairement simple (recherche des mots "tranche" / "identification").

**Si tes étiquettes suivent un format fixe** (ex. toujours "T-12345 / ID:A0098"),
dis-moi le format exact et j'ajuste les expressions régulières pour une
reconnaissance automatique bien plus fiable — l'écran de validation restera dans
tous les cas là pour corriger les erreurs éventuelles.

---

## Structure du projet

```
etiquette-app/
├── server.js                 → routes API (scan / validate / export-excel)
├── services/
│   ├── ocr.js                → lecture du texte (Tesseract.js, gratuit)
│   ├── googleStore.js        → écriture Google Sheet + upload Google Drive
│   └── excelExport.js        → génère le vrai fichier .xlsx à la demande
├── public/
│   ├── index.html            → l'app mobile (page unique, aucune installation)
│   └── manifest.json         → permet "Ajouter à l'écran d'accueil"
├── package.json
└── .env.example
```
