# desktop/resources/wii

The Wii files the app's SD-card page zips (src/cards.ts): `apps/LazyTO/` (the loader) and
`lazyto_kiosk.bin`. release.yml fills this folder from the `loader` and `lazyto-kiosk-bin`
artifacts before packaging; electron-builder ships it as `resources/wii`. In development, copy a
`main-build` bundle's `wii/` here to serve real zips.
