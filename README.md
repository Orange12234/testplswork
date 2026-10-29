# Kingside

A small chess site where you can play a friend through an invite link or get matched with a random opponent. It has accounts, Elo ratings, game clocks, chat and a rematch button.

## Run it

You need Node.js 22.13 or newer (the current LTS from nodejs.org is fine). Run `node -v` to check.

```bash
npm install
npm start
```

Open http://localhost:3000. To try it alone, open the site in two browser tabs (each tab is its own guest), start a game in one and open the invite link in the other.

Environment variables:

| Variable  | Default        | Purpose                          |
|-----------|----------------|----------------------------------|
| `PORT`    | `3000`         | Port the server listens on       |
| `DB_PATH` | `./chess.db`   | Where the SQLite database is kept |

## How it plays

- **Invite a friend**: pick a time limit and colour, press "Invite a friend", and send the link. The game starts when they open it. Friend games are casual.
- **Random opponent**: pick a time limit and press "Play a random opponent". The first two people waiting on the same time limit are paired with random colours. The game is rated when both players are logged in.
- **Guests** can play everything except rated games. Guest names look like `Guest-1a2b`.
- **Clocks** run on the server, so they can't be cheated. They start once both players have made their first move. A game is aborted, with no rating change, if a side doesn't make its first move within 60 seconds. Resigning before both players have moved also counts as an abort.
- **Rules** (castling, en passant, promotion, check, checkmate, stalemate, insufficient material, threefold repetition, fifty-move rule) come from the `chess.js` library. The server checks every move.
- **Ratings** are separate for Bullet, Blitz and Rapid, so a game only changes the rating for its own category. Each starts at 1200 and uses Elo with K = 32. A game's category comes from its clock (the minutes plus 40 times the seconds added per move): under 3 minutes is Bullet (1+0), under 8 minutes is Blitz (3+0, 3+2, 5+0, 5+3), and 8 or more is Rapid (10+0, 15+10). Profiles show all three, and the top-players list has a tab for each. Where only one number fits (the top bar and search results), it is the rating for the category you have played most.
- **Upgrading from one rating per player.** The first time this version starts on an existing database, each player's old rating is split by replaying the rated games in the history: their rating in a category becomes 1200 plus the points they won or lost in that category. Nobody's total changes, and it only happens once.
- Anyone with a game link who isn't a player can watch the game but can't move or chat.
- Reloading the page or losing your connection puts you back in your seat.
- **Player search** is the box at the bottom left of every page: type two or more letters of a name, pick a result (arrow keys and Enter work), and you land on that player's profile.
- **Play** at the top right takes you back to the lobby from anywhere (it asks first if you are in the middle of a game).

## Profiles and titles

Every account has a public profile at `#/u/<username>` (click any registered player's name): a rating and record for each of Bullet, Blitz and Rapid, a short bio they can edit, and recent games.

Players can't give themselves a title, otherwise anyone could claim to be a "GM". You grant titles yourself from the folder where the site runs:

```bash
node set-title.js Alice GM       # give Alice a GM badge
node set-title.js Alice none     # remove it
```

Available titles: GM, IM, FM, CM, WGM, WIM, WFM, WCM, NM. The badge appears next to the name on the profile, in games, on the top-players list and in the top bar. It's safe to run while the server is on. Only hand out real titles to people whose FIDE title you've checked.

## Moderation

There are three kinds of player: the **owner** (you), **moderators**, and everyone else.

| | Owner | Moderator | Player |
|---|---|---|---|
| Ban and unban regular players | yes | yes | no |
| Ban moderators | yes | no | no |
| Lift a ban the owner set | yes | no | no |
| Make or remove moderators | yes | no | no |
| Can be banned | no | by the owner | yes |

**Becoming the owner.** Create your account on the site first, then run this in the folder where the site runs (on Render, use the service's Shell tab):

```bash
node set-role.js YourUsername owner
```

This is the only way to create an owner, so nobody can promote themselves from the website. You can also run `node set-role.js Bob mod` or `node set-role.js Bob none`.

**Giving someone ban powers.** Log in as the owner, open their profile (click their name anywhere) and press "Make moderator". "Remove moderator" takes it back.

**Banning.** Open a player's profile and use the moderation box: pick 1 hour, 1 day, 1 week, 30 days or permanent, give a reason, and press Ban. The player is signed out and disconnected straight away, any game they are in ends with their opponent winning by forfeit, and they can't log in until the ban ends. Banned players see the reason you wrote and are hidden from the top-players list. The **Moderation** button in the top bar lists current bans (with a Lift button) and a log of recent actions. Banning a moderator also removes their moderator powers.

**Limits.** Bans apply to accounts. A banned person can still play as a guest or make a new account. To make that harder, start the server with `ALLOW_GUESTS=0`, which asks everyone to log in before they can play. Bans can't stop someone determined who is willing to keep making new accounts.

## Piece artwork

The chess pieces are SVG images in `public/pieces/` (`wK.svg` is the white king, `bP.svg` the black pawn, and so on). They are the "cburnett" set drawn by Colin M.L. Burnett, taken from the `chessground` npm package, which is distributed under the GNU General Public License v3 or later. `public/pieces/CREDITS.txt` and `COPYING.txt` carry the credit and the licence text; please keep them with the images, including when you deploy. I'm not a lawyer, so if you plan to do more than run this for friends, read the licence or ask someone who can.

To use a different set, replace the 12 SVG files with your own, keeping the same names. Nothing else needs to change.

## Files

```
server.js        HTTP + WebSocket server: matchmaking, games, clocks, Elo, chat
db.js            SQLite storage: users, sessions, finished games
set-title.js     Command for giving a player a title badge
set-role.js      Command for making someone the owner or a moderator
public/          The website (index.html, style.css, app.js), no build step
public/pieces/   The 12 piece images, with credits and licence
```

The site name and colours are easy to change: the name is in `public/index.html` and the colours are the variables at the top of `public/style.css`.

## Deploying to Render

`render.yaml` is a ready-made blueprint for [Render](https://render.com). It runs the site on a paid instance that never sleeps, with a small persistent disk for the database.

1. Put this folder in a GitHub repository (don't upload `node_modules` or any `chess.db` files).
2. In Render, choose New, then Blueprint, pick the repository and apply it.
3. When the deploy finishes, Render shows your site's public address (something like `kingside.onrender.com`).
4. To use your own domain, buy one from any registrar, then open the service's Settings, find Custom Domains, add it, copy the DNS records Render shows into your registrar, and press Verify.

To give a player a title or make yourself owner on the hosted site, open the service's Shell tab in Render and run `node set-title.js Alice GM` or `node set-role.js YourUsername owner`.

## Putting it online (other hosts)

Any host that can run a Node.js server and keep a WebSocket open will work (Render, Fly.io, Railway, a VPS). Use `npm start` as the start command. Over HTTPS the browser automatically uses secure WebSockets.

Things to know before you do:

- **Keep the database on a persistent disk.** Without one, accounts and ratings disappear when the host restarts. Point `DB_PATH` at the disk.
- **Run a single instance.** Live games and the matchmaking queue are held in memory, so a second server instance would split players into separate worlds. Games in progress are lost if the server restarts.
- Matchmaking pairs the first two people waiting. It doesn't look at ratings yet, which is fine for a small group of friends but worth adding if the site grows.
- Passwords are stored hashed (bcrypt). There is no password reset or email, so a forgotten password means a new account.

## Hosting the pages on GitHub Pages

GitHub Pages can only hold the web pages. The game itself (accounts, matchmaking, clocks) needs the Node server, so you run two things:

1. **The server**: deploy this folder to Render (see above). `render.yaml` already allows the address `https://orange12234.github.io` to talk to it. If your pages live somewhere else, set the `ALLOWED_ORIGINS` environment variable on the server to that address (just the site, no path), and `SITE_URL` to the full pages address.
2. **The pages**: run `node build-pages.js https://YOUR-SERVER.onrender.com`. That creates a `pages-site` folder. Upload its contents to your GitHub repository (the `TEST2` one). The pages must be at the top level of the repo, with `index.html` next to `config.js`.

If you only have the pre-built pages, open `config.js`, and change the `server` line to your server's address.
