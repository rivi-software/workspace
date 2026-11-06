# Brand assets

The RIVI Software identity the README shows, each file for light grounds and `-on-dark` for dark ones:

| File | What | Shown in |
| --- | --- | --- |
| `rivi-workspace.svg`, `rivi-workspace-on-dark.svg` | The RIVI Workspace lockup: the mark beside the name | The README's header |
| `rivi-mark.svg`, `rivi-mark-on-dark.svg` | The RIVI Software mark: an ink tile with five level bars, the middle one lit in the signal green | The sign-off at the end of the README |

The mark's geometry and colours are RIVI Software's, as [rivi.software](https://rivi.software) draws them; the mark files are copies of the ones in [`rivi-software/tools`](https://github.com/rivi-software/tools/tree/main/assets), and `RiviMark` in `app/components/brand.tsx` draws the same mark in the app. The lockup is laid out as the `RIVI tools` lockup there is: Bricolage Grotesque ([SIL OFL 1.1](https://github.com/ateliertriay/bricolage)) at weight 600, optical size 20, width 100 and tracked -0.02em, set at 20 px beside a 36 px mark, 10 px apart. The name is drawn as outlines, so the files load no font. To draw a new name, shape it with those settings (HarfBuzz and fontTools, as `rivi-software/rivi-monorepo`'s `packages/brand/scripts/wordmark.py` does) and check that the same settings redraw `RIVI tools` exactly.

These files are for the repository's documents only. The app's icons are under `public/`.
