<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/PeptideStudio_logo_dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/PeptideStudio_logo_light.svg">
    <img alt="PeptideStudio logo" src="assets/PeptideStudio_logo_light.svg" width="640">
  </picture>
</p>

# PeptideStudio

A fast, fully client-side web app for visualizing peptidomics and degradomics data (e.g., protein degradation/digestion time-courses).
Peptide intensities derived from mass spectrometry are mapped onto individual peptides and clusters using custom color scales. Time-point tracks display separate, aligned peptide sequences to easily monitor degradation progress over time. Publication-ready figures are generated instantly—all running locally in your browser, ensuring your data never leaves your machine.


## ✨ Features

- **Multiple inputs** — Excel (`.xlsx`/`.xls`), CSV, and FASTA, plus live **UniProt search** for
  sequences (runs client-side via UniProt's CORS-enabled REST API).
- **Sequence validation** — flags non–amino-acid characters with one-click cleaning.
- **Peptide alignment and cluster formation** — heat-map-style visualization of every peptide across the protein,
  with overlapping peptides packed onto separate rows automatically.
- **Time-course intensities** — colour peptides by intensity across multiple time points / columns.
- **Flexible colour bins** — arbitrary number of intensity bins with custom colours; `log2`/`log10`
  transforms; superscript / exponential / integer / float notation.
- **Highlight regions & modifications** — mark protein regions and specific residue positions.
- **Interactive layout control** — perfectly preview and plan your figure regardless of protein length. You can adjust the letter size and choose whether the sequence dynamically reflows to your window or locks to a fixed number of amino acids per row.
- **Split on both axes** — divide sequence ranges (vertical) and time-point groups (horizontal)
  into separate figures.
- **Print pagination** — A4 / Letter pages with configurable residues-per-row, rows-per-page, and
  manual break points; print directly via the browser.
- **Export** — PNG, JPEG, SVG, EPS and a ZIP of all figures.
- **No setup persistence headaches** — config auto-saves to `localStorage`, with JSON import/export.

## 🆕 What's new since the publication

The [paper cited below](#-citation) describes PeptideStudio **v1.0.0**. The current version adds
analysis features that the paper does not cover:

- **Cluster detection** — one click finds families of peptides that share an N-terminus or a
  C-terminus: the pattern left behind when one species is trimmed from the other end. A position
  anchors a cluster when enough peptides agree on it *and* it stands out against its own
  neighbourhood, so a busy stretch of the protein cannot hide a cluster elsewhere. Results are
  added to the highlight-region list, ready to edit, recolour or delete, and the output says how
  each boundary was decided — so you know which edges are quotable. A single **Sensitivity** dial
  covers everyday use.

  **Detection is a starting point, not a verdict.** No setting separates a real cluster from a
  coincidence in every dataset: move the dial one step and boundaries move with it. What the
  tool does is narrow a whole protein down to the few positions worth looking at, and show you
  the evidence behind each one — so the judgement that used to mean reading a figure by eye
  becomes a decision you make against numbers, quickly. **The final call on where a cluster
  starts and ends is yours.**
- **Coverage & termini profile** — an on-screen panel above the figure showing how many peptides
  cover each residue, where they begin and end, and the threshold each position must clear to
  anchor a cluster. Orange bars count the peptides beginning at a residue, green bars those
  ending there, and a bar is drawn solid when that position is strong enough to anchor a
  cluster. Zoom and pan along the sequence; a crosshair names the residue under the pointer.
  The panel is an analysis view and is never printed or included in figure exports; it has its
  own PNG / JPEG / SVG export.
- **Hand-adjusted boundaries** — grab either edge of a cluster on the profile and slide it to
  the residue you want. It moves **freely, one residue at a time**, and is never pulled onto a
  position the detector happens to like — the point of sliding is to overrule the detector. As
  you drag, the readout names the residue you are over and how many peptides begin and end
  there, so you can put the boundary on the position with the strongest agreement rather than
  on the one the settings produced. A boundary you set by hand is **kept**: re-running detection
  replaces only the clusters it generated itself and leaves yours alone.
- **Marked-region tables** — for every region currently marked: how many peptides it contains,
  how many begin at its start position and end at its end position, and the weakest, typical and
  strongest peptide in it. A second table breaks the peptide count down by time point. Both copy
  to the clipboard or export as TSV / XLSX.
- **Cleavage export** — every peptide bond in the sequence with the number of peptide termini
  supporting it, per time point, named by P1 and P1′. Written as a spreadsheet with filtered and
  unfiltered sheets, so a site missing from a figure can be traced to a filter rather than to the
  data.
- **Region marking styles** — a region can be marked by two edges on the sequence row, by edges
  spanning every time-point track, or by a bracket above the sequence. Each region also has its
  own fill opacity; where a fill is dark the letters switch to white automatically so the
  sequence stays readable.

## 🚀 Getting started

No coding experience is required — these steps work even if you've never used a terminal before.
PeptideStudio runs entirely on your own computer (nothing is uploaded anywhere); once it's
running, you use it like any other website, just opened from your machine instead of the
internet.

If you're already comfortable with Node.js and Git, the short version is:

```bash
git clone https://github.com/oztemiz-elif/peptide-studio.git
cd peptide-studio
npm install
npm run dev        # opens http://localhost:5173
```

Otherwise, follow the detailed steps below.

**1. Install Node.js (one-time setup).** PeptideStudio is built on
[Node.js](https://nodejs.org/), the program that runs the app on your computer.

- Go to [nodejs.org](https://nodejs.org/) and download the **LTS** version for your operating
  system (Windows / macOS / Linux) — it's the big green button on the homepage.
- Run the downloaded installer and click through it with the default options.
- Restart your computer once it finishes, so the installation takes full effect.

**2. Download PeptideStudio.** You don't need to know Git to do this:

- Go to the [PeptideStudio GitHub page](https://github.com/oztemiz-elif/peptide-studio).
- Click the green **Code** button, then **Download ZIP**.
- Unzip the downloaded file.

**3. Open a terminal inside the unzipped folder.** The "terminal" (Command Prompt / PowerShell on
Windows, Terminal on macOS) is where you'll type the two commands from step 4.

- *Windows*: open the unzipped `peptide-studio` folder in File Explorer, right-click on empty
  space inside it, and choose **Open in Terminal** (Windows 11) or **Open PowerShell window
  here** (Windows 10).
- *macOS*: open **Terminal** (press ⌘+Space, type "Terminal", press Enter), type `cd ` (with a
  trailing space, no Enter yet), then drag the unzipped `peptide-studio` folder from Finder into
  the Terminal window and press Enter — this moves you into that folder.

**4. Install and start the app.** Type each command below into the terminal, pressing Enter after
each and waiting for it to finish before typing the next:

```bash
npm install
```

This downloads the app's building blocks — it needs an internet connection and can take a minute
or two the first time. **You only need to run this once** (again later only if you download a
fresh copy of the code).

```bash
npm run dev
```

This starts PeptideStudio and should open it automatically in your default browser at
`http://localhost:5173`. If no browser tab opens on its own, copy that address into your browser
manually.

Leave that terminal window open while you use the app — closing it (or pressing `Ctrl+C` inside
it) shuts PeptideStudio down. To use it again later, reopen a terminal in the same folder (step
3) and run `npm run dev` again — no need to repeat `npm install`.

**5. Try it with the sample data.** Once the app is open in your browser, load the ready-made
example files from [`sample_data/`](sample_data/) to see it working immediately — see
**Sample data** below.

### Troubleshooting

- **`npm` or `node` is not recognized / command not found** — Node.js isn't installed yet, or
  your terminal was already open before you installed it. Install it from
  [nodejs.org](https://nodejs.org/) (or reinstall if you already tried), then open a **new**
  terminal window and try again.
- **`npm install` fails with permission errors (macOS/Linux)** — avoid running it with `sudo`;
  reinstalling Node.js from the official installer (rather than via a system package manager)
  usually resolves this.
- **"Port 5173 is already in use"** — PeptideStudio (or something else) is already running.
  Either use the tab that's already open, or close that other terminal window and run
  `npm run dev` again.
- **Nothing happens, or the page is blank** — wait a few seconds after running `npm run dev` and
  check the terminal for a line like `Local: http://localhost:5173/` before opening the browser.

Other commands, once the app is set up:

| Command | Description |
|---|---|
| `npm run dev` | Start the app locally (see step 4 above) |
| `npm run build` | Type-check and produce a production bundle in `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Run the Vitest unit tests |

## 📊 Data format

You provide **two things**: a *peptide table* and a *protein sequence*.

### Peptide table (Excel / CSV)

One row per peptide. The app auto-detects columns by name; you can also remap them in the UI.

| Column | Required | Description |
|---|---|---|
| **Start** | ✅ | Peptide start position in the protein (1-based integer) |
| **End** | ✅ | Peptide end position (1-based integer, inclusive) |
| **Intensity column(s)** | ✅ | One or more numeric columns — typically one per time point. Auto-detected if the name contains `area` or `intensity`. |
| **Peptide** | optional | The amino-acid sequence of the peptide (otherwise derived from Start/End) |

Example:

```
Start,End,Peptide,Area_0h,Area_24h,Area_48h
1,12,MKFLVNVALTSG,1200000,3400000,5600000
5,16,VNVALTSGKDLL,800000,2100000,4800000
13,24,KDLLFKDVQGID,0,1500000,3900000
```

Tips for building your own file:
- Start/End must be **integers** and within the protein length.
- Any column whose values are all numeric can be used as an intensity column; name them
  `Area_0h`, `Area_24h`, … (or anything containing `area`/`intensity`) for auto-detection.
- A CSV like the example above can be opened in Excel and saved as `.xlsx` — same columns work.
- Multi-sheet `.xlsx` files are supported; you pick the sheet in the UI.

### Protein sequence

Provide the sequence in any of these ways:
- **FASTA file** — standard `>header` + sequence (see `sample_data/example.fasta`).
- **From a sheet column** — if your table contains the full sequence.
- **UniProt search** — search by name or accession and pick the protein.
- **Manual entry** — paste the sequence; invalid characters are flagged and can be auto-cleaned.

## 📁 Sample data

The [`sample_data/`](sample_data/) folder gives you ready-to-load example files — **synthetic
data generated for demonstration only**, not a real experiment; see its own
[README](sample_data/README.md) for details:

| File | Use |
|---|---|
| `example.fasta` | Human myoglobin (UniProt P02144), the example protein sequence |
| `Example_degradome.xlsx` | Simulated degradome-style peptide time-course for that sequence |

Load the peptide table **and** the sequence file together to render a map.

## 🗂️ Project structure

```
.
├── index.html              # Vite entry
├── package.json
├── tsconfig.json
├── vite.config.ts
├── sample_data/            # Example/template input files
└── src/
    ├── io/                 # parseExcel (SheetJS), parseFasta, uniprot, validateSequence
    ├── model/              # peptides (row packing), intensity (bins/transforms),
    │                       #   filtering, regions, layout (split → wrap → paginate)
    ├── render/             # pure SVG primitives + figure components
    ├── export/             # toSvg, toPng, toZip, print.css
    ├── state/              # reactive store + config (localStorage persistence)
    └── ui/                 # DataInputs, ConfigPanel, RemovedPeptides, App
```

The layout engine (`src/model/layout.ts`) is the core: it takes the sequence, peptides, and config
and **splits → wraps → paginates** into `figures → pages → wrap-rows` that the render layer draws.

## 🧪 Tests

`npm test` runs Vitest unit tests over the pure functions: row packing, intensity
binning/notation, region grouping, peptide filtering, and the layout engine's split/wrap/paginate
behaviour.

## 🛠️ Tech

React 18 · TypeScript · Vite · [SheetJS](https://sheetjs.com/) (Excel parsing) · JSZip ·
FileSaver · Vitest.

## 📄 License

EUPL-1.2 — see [LICENSE](LICENSE).

## 📑 Citation

PeptideStudio is described as part of the following study. If you use the tool, please cite:

> Öztemiz E, Regl C, Brandstetter H, Huber CG, Verhoeckx K and Gadermaier G (2026)
> The optimized endolysosomal degradation assay with standardized enzyme activity represents an
> orthogonal method for predicting protein immunogenicity and T cell epitopes.
> *Front. Allergy* 7:1936335. doi: [10.3389/falgy.2026.1936335](https://doi.org/10.3389/falgy.2026.1936335)


GitHub's **"Cite this repository"** button in the sidebar (powered by
[`CITATION.cff`](CITATION.cff)) also generates a software citation (APA/BibTeX) in one click.

## 🤝 Contributing

Issues, bug reports, and feature requests are welcome.
