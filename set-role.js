'use strict';
// Make someone the owner of the site, a moderator, or a regular player again.
//
//   node set-role.js Alice owner     (owners can ban anyone and manage moderators)
//   node set-role.js Bob mod         (moderators can ban and unban regular players)
//   node set-role.js Bob none
//
// Run it in this folder. It is the only way to create an owner, so nobody can
// promote themselves from the website. Safe to run while the server is running.
const store = require('./db');

const ROLES = { owner: 'owner', mod: 'mod', none: '' };
const [, , name, roleArg] = process.argv;

if (!name || !roleArg) {
  console.log('Usage: node set-role.js <username> <owner|mod|none>');
  process.exit(1);
}

const user = store.getUserByName(name);
if (!user) {
  console.error(`No player called "${name}". Check the spelling (it is not case sensitive).`);
  process.exit(1);
}

const key = roleArg.toLowerCase();
if (!(key in ROLES)) {
  console.error(`"${roleArg}" is not a role. Choose owner, mod or none.`);
  process.exit(1);
}

store.setRole(user.id, ROLES[key]);
store.logAction({
  actor_name: '(server command)',
  action: key === 'none' ? 'removed the role of' : `set the ${key === 'owner' ? 'owner' : 'moderator'} role for`,
  target_name: user.username,
});
console.log(key === 'none' ? `${user.username} is now a regular player.` : `${user.username} is now ${key === 'owner' ? 'an owner' : 'a moderator'}.`);
