// The dithered pixel scenes behind the landing page's windows and phones: Apex's look (a
// picture ordered-dithered at a fine grain into a ramp from near-black to the accent),
// generated in the browser instead of shipped as an image, so it follows the accent.
//
// A scene is built once per size (the slow part: geometry and shading) and then animated
// cheaply, with a few arithmetic operations per cell each frame.
//
// Shared by Dither.astro and the Open Graph card (scripts/og.mjs), which loads this file with
// its types stripped: keep it free of imports and of TypeScript syntax that cannot be erased.

// 4x4 Bayer matrix, normalised to 0..1: the threshold a cell's tone must beat to step up.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((n) => (n + 0.5) / 16);

// Integer-hashed value noise. `period` makes it wrap horizontally, so mist can slide forever.
const hash = (x: number, y: number) => {
	let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const noise = (x: number, y: number, period = 0) => {
	const xi = Math.floor(x);
	const yi = Math.floor(y);
	const xf = x - xi;
	const yf = y - yi;
	const u = xf * xf * (3 - 2 * xf);
	const v = yf * yf * (3 - 2 * yf);
	const x0 = period ? ((xi % period) + period) % period : xi;
	const x1 = period ? (x0 + 1) % period : xi + 1;
	const a = hash(x0, yi);
	const b = hash(x1, yi);
	const c = hash(x0, yi + 1);
	const d = hash(x1, yi + 1);
	return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};
const fbm = (x: number, y: number, octaves = 4, period = 0) => {
	let sum = 0;
	let amp = 0.5;
	let p = period;
	for (let i = 0; i < octaves; i++) {
		sum += amp * noise(x, y, p);
		x *= 2;
		y *= 2;
		p *= 2;
		amp *= 0.5;
	}
	return sum / (1 - Math.pow(0.5, octaves));
};
const smooth = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** A scene at one size: `frame(t)` fills and returns the tone (0..1) of every cell. */
type Scene = { frame: (t: number) => Float32Array };
type SceneBuilder = (cols: number, rows: number, focus?: number, broken?: boolean) => Scene;

/** A horizontally wrapping mist texture, sampled with a sliding offset. */
function mistTexture(cols: number, rows: number, scaleX: number, scaleY: number) {
	const tex = new Float32Array(cols * rows);
	const period = Math.max(1, Math.round(scaleX));
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < cols; x++) {
			tex[y * cols + x] = fbm((x / cols) * period, (y / rows) * scaleY, 4, period);
		}
	}
	return tex;
}

const scenes: Record<string, SceneBuilder> = {
	// Ducts: ribbed tubes fan in from the left and bundle into one point (the app), with light
	// pulses travelling along them toward it. `focus` is where the bundle lands, 0..1 across.
	// `broken` (the 404 page): the front tube stops short in an open end, a dashed outline runs on
	// where it should be, and each pulse that reaches the end flares there instead of going on.
	ducts: (cols, rows, focus = 0.74, broken = false) => {
		const out = new Float32Array(cols * rows);
		const aspect = cols / rows;
		// Per cell: which tube is in front (-1 for none), its tone, and how far along it we are.
		const tube = new Int8Array(cols * rows).fill(-1);
		const shade = new Float32Array(cols * rows);
		const along = new Float32Array(cols * rows);
		const shine = new Float32Array(cols * rows);
		const back = new Float32Array(cols * rows);
		// Only on the broken tube: 1 the rim of its open end, 2 the dark inside, 3 a dash.
		const part = new Int8Array(cols * rows);

		// Back to front. y0: where it enters on the left; r: radius as a share of the height.
		const tubes = [
			{ y0: 0.06, r: 0.035, depth: 0.55, wig: 0.05, phase: 0.3 },
			{ y0: 0.94, r: 0.04, depth: 0.55, wig: 0.04, phase: 2.1 },
			{ y0: 0.3, r: 0.05, depth: 0.75, wig: 0.06, phase: 1.2 },
			{ y0: 0.74, r: 0.055, depth: 0.8, wig: 0.05, phase: 4.0 },
			{ y0: 0.16, r: 0.07, depth: 1, wig: 0.04, phase: 5.2 },
			{ y0: 0.56, r: 0.085, depth: 1, wig: 0.05, phase: 3.1 },
		];
		const n = tubes.length;
		// Where the front tube is cut, 0..1 across: clear of the copy, short of the bundle.
		const cut = focus - 0.24;

		// A faint haze where the bundle lands, so the app sits in light.
		for (let y = 0; y < rows; y++) {
			for (let x = 0; x < cols; x++) {
				const d = Math.hypot((x / cols - focus) * aspect, y / rows - 0.5);
				back[y * cols + x] = 0.16 * Math.exp(-d * d * 6) + 0.05 * fbm((x / cols) * 6, (y / rows) * 6, 3);
			}
		}

		tubes.forEach((t, k) => {
			const endY = 0.5 + (k - (n - 1) / 2) * 0.045;
			const radius = t.r * rows;
			for (let x = 0; x < cols; x++) {
				const u = x / cols;
				const e = smooth(0.02, focus, u);
				const wiggle = t.wig * (1 - e) * Math.sin(u * 2.2 * Math.PI + t.phase);
				const cy = (t.y0 + (endY - t.y0) * e + wiggle) * rows;
				const r = radius * (1 - 0.45 * e); // tubes narrow as they bundle
				const cutHere = broken && k === n - 1;
				for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(rows - 1, Math.ceil(cy + r)); y++) {
					const nY = (y - cy) / r;
					if (Math.abs(nY) > 1) continue;
					// A lit cylinder: highlight high on the tube, falling off to dark edges.
					const body = Math.sqrt(1 - nY * nY);
					const highlight = Math.exp(-(((nY + 0.42) / 0.2) ** 2));
					const i = y * cols + x;
					if (cutHere) {
						// The open end is an ellipse a third as wide as the tube is tall.
						const end = x - cut * cols;
						const half = 0.32 * r * body;
						if (end > half) {
							// Past the end: only a dashed line along the top and bottom edges.
							if (Math.abs(nY) < 1 - 2 / r || Math.floor(x / 3) % 2) continue;
							part[i] = 3;
						} else if (end >= -half) {
							const ring = (end / (0.32 * r)) ** 2 + nY * nY;
							part[i] = ring > 0.55 ? 1 : 2;
						}
					}
					tube[i] = k;
					shade[i] = (0.14 + 0.36 * body + 0.42 * highlight) * t.depth;
					along[i] = u;
					shine[i] = highlight;
				}
			}
		});

		const speeds = tubes.map((_, k) => 0.07 + 0.025 * ((k * 7) % 4));
		return {
			frame: (time) => {
				// How brightly the broken end flares: full while a pulse runs into it, then fading.
				const front = tubes[n - 1]!;
				const atCut = (((cut * 1.6 - time * speeds[n - 1]! + front.phase) % 1) + 1) % 1;
				const flare = atCut < 0.08 ? 1 : atCut > 0.9 ? (atCut - 0.9) / 0.1 : 0;
				for (let i = 0; i < out.length; i++) {
					const k = tube[i]!;
					if (k < 0) {
						out[i] = back[i]!;
						continue;
					}
					const u = along[i]!;
					const t = tubes[k]!;
					const kind = part[i]!;
					if (kind) {
						out[i] =
							kind === 1
								? 0.6 + 0.4 * flare
								: kind === 2
									? 0.04
									: 0.75 + 0.25 * flare * Math.exp(-(u - cut) * 12);
						continue;
					}
					// Corrugation: rings every few cells, the flexible-duct look.
					const rib = 0.82 + 0.18 * Math.cos(u * cols * 0.55 + time * 2);
					// Pulses: short bright runs sliding toward the app.
					const p = (((u * 1.6 - time * speeds[k]! + t.phase) % 1) + 1) % 1;
					const pulse = p < 0.08 ? Math.sin((p / 0.08) * Math.PI) * (0.15 + 0.7 * shine[i]!) * t.depth : 0;
					out[i] = clamp01(shade[i]! * rib + pulse);
				}
				return out;
			},
		};
	},

	// The 404 page's ducts, with the front tube broken off short of the app.
	broken: (cols, rows, focus) => scenes.ducts!(cols, rows, focus, true),

	// Soft, slowly turning bands of light on black: Apex's abstract backdrop.
	flow: (cols, rows) => {
		const out = new Float32Array(cols * rows);
		const aspect = cols / rows;
		const warp = mistTexture(cols, rows, 2 * aspect, 2);
		return {
			frame: (t) => {
				const shift = Math.floor(t * 4) % cols;
				for (let y = 0; y < rows; y++) {
					const v = y / rows;
					const row = y * cols;
					for (let x = 0; x < cols; x++) {
						const u = x / cols;
						const w = warp[row + ((x + shift) % cols)]! * 3.2;
						const band = 0.5 + 0.5 * Math.sin((u * 1.6 * aspect * 0.35 + v * 1.3) * Math.PI + w + t * 0.15);
						const edges = smooth(0, 0.3, u) * smooth(1, 0.7, u) * 0.4 + 0.6;
						out[row + x] = smooth(0.35, 1, band) * edges * (1 - Math.abs(u - 0.5) * 0.6);
					}
				}
				return out;
			},
		};
	},
};

type Painted = { key: string; scene: Scene; image: ImageData; px: Uint32Array; palette: number[] };
const cache = new WeakMap<HTMLCanvasElement, Painted>();

/** Packs the three tones (background, a dark tint of the accent, the accent) as RGBA words. */
function palette(rgb: number[]) {
	const [r, g, b] = rgb as [number, number, number];
	const pack = (cr: number, cg: number, cb: number) =>
		(255 << 24) | (Math.round(cb) << 16) | (Math.round(cg) << 8) | Math.round(cr);
	const mix = (c: number) => 10 + (c - 10) * 0.3;
	return [pack(10, 10, 10), pack(mix(r), mix(g), mix(b)), pack(r, g, b)];
}

/**
 * Draws frame t of a scene onto a canvas sized one pixel per cell; CSS scales it up with
 * `image-rendering: pixelated`. The scene and the pixel buffer are kept per canvas and rebuilt
 * only when its size changes. Tones are ordered-dithered between neighbouring colours.
 */
export function drawDither(
	canvas: HTMLCanvasElement,
	name: string,
	t: number,
	rgb: number[],
	cols: number,
	rows: number,
	focus?: number,
) {
	const build = scenes[name];
	const ctx = canvas.getContext('2d');
	if (!build || !ctx || cols < 2 || rows < 2) return;
	const key = `${name}:${cols}x${rows}:${focus}`;
	let entry = cache.get(canvas);
	if (!entry || entry.key !== key) {
		canvas.width = cols;
		canvas.height = rows;
		const image = ctx.createImageData(cols, rows);
		entry = { key, scene: build(cols, rows, focus), image, px: new Uint32Array(image.data.buffer), palette: palette(rgb) };
		cache.set(canvas, entry);
	}
	const tones = entry.scene.frame(t);
	const { px, palette: colours } = entry;
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < cols; x++) {
			const i = y * cols + x;
			const scaled = tones[i]! * 2;
			const low = Math.min(1, Math.floor(scaled));
			const step = scaled - low > BAYER[(y & 3) * 4 + (x & 3)]! ? 1 : 0;
			px[i] = colours[low + step]!;
		}
	}
	ctx.putImageData(entry.image, 0, 0);
}

const FRAME_MS = 1000 / 12; // a deliberately low frame rate keeps the pixels reading as pixels

/**
 * Animates a `canvas.dither` (see Dither.astro) while it is on screen, at 12 frames a second;
 * one still frame under reduced motion.
 */
export function animateDither(canvas: HTMLCanvasElement) {
	const scene = canvas.dataset.scene ?? 'ducts';
	const focus = Number(canvas.dataset.focus ?? 0.74);
	const cell = Number(canvas.dataset.cell ?? 2);
	const rgb = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim().split(/\s+/).map(Number);
	const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
	const start = performance.now() - Math.random() * 20000;
	let visible = false;
	let last = 0;

	const draw = (now: number) => {
		const cols = Math.ceil(canvas.clientWidth / cell);
		const rows = Math.ceil(canvas.clientHeight / cell);
		drawDither(canvas, scene, (now - start) / 1000, rgb, cols, rows, focus);
	};
	const loop = (now: number) => {
		if (!visible) return;
		if (now - last >= FRAME_MS) {
			last = now;
			draw(now);
		}
		requestAnimationFrame(loop);
	};

	new IntersectionObserver(([entry]) => {
		visible = !!entry?.isIntersecting;
		if (visible && !still) requestAnimationFrame(loop);
		else if (visible) draw(start);
	}).observe(canvas);
	new ResizeObserver(() => draw(performance.now())).observe(canvas);
}
