// main.ts -- the build entry point, so the artifact is dist/main.js exactly
// as the systemd unit in architecture.md runs it. The build mirrors the
// source tree under dist/ (generated/wire.ts is compiled beside src/, see
// tsconfig.build.json), which puts the real entry at dist/src/main.js; this
// one-line module is the only thing between the two.
import './src/main.js';
