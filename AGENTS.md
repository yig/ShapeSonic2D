Make a 2D demo of ShapeSonic that runs in the browser and uses multi-touch interactions for a tablet or phone (with mouse button fallback for non-touchscreen devices). The paper describing ShapeSonic is ``../paper/main.tex`. The sounds are in the `sounds` directory. (You may transcode them or re-create them with web audio.)

UI:

* A pop-up menu should let the user choose from demo shapes (circle, square, triangle, annulus, cat) or load a 2D shape (as an SVG or PNG, where filled regions are inside the shape, empty regions or the background color is outside). That should be enough to rasterize an SDF. Detect corners from the SVG (or if loading a PNG perhaps use convolution with a corner filter).

* Toggle to show the shape. By default the shape should be hidden. Visualize detected corners as circles.

* A toggle so that the first 5 touches are from one hand and the second from the other, rather than dividing the screen.

Save and maintain a document describing the implementation's design and architecture.
