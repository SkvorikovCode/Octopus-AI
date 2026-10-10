# Website

Static landing page published to GitHub Pages at https://skvorikovcode.github.io/Octopus-AI/
(English) and `/ru/` (Russian). No build step: plain HTML, one CSS file, self-hosted fonts.

- `index.html` and `ru/index.html` share one structure. Change both when you change copy or layout.
- Screenshots and the social preview image live in `docs/assets/` (the READMEs use them too) and are
  copied into the site by `.github/workflows/pages.yml`.

Preview it the same way the workflow assembles it:

```sh
mkdir -p /tmp/octopus-site/assets
cp -R site/. /tmp/octopus-site/
cp docs/assets/screenshot.png docs/assets/screenshot.ru.png docs/assets/og.png /tmp/octopus-site/assets/
python3 -m http.server 4173 --directory /tmp/octopus-site
```

Then open http://localhost:4173/ (and `/ru/`). The site deploys when `main` changes anything under
`site/` or `docs/assets/`.

Fonts (Doto, Onest, JetBrains Mono) are under the SIL Open Font License; see `fonts/LICENSE.txt`.
