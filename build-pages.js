// Builds the "pages-site" folder: the website's front end as plain files, ready to upload to
// GitHub Pages (or any static host). The game server is hosted separately; its address is
// written into config.js.
//
//   node build-pages.js https://kingside.onrender.com
//   (or set SERVER_URL)
const fs = require('fs');
const path = require('path');

const server = (process.argv[2] || process.env.SERVER_URL || 'https://YOUR-SERVER.onrender.com').replace(/\/+$/, '');
const out = path.join(__dirname, 'pages-site');
const bin = path.join(__dirname, 'node_modules', 'stockfish', 'bin');

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(__dirname, 'public'), out, { recursive: true });

// Stockfish (small build) and chess.js must sit next to the pages: browsers only run workers from the same address.
const engineFile = fs.existsSync(bin) && fs.readdirSync(bin).find((f) => /^stockfish-[\d.]+-lite-single\.js$/.test(f));
if (!engineFile) { console.error('Stockfish is missing. Run "npm install" first.'); process.exit(1); }
const version = /^stockfish-([\d.]+)-/.exec(engineFile)[1];
fs.mkdirSync(path.join(out, 'engine'), { recursive: true });
for (const f of [engineFile, engineFile.replace(/\.js$/, '.wasm')]) fs.copyFileSync(path.join(bin, f), path.join(out, 'engine', f));
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'node_modules', 'chess.js', 'dist', 'esm', 'chess.js'), path.join(out, 'vendor', 'chess.js'));

const config = {
  server,
  localEngine: { script: 'engine/' + engineFile, version, build: 'lite-single', label: 'Stockfish ' + version + ' (lite)', chessModule: './vendor/chess.js' },
};
fs.writeFileSync(path.join(out, 'config.js'),
  '/* Written by build-pages.js. `server` is where the Kingside game server lives. */\nwindow.KINGSIDE = ' + JSON.stringify(config, null, 2) + ';\n' +
  fs.readFileSync(path.join(__dirname, 'public', 'config.js'), 'utf8').replace(/^[\s\S]*?\n\(function/, '(function'));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log('Built pages-site/ for server ' + server);
if (/YOUR-SERVER/.test(server)) console.log('Note: the server address is still a placeholder. Run: node build-pages.js https://your-server-address');
