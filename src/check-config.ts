// check-config -- does this build accept the relay's settings file?
//
// Run by deploy/update.sh on the Pi against the NEW build before it is swapped
// in: `node dist/src/check-config.js [path]` (default: the data directory's
// config.json). Settings are written by the setup page and, since config v2,
// unknown fields are ignored and new fields are optional, so this only refuses
// what would really break: a corrupt file, or a value a stricter build would
// reject. Without it, such a build would install fine and then start in setup
// mode on a Pi that was set up. Exit 0 = accepted (or no settings yet),
// 1 = rejected with the reason on stderr. No network, no side effects.
import { DATA_DIR, configPath, loadConfig } from './config.js';

const path = process.argv[2] ?? configPath(DATA_DIR);
const loaded = loadConfig(path);
if (loaded.kind === 'invalid') {
  console.error(`invalid settings in ${path}: ${loaded.problems.join('; ')}`);
  process.exit(1);
}
process.exit(0);
