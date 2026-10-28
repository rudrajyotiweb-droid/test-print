// Entry point. Some hosts (Hostinger / LiteSpeed lsnode) load the entry file with require(),
// which can't load a module graph that uses top-level await (sql.js init in sqlite.js).
// Loading the app with import() keeps this file free of it.
import('./server.js').catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
