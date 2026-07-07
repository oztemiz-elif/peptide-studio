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

A publication that includes the description of PeptideStudio as part of a broader study is in
preparation. This placeholder will be replaced with the full citation once it is available.

In the meantime, GitHub's **"Cite this repository"** button in the sidebar (powered by
[`CITATION.cff`](CITATION.cff)) generates a software citation (APA/BibTeX) in one click.

## 🤝 Contributing

Issues, bug reports, and feature requests are welcome.
