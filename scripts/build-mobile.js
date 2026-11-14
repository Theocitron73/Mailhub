'use strict';

/**
 * Prépare le contenu de l'application Android (mobile/www) :
 * - l'interface (renderer/) avec l'adaptateur mobile à la place de l'adaptateur web ;
 * - le moteur mail (mobile/nodejs/index.js + src/ + dépendances) rassemblé en un seul fichier
 *   pour le Node.js embarqué.
 * Ensuite : cd mobile && npx cap sync android
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const www = path.join(root, 'mobile', 'www');
const pkg = require(path.join(root, 'package.json'));

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });

// 1. Interface
const skip = new Set(['mailhub-web.js']);
for (const entry of fs.readdirSync(path.join(root, 'renderer'))) {
  if (skip.has(entry)) continue;
  fs.cpSync(path.join(root, 'renderer', entry), path.join(www, entry), { recursive: true });
}
const indexFile = path.join(www, 'index.html');
let html = fs.readFileSync(indexFile, 'utf8');
if (!html.includes('<script src="mailhub-web.js"></script>')) throw new Error('index.html : adaptateur web introuvable');
html = html
  .replace('<script src="mailhub-web.js"></script>', '<script src="mailhub-mobile.js"></script>')
  .replace('<body class="view-mail">', '<body class="view-mail mobile">')
  .replace('<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">');
fs.writeFileSync(indexFile, html);
fs.writeFileSync(path.join(www, 'version.js'), `window.MAILHUB_VERSION = ${JSON.stringify(pkg.version)};\n`);
// Capacitor (registerPlugin) : fichier autonome fourni par @capacitor/core
const capacitorJs = path.join(root, 'mobile', 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js');
if (!fs.existsSync(capacitorJs)) throw new Error('Lancez d’abord « npm install » dans le dossier mobile.');
fs.copyFileSync(capacitorJs, path.join(www, 'capacitor.js'));
fs.writeFileSync(indexFile, fs.readFileSync(indexFile, 'utf8').replace('<script src="mailhub-mobile.js"></script>',
  '<script src="capacitor.js"></script>\n  <script src="version.js"></script>\n  <script src="mailhub-mobile.js"></script>'));

// 2. Moteur mail pour Node.js embarqué
const nodeDir = path.join(www, 'nodejs');
fs.mkdirSync(nodeDir, { recursive: true });
esbuild.buildSync({
  entryPoints: [path.join(root, 'mobile', 'nodejs', 'index.js')],
  outfile: path.join(nodeDir, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['bridge'],
  legalComments: 'none',
  logLevel: 'warning',
});
fs.writeFileSync(path.join(nodeDir, 'package.json'), JSON.stringify({ name: 'mailhub-engine', version: pkg.version, main: 'index.js', private: true }, null, 2));

const size = fs.statSync(path.join(nodeDir, 'index.js')).size;
console.log(`mobile/www prêt (MailHub ${pkg.version}, moteur ${(size / 1024 / 1024).toFixed(1)} Mo)`);
