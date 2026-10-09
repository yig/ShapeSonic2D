# ShapeSonic 2D: design and architecture

A browser demo of ShapeSonic (Huang, Hanocka, Siu, Gingold, SIGGRAPH Asia 2023;
`../paper/main.tex`) reduced to 2D. A shape is hidden on the screen. The user
explores it with several fingers on a touchscreen, or with the mouse button,
and hears where it is.

Keep this document up to date when the implementation changes.

## Running

Plain static files: there is no build step and no dependencies. The page uses
ES modules and `fetch`, so it must be served over HTTP rather than opened as
`file://`:

```sh
python3 -m http.server 8123      # then open http://localhost:8123/
```

To try it on a phone or tablet, serve it on the LAN and open the computer's IP
address. Any static host works, e.g. GitHub Pages. Headphones are recommended
because the left and right hands map to the left and right ears.

URL parameters, for demos and tests:

| Parameter | Effect |
|---|---|
| `shape=circle\|square\|triangle\|annulus\|cat` | Initial demo shape (default `circle`). |
| `show=1` | Start with the shape visible. |
| `hands=split\|order` | Hand assignment mode (overrides the remembered choice). |
| `audio=0` | Skip the start overlay. No sound plays until audio is started, so this is for screenshots only. |

## Files

```
index.html            page structure: canvas, top bar, pop-up menu, start overlay
style.css             layout and theme tokens (light/dark via prefers-color-scheme)
js/main.js            app wiring: UI, shape switching, per-frame probe -> audio -> draw
js/shapes.js          built-in demo shapes, as SVG strings
js/shape-loader.js    SVG text / raster image -> Shape (bounds, inside rule, corners)
js/svg-corners.js     SVG path parsing and corner detection from geometry (DOM-free)
js/raster-corners.js  corner detection on a binary mask by convolution (DOM-free)
js/field.js           Shape placed on screen -> inside mask, SDF, screen corners, distances
js/sdf.js             exact Euclidean distance transform -> signed distance field
js/audio.js           Web Audio sonification engine
js/input.js           pointer events -> fingers with hand and pentatonic slot
audio/                sounds used by the app (transcoded copies, see below)
sounds/               original sound designer files (not loaded by the app)
test/                 Node and headless-Chrome tests
```

## Data flow

```
 SVG text ─┐                         ┌── buildField(shape, W, H) ──────────────┐
 demo SVG ─┼─ shape-loader ─► Shape ─┤ fit to screen, rasterize at grid res,   │
 PNG/JPG  ─┘   (corners in [0,1]²)   │ classify inside, SDF, filter corners    │
                                     └──────────────────► Field ───────────────┘
                                                            │
 pointer events ─► FingerTracker.fingers ─► probe() on every input event and
                                            every frame: sample SDF and corner
                                            distance per finger, compute
                                            per-hand levels ─► Sonifier.update()
                                            (each frame also) └► draw()
```

### Shape

`shape-loader.js` turns any input into the same small interface:

- `aspect`: the width/height of the shape's bounding box.
- `corners`: `[{u, v}]` in the unit square of the bounding box.
- `bg`: `null`, or an `[r, g, b]` colour that counts as outside.
- `raster(w, h)`: async. Returns a drawable image of the bounding box at that size.

**Inside rule** (`isInsidePixel`): a pixel is inside if it is painted (alpha at
least 50%) and, when a background colour is known, its colour is more than 60
RGB units from that colour.

**SVG.** The file is parsed with `DOMParser` and imported into a hidden,
rendered host element. The host has to be rendered because `getBBox`,
`getScreenCTM` and computed styles all need it. The root's `width`, `height`
and `viewBox` are removed, so root user space becomes the analysis space.
Each rendered geometry element is then examined (`path`, `rect`, `circle`,
`ellipse`, `polygon`, `polyline`, skipping anything inside `defs`, `mask` and
similar containers):

- Its element-to-root matrix is `root.getScreenCTM()⁻¹ · el.getScreenCTM()`.
  This covers nested transforms and nested `<svg>`s.
- Its transformed bounding box is enlarged by half the stroke width when stroked.
- If the first painted element covers the bounding box of everything, it is
  treated as a background. Its solid fill colour becomes `bg`, and it is
  excluded from the bounds and from corner detection.
- Corners come only from filled elements (see below).

The content bounding box becomes the new `viewBox` (`preserveAspectRatio=none`).
`raster(w, h)` serializes the SVG at that pixel size and decodes it as an
`<img>`, so vector shapes are rasterized directly at the SDF grid resolution.

**Raster images (PNG, JPEG, WebP).** The image is drawn to a canvas (long side
capped at 1024 px). The background is *transparent* if at least half the border
pixels are transparent, and otherwise the median border colour. Pixels are
classified, and the mask is cropped to the bounding box of the inside pixels.
`raster()` returns that mask as a canvas: opaque inside, transparent outside.
Corners are detected on the mask by convolution.

### Corner detection

**From SVG geometry** (`svg-corners.js`). Path data is parsed fully: every
command, relative and absolute forms, implicit repeats, and arc flags written
without separators. It is reduced to closed loops of segments, because filling
closes open subpaths. Each segment stores its start and end unit tangents:

- lines use their direction;
- cubic and quadratic Béziers use the first non-degenerate control-polygon leg;
- elliptical arcs use the SVG spec's endpoint-to-centre conversion.

`rect` (only when it has no rounded corners), `polygon` and `polyline` become
polygons. `circle` and `ellipse` have no corners. At every junction, the
incoming and outgoing tangents are mapped through the element's linear
transform, and the junction is a corner if they differ by more than 30°.
Results are de-duplicated. Smooth joins, such as the annulus's arcs or the
cat's body curves, therefore produce no corners.

**From raster masks** (`raster-corners.js`). This is a Shi–Tomasi (min-eigenvalue
Harris) detector:

1. Box-resample the mask so its long side is 256 cells, with 16 cells of padding.
2. Gaussian smoothing (σ = 1) and Sobel gradients.
3. A structure tensor averaged with a Gaussian window (σ = 2.5).
4. The response is the tensor's smaller eigenvalue. It is about 0 along straight
   or gently curved boundaries and large where the boundary turns sharply.

The input is always a clean 0/1 mask, so responses can be compared across
images. The threshold is therefore absolute: 0.2 × the response of an ideal 90°
corner. Corners are local maxima within a radius of 6 cells, refined to sub-cell
accuracy by a weighted centroid. The detector can also fire on very tightly
curved regions, such as the tip of the cat's tail in a 400 px rendering. That
is acceptable: at fingertip scale, such regions feel like corners.

**On-boundary filter** (`field.js`). After the SDF is built, a corner is kept
only if `|SDF| ≤ max(3 px, 2.5 cells)`. This removes vertices of SVG elements
that are hidden inside other elements, or inside a background-coloured region.

### Field (shape on screen)

`buildField(shape, W, H)`:

- **Layout.** The shape's long side is 72% of the short screen side, centred.
  Rebuilt on resize (debounced 150 ms).
- **Grid.** It covers the whole viewport, with the cell size
  `max(1, sqrt(W·H / 700k))` CSS px. The shape is drawn into a canvas of grid
  size and classified with the inside rule.
- **SDF** (`sdf.js`). The Felzenszwalb–Huttenlocher exact squared Euclidean
  distance transform is run twice: from inside cells and from outside cells.
  The result is `sdf = dist_to_inside − ½` outside and `−(dist_to_outside − ½)`
  inside, so it is negative inside and zero on the boundary, as in the paper.
  It is sampled bilinearly. It takes about 20 ms for 700k cells.
- **Distances.** The sonification distances are derived from the fitted size:
  guidance `D = 0.6 · size`, corner `D = max(22 px, 0.08 · size)`, and contact
  `D = |min SDF|`. These are the paper's ratios, scaled from its 3D setting:
  50 cm and 2 cm for objects of about 25–40 cm. There is a 22 px minimum so
  that a corner zone is about the size of a fingertip on a phone.

The SDF is computed once per shape and screen size, as in the paper, where it
was precomputed offline. Each frame only samples it.

## Sonification (`audio.js`)

The mapping follows the paper's Method section. The 2D adaptations are marked ◆.

| Sound | Recording | Plays when | Volume from | a | b | D |
|---|---|---|---|---|---|---|
| Guidance | `guidance.mp3` (ambient loop) | some finger of the hand is outside | closest outside finger's SDF | 0 | 1 | 0.6 · size |
| Contact | `contact-{left,right}.mp3` (loop) | this finger is inside | this finger's depth −SDF | 0 | 0.8 | \|min SDF\| |
| Corner | `corner-{left,right}.mp3` (pluck) | some finger of the hand is near a corner | closest finger's corner distance | 0.6 | 0.4 | max(22 px, 0.08 · size) |

Volume is `V(x) = a + b·e^(−5x/D)` for `0 ≤ x < D`, and 0 otherwise
(supplemental Table 1).

- **Hands and ears.** Left-hand sounds go to the left channel and right-hand
  sounds to the right. Left-hand sounds are lower in pitch. The
  contact/edge/corner recordings come as hard-panned LEFT/RIGHT pairs that
  already differ in pitch (contact: B4 vs. C♯5). The guidance loop is a single
  stereo file, so each hand gets its own copy through a `StereoPannerNode`
  (±1), and the left hand's copy is pitched 2 semitones lower.
- **Pentatonic fingers.** Each hand has 5 contact voices, made from the same
  loop at playback rates for C D E G A (0, 2, 4, 7, 9 semitones). The finger in
  slot *i* drives voice *i*.
- **Gain smoothing.** Gains move toward their targets with
  `setTargetAtTime`, settling in about 3 time constants. The time constants are
  guidance 8 ms, corner 6 ms and contact 3 ms. They are short enough that
  volume tracks the finger with little lag, and long enough to avoid clicks.
  Contact is the most abrupt, by design.
- ◆ **Corner sound is retriggered, not looped.** The pluck recordings decay
  within about 0.5 s, and looping the whole file would leave long gaps. While
  a hand is within range of a corner, a new pluck starts every 0.45 s. It
  plucks immediately on entering the range. Each pluck goes through the hand's
  corner gain, which follows the distance continuously. The corner WAVs were
  trimmed to 2 s, faded out, and transcoded to MP3.
- ◆ **Edges.** In 2D the boundary is a curve, and its only sharp features are
  corners, so the edge sound has no separate role. The menu lets the user pick
  which pluck marks corners: the corner "bell" (default) or the edge "pluck".
  The second choice treats the 2D shape as a top view of an extruded prism, in
  which 2D corners are vertical edges.
- **Mix.** A per-family gain (guidance 0.5, contact 0.45, corner 0.9) balances
  the recordings' different levels. A master gain is controlled by the volume
  slider.
- **Graph.** All loops start once, when audio starts, at random offsets, with
  gain 0. There are 2 guidance and 10 contact loops. Updates then only set
  gain targets. This avoids start/stop clicks and keeps CPU use constant.
- **Trimmed buffers.** The sound designer's MP3s decode with about 47 ms of
  silence at the start (encoder padding). That would delay every edge pluck
  and leave a 47 ms gap at each loop point. After decoding, samples at or below
  1e-4 are trimmed from both ends of every buffer.

Audio starts from the **Start** button, because browsers require a user
gesture for audio. On iOS 17 and later, `navigator.audioSession.type =
'playback'` lets sound play even when the silent switch is on.

## Input (`input.js`)

Pointer Events handle touch, pen and mouse uniformly. The canvas sets
`touch-action: none`, and pinch, double-tap zoom and the context menu are
suppressed.

- **Low latency.** The tracker calls `onChange` on every finger down, move and
  up. `main.js` then updates the audio immediately, instead of waiting for the
  next animation frame, which can save up to one frame (about 16 ms). Where
  the browser supports it (Chrome, in secure contexts: HTTPS or localhost),
  the tracker also listens to `pointerrawupdate`. That event arrives as soon
  as input does, rather than aligned to frames. Moves already seen through it
  are skipped when the matching `pointermove` arrives. The per-frame update
  remains, for field rebuilds and for re-plucking while a finger is held
  still.

- ◆ **Hand.** A touchscreen cannot tell hands apart, so the hand is decided
  when a touch starts, in one of two modes chosen under **Hands** in the menu:
  - **Screen halves** (`split`, the default): a touch belongs to the left hand
    if it starts on the left half of the screen. It keeps that hand while it is
    dragged across the midline. A faint midline is drawn when no finger is
    down.
  - **Touch order** (`order`): the first five simultaneous touches are the
    left hand and the next five are the right hand, wherever they are. A new
    touch takes the earliest free slot, checking the left hand first, so
    lifting a left-hand finger and touching again stays on the left hand.

  The choice is remembered per browser in `localStorage`. Changing it clears
  all fingers.
- ◆ **Finger.** Each new touch takes the lowest free of its hand's 5 slots,
  which gives it a pentatonic note. A touch that finds no free slot (a 6th on
  one side in split mode, or an 11th in order mode) is ignored.
- **Mouse fallback.** While a mouse button is held, the mouse is one fingertip.
  Hovering is silent, in the same way that a lifted finger is silent.
- Opening the menu clears all fingers, so sounds stop.

## UI (`main.js`, `index.html`)

- **Top bar.** **☰ *shape name*** opens the pop-up menu, and **Show shape**
  toggles the visualization (also the `S` key).
- **Menu.** The demo shapes (circle, square, triangle, annulus, cat); **Load SVG
  or PNG…** (JPEG and WebP also work); the show-shape checkbox; the hand mode;
  the corner-sound choice; a volume slider; and a status line with the number of detected
  corners, or a loading error. Tapping outside the menu, or pressing Esc,
  closes it.
- **Visualization.** Hidden by default. When shown, it draws the
  *rasterized inside mask* that is actually sonified, rather than the source
  image. Each detected corner gets a dot and a dashed circle with the radius of
  its sound range.
- **Fingers.** Always drawn as rings in the hand's colour, with their note
  name. These rings do not reveal the shape. They are filled when a finger is
  inside, but only while the shape is shown.
- Colours are CSS custom properties, with light and dark values. The canvas
  reads them at startup and again when the colour scheme changes.
- `window.shapesonic` exposes `{state, sonifier, tracker, probe}` for debugging
  and tests.

## Demo shapes (`shapes.js`)

All demo shapes are SVG strings in a 100×100 viewBox. They go through the same
loader as user files, so they also test it:

- **circle**: `<circle>`.
- **square**: `<rect>`.
- **triangle**: an equilateral `<polygon>`.
- **annulus**: one path of four arcs with `fill-rule="evenodd"`. It tests arc
  tangents, which should give no corners.
- **cat**: a sitting cat silhouette with a curled tail. It has 7 corners: the
  2 ear tips, the 2 inner ear bases, where the tail meets the body, and the 2
  sides of the notch between the paws.

## Tests

```sh
node test/corners.test.mjs [dir]   # SVG corners, SDF accuracy; raster corners if dir has <shape>.pgm masks
python3 -m http.server 8123 &      # then:
node test/browser.test.mjs         # headless Chrome over DevTools protocol
```

`browser.test.mjs` simulates multi-touch and the mouse, and checks:

- the per-hand levels: faint guidance far away, loud guidance just outside,
  contact just inside, quiet contact deep inside, and the corner sound;
- the hand and slot assignment, in both hand modes;
- that the Web Audio gains follow the levels;
- that the decoded sounds start without silence;
- that the audio is updated synchronously on each input event;
- the corner counts for every demo shape;
- PNG loading with corner detection, using `test/fixtures/triangle.png`, a
  triangle on a white background;
- SVG loading with a background rect and nested transforms;
- that there are no console errors.

To make PGM masks for `corners.test.mjs`, render the demo SVGs (for example
with `rsvg-convert -w 400`), then run `magick x.png -alpha extract x.pgm`.

## Known limitations and possible extensions

- SVG features that are not analysed for corners: `<use>`, `<text>`, clip
  paths, masks, and strokes. They are still rasterized, so they still count
  toward inside and outside. Corners inside a single Bézier segment (cusps)
  are not detected.
- `<script>` and `<foreignObject>` are removed from loaded SVGs.
- Hand assignment by screen half is a heuristic. An alternative would be
  clustering touches by proximity.
- The remaining latency is the touchscreen, the browser and the audio output.
  Bluetooth headphones add 150–300 ms; wired headphones or the built-in
  speaker are much faster.
- The 34 s loops (1.3 MB each) dominate the download. They could be shortened
  or re-encoded if load time matters.
