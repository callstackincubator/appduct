// "How it works": an agent, a test and a terminal take turns calling the app, packets stepping
// along the duct between them. Loaded on demand by Pipeline.astro.
import { ghostLine, miniApp, sleep, whenVisible } from './miniapp';

export default function runPipeline(viz: HTMLElement) {
	const app = miniApp(viz.querySelector<HTMLElement>('.device')!);
	const term = viz.querySelector<HTMLElement>('[data-term]')!;
	const title = document.getElementById('pl-title')!;
	const duct = viz.querySelector<HTMLElement>('[data-duct]')!;
	const pkt = viz.querySelector<HTMLElement>('[data-pkt]')!;
	const back = viz.querySelector<HTMLElement>('[data-pkt-back]')!;

	// Moves a packet along the duct in pixel steps; vertical when the layout stacks.
	const send = (el: HTMLElement, reverse: boolean) => {
		const vertical = duct.clientHeight > duct.clientWidth;
		const prop = vertical ? 'top' : 'left';
		const frames = [{ [prop]: '0%' }, { [prop]: '100%' }];
		el.style.opacity = '1';
		const anim = el.animate(reverse ? frames.reverse() : frames, {
			duration: 640,
			easing: 'steps(16)',
			fill: 'forwards',
		});
		duct.classList.add('is-live');
		return anim.finished.then(() => {
			el.style.opacity = '0';
			duct.classList.remove('is-live');
		});
	};

	// What the caller writes, line by line: typed, or shown at once (an agent's tool call).
	type Line = { text: string; cls?: string; prefix?: string; show?: boolean; pause?: number; speed?: number };
	type Beat = {
		kind: 'ios' | 'android' | 'web';
		title: string;
		before: () => void | Promise<void>;
		lines: Line[];
		apply: () => void | Promise<void>;
		result: string;
	};

	const PROMPT = '<span class="p">$</span> ';
	const beats: Beat[] = [
		{
			kind: 'ios',
			title: 'agent',
			before: () => app.reset(),
			lines: [
				{ text: '> Sign in as Ana.', cls: 'user', speed: 34 },
				{ text: 'appduct · login', cls: 'tool', prefix: '<span class="p">●</span> ', show: true, pause: 380 },
				{ text: '  { "user": "ana" }', cls: 'dim', show: true },
			],
			apply: () => app.show('home'),
			result: '✓ Signed in as Ana.',
		},
		{
			kind: 'android',
			title: 'checkout.test.ts',
			before: async () => {
				app.show('cart');
				await app.rows(0, 0);
			},
			lines: [{ text: 'await app.call("seed_cart", {' }, { text: '  items: 3,' }, { text: '});' }],
			apply: () => app.rows(3),
			result: '// → { added: 3 }',
		},
		{
			kind: 'web',
			title: 'zsh',
			before: () => app.show('cart'),
			lines: [{ prefix: PROMPT, text: `appduct tools call open_screen --input '{"name":"checkout"}'` }],
			apply: () => app.show('checkout'),
			result: '{ "ok": true }',
		},
	];

	// Lays out every line of a beat, result included, before anything is typed.
	const prepare = (beat: Beat) => {
		term.textContent = '';
		const lines = beat.lines.map((l) => ({ ...l, ghost: ghostLine(term, l.text, l.cls, l.prefix) }));
		return { lines, result: ghostLine(term, beat.result, 'ok') };
	};

	const play = async (beat: Beat) => {
		title.textContent = beat.title;
		app.kind(beat.kind);
		const { lines, result } = prepare(beat);
		await beat.before();
		await sleep(500);
		for (const l of lines) {
			if (l.pause) await sleep(l.pause);
			if (l.show) l.ghost.show();
			else await l.ghost.type(l.speed);
		}
		await sleep(200);
		await send(pkt, false);
		await beat.apply();
		await sleep(420);
		await send(back, true);
		result.show();
		await sleep(1900);
	};

	whenVisible(
		viz,
		async () => {
			for (const beat of beats) await play(beat);
		},
		() => {
			const beat = beats[1]!;
			app.kind(beat.kind);
			app.show('cart');
			void app.rows(3, 0);
			title.textContent = beat.title;
			const { lines, result } = prepare(beat);
			for (const l of lines) l.ghost.show();
			result.show();
		},
	);
}
