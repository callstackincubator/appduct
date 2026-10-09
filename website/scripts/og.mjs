// Renders og/og.html twice, as the Open Graph card (public/og.png) and the README banner
// (.github/assets/readme-banner.png), plus the PNG icons from public/favicon.svg. Run with
// `pnpm --filter @appduct/website og` after changing any of them.
// Needs Chromium for playwright-core: `pnpm --filter appduct exec playwright-core install chromium`.
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2' };

// A static server over the website folder. The card imports the dither module the landing page
// uses; it is served as JavaScript by stripping its types.
const server = createServer(async (req, res) => {
	try {
		const path = new URL(req.url ?? '/', 'http://localhost').pathname;
		if (path === '/og/dither.js') {
			const source = await readFile(join(root, 'src/components/landing/dither.ts'), 'utf8');
			res.writeHead(200, { 'Content-Type': types['.js'] });
			res.end(stripTypeScriptTypes(source));
			return;
		}
		const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
		const body = await readFile(file);
		res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
		res.end(body);
	} catch {
		res.writeHead(404).end();
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

const browser = await chromium.launch();
try {
	const shots = [
		{ query: '', width: 1200, height: 630, scale: 1, path: 'public/og.png' },
		{ query: '?format=banner', width: 1300, height: 400, scale: 2, path: '../.github/assets/readme-banner.png' },
	];
	for (const { query, width, height, scale, path } of shots) {
		const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
		await page.goto(`http://127.0.0.1:${port}/og/og.html${query}`);
		await page.waitForFunction(() => /** @type {any} */ (window).ogReady === true);
		await page.screenshot({ path: join(root, path), type: 'png' });
		await page.close();
	}
} finally {
	await browser.close();
	server.close();
}

const favicon = await readFile(join(root, 'public/favicon.svg'));
for (const [name, size] of [
	['favicon-32.png', 32],
	['apple-touch-icon.png', 180],
	['icon-512.png', 512],
]) {
	await writeFile(join(root, 'public', name), await sharp(favicon, { density: 72 * (size / 32) }).resize(size, size).png().toBuffer());
}
console.log('Wrote public/og.png, .github/assets/readme-banner.png and the PNG icons');
