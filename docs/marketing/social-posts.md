# Appduct — social posts + video ideas

A ready-to-post set for X and LinkedIn. Each concept is one idea shown through one
real situation, with a video that proves it in under a minute.

Ground rules used throughout:

- **Hook first.** Line one earns line two. No "We're excited to announce."
- **One idea per post.** If it needs two, it's two posts.
- **Show the before.** The pain has to be recognizable in the first 3 seconds of video.
- **No product tour.** Nobody scrolling LinkedIn wants your architecture diagram.
- **X: 1–3 short lines**, link at the end or in the first reply. **LinkedIn: 80–200 words**,
  one line per thought, lots of white space, a question at the end.
- **Video: 9:16 or 1:1, 15–45s, silent-first.** Big text, readable on a phone held at arm's
  length. Screen recordings at 1.5–2x with a visible timer where speed is the point.

Anything written as `[fill in]` is a number you must measure on your own repo before
posting — don't ship an invented benchmark.

---

## The seven that made the cut

Ordered by expected ROI. If you only shoot three videos, shoot 1, 2 and 3.

---

### 1. The E2E test that skips the 40 taps

**Why it's the lead:** it's the most universal pain, the easiest to film, and the demo is
self-evidently faster. Anyone who owns a mobile test suite feels this in their spine.

**X**

> Your E2E test isn't slow because of the thing you're testing.
>
> It's slow because of the login, the onboarding, the cookie banner, and the cart you
> rebuild tap by tap every single run.
>
> Call `seedCart(3)` instead. Start the test at the part that matters.
>
> github.com/callstackincubator/appduct

**LinkedIn**

> We timed one of our end-to-end tests. 90% of it was setup.
>
> Log in. Dismiss onboarding. Accept notifications. Add three items to the cart. Wait for
> a spinner. And only then — the checkout bug we were actually testing.
>
> Every run. Every branch. Every retry.
>
> Appduct lets a test call a function inside the running app directly.
> `login(userId)`, `seedCart(items)` — one line each, no UI involved. The test jumps
> straight to the assertion.
>
> Faster runs. And far less flake, because the flakiest part of a mobile test was never
> your feature — it was the twelve taps before it.
>
> You decide what's callable. You register a handful of functions and nothing else in the
> app is reachable.
>
> How much of your suite's runtime is setup you've already tested a hundred times?
>
> #ReactNative #MobileDevelopment #TestAutomation

**Video (30s, split screen, no voiceover)**

- Left: phone recording of the test tapping through login → onboarding → cart. Timer
  running in the corner.
- Right: same test, Appduct version. Two lines of code flash on screen, app lands on the
  checkout screen instantly. Timer stops.
- Left side is still tapping when the right side finishes. Let it keep tapping for 2
  awkward seconds — that's the whole video.
- End card: `Your test's first 40 taps, deleted.` + repo URL.

---

### 2. "Claude, put the app in the broken state"

**Why:** agent + mobile is the most shareable thing here right now, and it's a
capability people don't know exists. Highest ceiling for reach.

**X**

> Watched an agent flip a feature flag, jump to the paywall screen and read back the app's
> state — without touching a screenshot.
>
> Your app's functions become tools your agent can call. One line of MCP config.
>
> github.com/callstackincubator/appduct

**LinkedIn**

> Coding agents are fine at writing mobile code. They're terrible at seeing whether it
> worked.
>
> The usual loop is: screenshot, squint, tap coordinates, screenshot again. Slow, expensive,
> and wrong about half the time.
>
> Appduct changes what the agent gets. You register a few functions in your app —
> `setFlag`, `goToScreen`, `getCartState` — and they show up as tools your agent can call
> while the app is running. One entry in your MCP config, then Claude Code or Cursor can
> put the app into any state you've made reachable and read the result back as data.
>
> Not pixels. Data.
>
> And the part I care about most: it can only reach the functions you deliberately
> registered. There's no "the agent found a way into your app" story here.
>
> What would you let an agent reach in your app — and what would you absolutely not?
>
> #AI #MobileDevelopment #ReactNative #DeveloperTools

**Video (40s, screen recording)**

- Simulator on the right, agent terminal on the left.
- Type one prompt: *"Put the app in the state where a premium user's subscription just
  expired, then show me the paywall."*
- Agent calls the tools. Simulator visibly jumps: logged in → flag flipped → paywall.
- Cut to the agent printing the app's state back as JSON.
- End card: `It stopped guessing from screenshots.`

---

### 3. The debug menu you never had to build

**Why:** this is the differentiator against how everyone solves this today — a hidden
dev menu behind a seven-tap gesture. The "and it isn't in your release build" beat is the
closer, and `appduct doctor` proves it on camera in three seconds.

**X**

> Every app I've worked on had a secret debug menu.
>
> Long-press the logo. Tap the version 7 times. Pray nobody in production finds it.
>
> Delete it. Appduct gives your tools a front door that isn't in the release build at all.
>
> github.com/callstackincubator/appduct

**LinkedIn**

> Every mobile team eventually builds the same thing: a hidden debug menu.
>
> Tap the version number seven times. Long-press the logo. A screen appears with feature
> flags, environment switches, a "clear all data" button.
>
> It works. It's also a screen you now maintain, style, hide, and quietly worry about —
> because it shipped, and somebody could find it.
>
> Appduct replaces it. The same capabilities live as functions you register in code, callable
> from your terminal, your tests, or an agent. No screen. No gesture. No UI to maintain.
>
> And in a release build there's nothing to find: Appduct is compiled out, not switched off.
> You can assert it in CI — `appduct doctor MyApp.ipa --assert-absent` fails the build if it
> ever sneaks in.
>
> How many taps is your debug menu hiding behind right now?
>
> #MobileDevelopment #iOS #Android #AppSecurity

**Video (25s)**

- Open on a phone doing the seven-tap version-number dance. Debug menu appears. Caption:
  *"we all built this."*
- Hard cut. Same action from a terminal: `appduct invoke set_flag --input '{"paywall":true}'`.
  App updates instantly.
- Final beat: `appduct doctor MyApp.ipa --assert-absent` → green check, `not present`.
- End card: `No hidden menu. Nothing in the release build.`

---

### 4. "Works on my machine" → here's the exact state

**Why:** speaks to QA and to anyone who's lost an afternoon reproducing a bug. Different
audience than posts 1–3, same product. Good for reaching engineering managers.

**X**

> "Can't reproduce."
>
> Two hours later you find out the user had an expired token, an empty cart and a
> half-finished onboarding.
>
> One command puts your app in exactly that state. Then you fix the bug.
>
> github.com/callstackincubator/appduct

**LinkedIn**

> The most expensive part of a mobile bug isn't fixing it. It's getting your app into the
> state where it happens.
>
> Expired token. Region set to Japan. Onboarding half-finished. Cart with one out-of-stock
> item. To see the crash, you have to become that user — manually, every time you reload.
>
> With Appduct, that setup is a function. QA writes down the repro as a command instead of a
> paragraph. You run it, the app lands in that exact state, and you start actually debugging.
>
> The bug report stops being a story someone has to re-enact.
>
> What's the worst state you've ever had to reproduce by hand?
>
> #QA #MobileDevelopment #DebuggingLife

**Video (30s)**

- Screen recording of a Jira-style bug report with a long, miserable "steps to reproduce"
  list. Scroll it slowly. Caption: *"11 steps."*
- Cut to a terminal. One command. App jumps straight to the broken screen.
- Caption: *"1 step."*
- End card: `Reproduce the state. Not the story.`

---

### 5. Not just React Native

**Why:** pure audience expansion. The repo supports plain Swift and Kotlin, and most
people will assume it's RN-only from the name and the Callstack byline. One post fixes
that assumption. Lower engagement ceiling, high strategic value.

**X**

> Appduct isn't a React Native thing.
>
> Plain Swift app? Plain Kotlin app? Same tools, same terminal, same agent, no React
> Native anywhere in your build.
>
> github.com/callstackincubator/appduct

**LinkedIn**

> Quick correction to an assumption we keep hearing: Appduct isn't React Native-only.
>
> It ships as a Swift package for iOS and a Maven artifact for Android, with no React Native
> anywhere in your app. You register tools from Swift or Kotlin and get the same thing: call
> them from your terminal, your test runner, or an agent, while the app is running.
>
> Same story for release builds — Android pairs the library with a no-op variant so the real
> thing never ships.
>
> If you've been scrolling past this because you write native, it was built for you too.
>
> #iOS #Android #Swift #Kotlin #MobileDevelopment

**Video (20s, three-way split)**

- Three panes: a SwiftUI app, a Jetpack Compose app, a React Native app, side by side.
- One terminal command fires. All three react at once.
- End card: `Swift. Kotlin. React Native. Same tools.`

---

### 6. The agent that verifies its own work

**Why:** this is the "oh" moment for the AI-native crowd and it's genuinely a different
claim from post 2 — not *the agent can drive the app*, but *the agent can close the loop
without you*. Save it as the follow-up two weeks later.

**X**

> Agent wrote the feature.
>
> Then it ran the app, set up the state, called the flow, read the result, and found its
> own bug.
>
> Nobody took a screenshot.
>
> github.com/callstackincubator/appduct

**LinkedIn**

> The gap in agentic mobile development isn't writing the code. It's the feedback loop.
>
> An agent can implement a checkout change in a minute. Then it has to find out whether the
> change works — and its only option is usually to take a screenshot and guess.
>
> With Appduct, the loop closes. The agent connects to the running simulator, seeds the
> state it needs, triggers the flow, and reads the actual result back as structured data. If
> it's wrong, it knows it's wrong, and it goes again — without you sitting there as the
> feedback mechanism.
>
> You still decide what's reachable. Destructive tools can require your approval on every
> single call.
>
> That's the difference between an agent that writes mobile code and one that can tell
> whether it worked.
>
> #AI #AgenticCoding #MobileDevelopment #ReactNative

**Video (45s, the longest one — earn it)**

- Single prompt: *"Add a discount code field to checkout and verify it applies 10%."*
- Fast-forward the code edit (2s, heavily sped up — the code is not the point).
- Slow down for the loop: agent connects → seeds cart → applies code → reads total back.
- Total is wrong. Agent fixes it. Runs again. Correct.
- End card: `It found its own bug.`

---

### 7. Pair a real device in one scan

**Why:** the weakest of the seven, kept because it's the cheapest video to make and it
answers the first objection every RN dev has ("sure, but on a real device?"). Good filler
between the heavyweights, not a launch post.

**X**

> Simulator is easy. Real device is the question everyone asks.
>
> Scan a QR. It's connected. Reload the app, background it, walk to the kitchen — the
> session's still there when you get back.
>
> github.com/callstackincubator/appduct

**LinkedIn**

> Skip LinkedIn for this one — it's a 15-second visual, not a 150-word post. Post it on X,
> and reuse the clip as a reply under post 1 or 2 when someone asks about physical devices.

**Video (15s, one shot, filmed over the shoulder)**

- Terminal prints a QR. Phone camera scans it. Terminal shows the device connected and its
  tool list.
- Without cutting: reload the app, background it, open three other apps, come back.
- Run a command. Still works.
- End card: `Reconnects itself.`

---

## Cut, and why

These were written and killed. Keeping the reasoning so nobody re-pitches them in three
weeks.

| Idea | Why it's cut |
| --- | --- |
| "Hundreds of tools cost your agent only 3 tool definitions" | Real advantage, wrong audience. It lands with maybe 200 people on earth who are currently tuning an MCP context budget. Fold it into a reply when someone asks, don't spend a post on it. |
| "Encrypted connection, pinned keys, no network trust" | Security-as-a-feature post. Reassures existing users, converts nobody — nobody adopts a dev tool *because* of its key rotation story. Keep it as the last line of post 3, where it's a closer rather than the pitch. |
| "Tools always see the latest state — no stale closures" | Implementation elegance. Invisible to anyone who hasn't already hit the bug. This is a docs paragraph, not a post. |
| "Progress streaming from long-running tools" | Nice detail with no story around it. A progress bar is not a hook. |
| "One background service handles every device you plug in" | Solves a problem most people don't know they'd have. Belongs in a "we scaled this to a 12-device rack" case study, once you have one. |
| "Register a tool in 6 lines" — code-only post | Code screenshots do fine on X and die on LinkedIn, and it sells the mechanism instead of the outcome. The code already appears inside posts 1 and 3, in context. |
| "Appduct vs Detox / Maestro" | Comparison posts bring the wrong comments. Let someone else start that thread, then show up in it. |
| App Store screenshot generation | Genuinely plausible use case, but you haven't proven it end to end. Don't market a workflow you haven't run. Revisit once someone actually ships screenshots this way. |

---

## Running order

Don't dump these in one week.

| Week | X | LinkedIn |
| --- | --- | --- |
| 1 | Post 1 | Post 1 |
| 1 (+3 days) | Post 3 | — |
| 2 | Post 2 | Post 2 |
| 3 | Post 7 | Post 4 |
| 4 | Post 5 | Post 5 |
| 6 | Post 6 | Post 6 |

Notes:

- **Post 1 opens** because it needs zero belief in agents to land. Post 2 is the bigger
  swing, and it performs better once post 1 has established what the tool is.
- **Never post the same copy to both platforms the same day.** Overlap is fine; identical
  text reads as a broadcast on both.
- **X links suppress reach.** Put the repo link in the first reply for posts 1 and 2, in the
  post itself for the rest.
- **Reply to every comment in the first hour**, on both platforms. That's the cheapest reach
  in this entire document.
- **The video carries the post.** A weak post with a great 20-second clip beats a great post
  with a screenshot every time.
