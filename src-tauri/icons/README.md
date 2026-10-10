# App icon

`source.svg` is the master (dot-matrix octopus on warm black, macOS-style rounded square with the
usual transparent margin). `source.png` is its 1024x1024 render with a transparent background.

Regenerate every size and the `.icns`/`.ico` after changing the master:

```sh
# render source.svg to a 1024x1024 transparent PNG (e.g. headless Chrome), then:
npx tauri icon src-tauri/icons/source.png
rm -rf src-tauri/icons/android src-tauri/icons/ios   # mobile icons are not used yet
```
