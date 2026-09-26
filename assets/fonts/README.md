# Fonts

Self-hosted web fonts for the scroll site (`site/site.css` declares them).
All three families are licensed under the SIL Open Font License 1.1; the
license texts are next to the files (`OFL-*.txt`).

| File | Family | Source |
| --- | --- | --- |
| `inter-latin-wght.woff2` | Inter (variable, wght 100–900), latin | `@fontsource-variable/inter@5.3.0` |
| `inter-macron-wght.woff2` | Inter, just `Ā ā` | subset of the fontsource latin-ext file |
| `playfair-display-latin-500*.woff2` | Playfair Display 500 / 500 italic, latin | `@fontsource/playfair-display@5.3.0` |
| `playfair-display-latin-ext-500*.woff2` | Playfair Display 500 / 500 italic, latin-ext | `@fontsource/playfair-display@5.3.0` (unmodified) |
| `poppins-latin-500.woff2` | Poppins 500 (the `cahā` wordmark), latin | `@fontsource/poppins@5.3.0` |
| `poppins-macron-500.woff2` | Poppins 500, just `Ā ā` | subset of the fontsource latin-ext file |

The brand name is the only non-latin-1 text on the site, so instead of each
family's whole latin-ext file (85 KB for Inter) Inter and Poppins get a ~1 KB
subset with the macron letters, made with fonttools:

    pyftsubset <latin-ext.woff2> --unicodes="U+0100-0101,U+0304" \
      --flavor=woff2 --layout-features='*' --output-file=<name>-macron-*.woff2

Playfair Display declares a Reserved Font Name, and the OFL treats subsetting
as modification, so its files are shipped exactly as fontsource publishes them.
