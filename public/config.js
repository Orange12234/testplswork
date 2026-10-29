/* Where is the Kingside server?
 *
 * Leave `server` empty when this page is served by the Kingside server itself
 * (the normal "npm start" setup). When the pages are hosted somewhere else, for
 * example GitHub Pages, put the server's address here, like
 *   server: 'https://kingside.onrender.com'
 * `npm run build:pages` writes this file for you.
 */
window.KINGSIDE = window.KINGSIDE || {
  server: '',
  // Set when Stockfish and chess.js are bundled next to the pages (static hosting).
  localEngine: null,
};

(function () {
  const K = window.KINGSIDE;
  const base = String(K.server || '').replace(/\/+$/, '');
  K.configured = !/YOUR-SERVER/i.test(base);
  K.url = (path) => base + path;                               // '/api/me' -> server address + '/api/me'
  K.wsUrl = () => {
    if (!base) return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws';
    return base.replace(/^http/i, 'ws') + '/ws';               // https://x -> wss://x/ws
  };
  K.asset = (rel) => rel;                                      // relative on purpose: works under /TEST2/
  K.home = () => location.origin + location.pathname;          // address of this site, for invite links
})();
