// Drives a MiniApp: screen changes, the cart badge, typing into fields, and a tap ring for the
// "by hand" side of the race hero. Plus the small timing helpers every hero animation uses.

export const PRODUCTS = [
	{ name: 'Runner Low', price: '$120', art: 'a' },
	{ name: 'Cotton Tee', price: '$32', art: 'b' },
	{ name: 'Field Cap', price: '$24', art: 'c' },
	{ name: 'Day Pack', price: '$68', art: 'd' },
];

export type View = 'signin' | 'home' | 'product' | 'cart' | 'checkout';

const TITLES: Record<View, string> = {
	signin: 'Shop',
	home: 'Shop',
	product: 'Product',
	cart: 'Cart',
	checkout: 'Checkout',
};

export function miniApp(root: HTMLElement) {
	const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
	const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
	const screen = q('.screen');
	const ring = q('[data-ring]');
	const badge = q('[data-badge]');

	const app = {
		root,
		kind(kind: 'ios' | 'android' | 'web') {
			root.dataset.kind = kind;
		},
		show(view: View) {
			for (const el of qa('[data-view]')) el.classList.toggle('is-on', el.dataset.view === view);
			q('[data-title]').textContent = TITLES[view];
			if (view === 'product') screen.dataset.back = '';
			else delete screen.dataset.back;
		},
		badge(n: number) {
			badge.textContent = String(n);
			badge.classList.toggle('is-full', n > 0);
		},
		/** Shows the first n cart rows, one after another. */
		async rows(n: number, gap = 110) {
			const rows = qa('[data-row]');
			q('[data-view=cart]').classList.toggle('has-items', n > 0);
			for (let i = 0; i < rows.length; i++) {
				if (i < n && gap) await sleep(gap);
				rows[i]!.classList.toggle('is-on', i < n);
				if (i < n) app.badge(i + 1);
			}
			for (const el of qa('[data-total]')) el.classList.toggle('is-on', n > 0);
			if (n === 0) app.badge(0);
		},
		product(i: number) {
			const p = PRODUCTS[i]!;
			q('[data-product-name]').textContent = p.name;
			q('[data-product-price]').textContent = p.price;
			const art = q('[data-product-art]');
			art.classList.remove('art-a', 'art-b', 'art-c', 'art-d');
			art.classList.add(`art-${p.art}`);
		},
		user(name: string) {
			q('[data-user]').textContent = name;
		},
		async type(field: 'email' | 'password', text: string, speed = 45) {
			const target = q(`[data-${field}]`);
			const box = target.parentElement!;
			box.classList.add('is-focus');
			target.textContent = '';
			for (const ch of text) {
				target.textContent += field === 'password' ? '•' : ch;
				await sleep(speed);
			}
			box.classList.remove('is-focus');
		},
		/** Moves the tap ring onto a [data-tap] target and presses it. */
		async tap(name: string) {
			const target = q(`[data-tap="${name}"]`);
			const s = screen.getBoundingClientRect();
			const t = target.getBoundingClientRect();
			ring.style.left = `${t.left - s.left + t.width / 2}px`;
			ring.style.top = `${t.top - s.top + t.height / 2}px`;
			ring.classList.add('is-on');
			await sleep(420);
			ring.classList.add('is-down');
			target.classList.add('is-pressed');
			await sleep(140);
			ring.classList.remove('is-down');
			target.classList.remove('is-pressed');
		},
		hideRing() {
			ring.classList.remove('is-on');
		},
		reset() {
			app.show('signin');
			app.badge(0);
			for (const el of qa('[data-row], [data-total]')) el.classList.remove('is-on');
			q('[data-view=cart]').classList.remove('has-items');
			q('[data-email]').textContent = '';
			q('[data-password]').textContent = '';
			app.hideRing();
		},
	};
	return app;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Adds a line to `parent` that takes its full size straight away but stays invisible until it
 * is typed or shown, so typing never reflows the layout around it.
 */
export function ghostLine(parent: HTMLElement, text: string, cls = '', prefix = '') {
	const el = document.createElement('div');
	el.className = `ln is-pending ${cls}`;
	el.innerHTML = prefix;
	const typed = document.createElement('span');
	const rest = document.createElement('span');
	rest.className = 'ghost';
	rest.textContent = text;
	el.append(typed, rest);
	parent.append(el);
	return {
		async type(speed = 28) {
			el.classList.remove('is-pending');
			for (let i = 1; i <= text.length; i++) {
				typed.textContent = text.slice(0, i);
				rest.textContent = text.slice(i);
				await sleep(speed);
			}
		},
		show() {
			el.classList.remove('is-pending');
			typed.textContent = text;
			rest.textContent = '';
		},
	};
}

/**
 * Runs an async animation loop only while `el` is on screen, and once (statically) when the
 * reader prefers reduced motion.
 */
export function whenVisible(el: Element, loop: () => Promise<void>, still: () => void) {
	if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
		still();
		return;
	}
	let visible = false;
	let running = false;
	const run = async () => {
		if (running) return;
		running = true;
		while (visible) await loop();
		running = false;
	};
	new IntersectionObserver(([entry]) => {
		visible = !!entry?.isIntersecting;
		if (visible) void run();
	}).observe(el);
}
