// The hero race: two agents drive the same app to its checkout screen, one tapping through the
// UI, one calling the app's tools over MCP. Loaded on demand by Hero.astro.
import { ghostLine, miniApp, sleep, whenVisible } from './miniapp';

export default function runRace(viz: HTMLElement) {
	const [handEl, callEl] = [...viz.querySelectorAll<HTMLElement>('.device')];
	const hand = miniApp(handEl!);
	const call = miniApp(callEl!);
	const handClock = viz.querySelector<HTMLElement>('[data-clock-hand]')!;
	const callClock = viz.querySelector<HTMLElement>('[data-clock-call]')!;
	const taps = viz.querySelector<HTMLElement>('[data-taps]')!;
	const term = viz.querySelector<HTMLElement>('[data-term]')!;
	const callLane = viz.querySelector<HTMLElement>('.lane--call')!;
	const handLane = viz.querySelector<HTMLElement>('.lane--hand')!;

	const fmt = (s: number) => `00:${String(Math.floor(s)).padStart(2, '0')}`;

	// Clocks: the hand side runs at 5x so a minute of tapping fits in about twelve seconds.
	let t0 = 0;
	let handDone = false;
	let callDone = false;
	let tapCount = 0;
	const tick = () => {
		const real = (performance.now() - t0) / 1000;
		if (!handDone) handClock.textContent = fmt(real * 5);
		if (!callDone) callClock.textContent = fmt(real);
		if (!handDone || !callDone) requestAnimationFrame(tick);
	};

	const tap = async (name: string) => {
		await hand.tap(name);
		tapCount += 1;
		taps.textContent = String(tapCount);
	};

	const byHand = async () => {
		await tap('email');
		await hand.type('email', 'ana@shop.dev', 40);
		await tap('password');
		await hand.type('password', 'hunter22', 40);
		await tap('signin');
		hand.show('home');
		for (let i = 0; i < 3; i++) {
			await sleep(200);
			await tap(`product-${i}`);
			hand.product(i);
			hand.show('product');
			await sleep(240);
			await tap('add');
			hand.badge(i + 1);
			await sleep(160);
			await tap('back');
			hand.show('home');
		}
		await sleep(160);
		await tap('cart');
		hand.show('cart');
		await hand.rows(3, 0);
		await sleep(300);
		await tap('checkout');
		hand.show('checkout');
		hand.hideRing();
		handDone = true;
		handLane.classList.add('is-done');
	};

	// The agent's tool calls over MCP, laid out in full before the race so nothing reflows.
	const CALLS = [`login { "user": "ana" }`, `seed_cart { "items": 3 }`, `open_screen { "name": "checkout" }`];
	let calls: ReturnType<typeof ghostLine>[] = [];

	const byCall = async () => {
		await sleep(300);
		await calls[0]!.type(16);
		call.show('home');
		await sleep(260);
		await calls[1]!.type(16);
		call.show('cart');
		await call.rows(3, 70);
		await sleep(260);
		await calls[2]!.type(16);
		call.show('checkout');
		callDone = true;
		callLane.classList.add('is-done');
	};

	const reset = () => {
		hand.reset();
		call.reset();
		term.textContent = '';
		calls = CALLS.map((c) => ghostLine(term, c, '', '<span class="p">●</span> appduct · '));
		tapCount = 0;
		taps.textContent = '0';
		handDone = callDone = false;
		handClock.textContent = callClock.textContent = '00:00';
		handLane.classList.remove('is-done');
		callLane.classList.remove('is-done');
	};

	whenVisible(
		viz,
		async () => {
			reset();
			await sleep(700);
			t0 = performance.now();
			requestAnimationFrame(tick);
			await Promise.all([byHand(), byCall()]);
			await sleep(3200);
		},
		() => {
			reset();
			handClock.textContent = '00:58';
			callClock.textContent = '00:03';
			taps.textContent = '14';
			for (const c of calls) c.show();
			for (const app of [hand, call]) {
				app.show('checkout');
				app.badge(3);
			}
			handLane.classList.add('is-done');
			callLane.classList.add('is-done');
		},
	);
}
