'use strict';
// Give a player a chess title badge (GM, IM, ...), or remove it.
//
//   node set-title.js Alice GM
//   node set-title.js Alice none
//
// Run it in this folder. It is safe to run while the server is running;
// the badge shows up in new pages and new games straight away.
const store = require('./db');

const TITLES = ['GM', 'IM', 'FM', 'CM', 'WGM', 'WIM', 'WFM', 'WCM', 'NM'];
const [, , name, titleArg] = process.argv;

if (!name || !titleArg) {
  console.log('Usage: node set-title.js <username> <title|none>');
  console.log('Titles: ' + TITLES.join(', '));
  process.exit(1);
}

const user = store.getUserByName(name);
if (!user) {
  console.error(`No player called "${name}". Check the spelling (it is not case sensitive).`);
  process.exit(1);
}

const title = titleArg.toUpperCase() === 'NONE' ? '' : titleArg.toUpperCase();
if (title && !TITLES.includes(title)) {
  console.error(`"${titleArg}" is not a known title. Choose one of: ${TITLES.join(', ')}, or "none".`);
  process.exit(1);
}

store.setTitle(user.id, title);
console.log(title ? `${user.username} is now ${title}.` : `Removed the title from ${user.username}.`);
