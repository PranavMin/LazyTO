# desktop/resources/firmware

The beamer firmware the app's Beamers window flashes: `beamer.bin` (the fork's merged image),
`beamer.bin.sha256` (`sha256sum` format) and `VERSION`. release.yml fetches the pinned
PranavMin/slippi-beamer release here before packaging; electron-builder ships it as
`resources/firmware`. Without `beamer.bin` the window says the build carries no firmware.
