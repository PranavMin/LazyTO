// electron-builder's afterPack hook (package.json build.afterPack), copied from
// jendotpg/slippi-beamer-manager .erb/scripts/mach-o-uuid.js (MIT, Copyright
// (c) 2026 Jen Levy), which Replay Reporter uses too.
//
// macOS keys Local Network permission to the main executable's LC_UUID, which
// is otherwise the same for every app built on the same Electron. Give the
// universal build its own (mach-o-uuid.py), then sign it ad hoc: LazyTO has no
// paid signature (identity: null), and an unsigned app cannot run on Apple
// silicon. This must stay the last change to the bundle: anything after it
// breaks the signature, and macOS then calls the app damaged.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

/** electron-builder's Arch.universal. Per-arch builds would skip this, so the mac target is universal only. */
const UNIVERSAL = 4;

exports.default = async function machOUuid(context) {
  if (context.electronPlatformName !== 'darwin' || context.arch !== UNIVERSAL) return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = `${context.appOutDir}/${appName}.app`;
  const { stdout } = await run('python3', [
    `${__dirname}/mach-o-uuid.py`,
    `${appPath}/Contents/MacOS/${appName}`,
  ]);
  console.log(`  • new LC_UUID ${stdout.trim().replace(/\s+/g, ' ')}`);
  await run('codesign', ['--deep', '--force', '-s', '-', appPath]);
};
