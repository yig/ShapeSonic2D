// Built-in demo shapes, as SVG. They go through exactly the same loading path
// as user SVGs (shape-loader.js), so they also exercise corner detection.

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;

export const DEMO_SHAPES = [
  { id: 'circle', label: 'Circle', svg: svg('<circle cx="50" cy="50" r="45"/>') },
  { id: 'square', label: 'Square', svg: svg('<rect x="5" y="5" width="90" height="90"/>') },
  {
    id: 'triangle',
    label: 'Triangle',
    // Equilateral, side 100, centered.
    svg: svg('<polygon points="50,6.7 100,93.3 0,93.3"/>'),
  },
  {
    id: 'annulus',
    label: 'Annulus',
    // Two concentric circles built from arcs; even-odd fill punches the hole.
    svg: svg(
      '<path fill-rule="evenodd" d="M 95 50 A 45 45 0 1 1 5 50 A 45 45 0 1 1 95 50 Z ' +
        'M 72 50 A 22 22 0 1 0 28 50 A 22 22 0 1 0 72 50 Z"/>'
    ),
  },
  {
    id: 'cat',
    label: 'Cat',
    // A sitting cat seen from the front: pointed ears, two front paws, and a
    // tail curling around the right side. Ear tips, ear bases, the gap between
    // the paws, and where the tail meets the body are sharp.
    svg: svg(
      '<path d="' +
        'M 33 4 L 42 18 Q 50 15.5 58 18 L 67 4 ' + // left ear tip, head top, right ear tip
        'C 70 12 71 18 70 25 ' + // right side of ear and head
        'C 70 34 64 38 62 44 ' + // right cheek to neck
        'C 60 50 76 62 75 80 ' + // right flank
        'C 82 79 88 72 88 62 ' + // tail rises
        'C 88 56 94 55 95 62 ' + // tail tip
        'C 96 80 86 96 66 96 ' + // tail wraps under the body
        'L 53 96 Q 50 91 47 96 ' + // right paw, notch between paws
        'L 34 96 ' + // left paw
        'C 26 96 23 88 25 78 ' + // left haunch
        'C 25 62 40 50 38 44 ' + // left flank to neck
        'C 36 38 30 34 30 25 ' + // left cheek
        'C 29 18 30 12 33 4 Z"/>'
    ),
  },
];
