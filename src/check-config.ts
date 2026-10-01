// check-config -- does this build accept the config file at CONFIG?
//
// Run by deploy/update.sh on the Pi against the NEW build before it is
// swapped in: `CONFIG=/etc/lazyto/config.json node dist/src/check-config.js`.
// loadConfig rejects unknown and missing fields with no defaults, so a build
// whose config schema differs from the installed config.json (a field added
// or removed on main before push.ps1 rewrote the Pi's config) must not be
// installed by the updater: the swap would succeed and the relay would then
// die at startup. Exit 0 = accepted, 1 = rejected with the reason on stderr.
// No network, no side effects.
import { loadConfig } from './config.js';

const path = process.env.CONFIG;
if (!path) {
  console.error('CONFIG environment variable not set (path to config.json)');
  process.exit(2);
}
try {
  loadConfig(path);
  process.exit(0);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
