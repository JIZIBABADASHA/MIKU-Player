# What the page costs, and whether it grows

These tests open MIKU's real page (`windows/wwwroot` and `mac/app/wwwroot`, unchanged) in Chromium, with a stand-in
for the host that answers the page's calls and reports playback at the host's pace (`lib/fake-host.cjs`). They do what
a listener does and read what that cost: style passes, layouts, timers, animation frames, observer callbacks,
compositor layers, CPU time, and what is still held after a full garbage collection (JS heap, DOM nodes, event
listeners, observers, animations).

```powershell
cd tests/performance/browser
npm install                              # Playwright; or use the installed Edge: set MIKU_TEST_CHANNEL=msedge
npx playwright install chromium          # not needed with MIKU_TEST_CHANNEL=msedge

node --test resource.test.cjs            # the budgets: about 15 minutes, fails when the page got dearer
node report.cjs                          # every scenario once, printed; --json out.json, --compare before.json
node soak.cjs --minutes 120              # a long run; fails when something keeps growing
```

| File | What it is |
| --- | --- |
| `resource.test.cjs` | The tests. Each one holds a scenario to the budgets. |
| `budgets.cjs` | The budgets, with what each number is made of. Raising one is a decision that the page may cost more. |
| `scenarios.cjs` | What is done to the page: 24 states at rest, the home rails' ‹ ›, wheel scrolling, track changes, rounds of use. |
| `soak.cjs` | Rounds of use for as long as asked (`--minutes`, `--rounds`, `--platform mac`, `--theme glass`, `--modules moodwave`). |
| `report.cjs` | Prints the numbers without judging them; compares two saved runs. |
| `lib/harness.cjs` | Opens the page and reads the counters (Chrome DevTools Protocol). |
| `lib/probe.js` | Counts timers, animation frames and observers inside the page, with the line that asked for each. |
| `lib/trace.cjs` | Reads a Chromium trace of one action: main-thread time by kind, frames shown and dropped. |

Useful switches: `MIKU_PERF_ONLY="rail|scroll"` runs only the tests whose name matches. `MIKU_TEST_ROOT=<another
checkout>` measures that checkout's page with these tests (how the "before" columns below were made).
`MIKU_EXT_MOODWAVE=<folder>` adds the MoodWave module where `Extensions/MoodWave` is not checked out.
`MIKU_PERF_CPU_SCALE=2` widens the CPU ceilings on a slow machine; the counts never need it. `MIKU_TEST_HEADED=1`
shows the window.

## What the numbers mean

The counts are the strict part: they are the same on every machine. Playing music on the home page, the page draws
the progress bar ten times a second and steps the signal badge 24 times a second: about 32 style passes and 10 layouts
a second, and nothing else may tick. A per-frame loop, an observer that answers every scroll frame, a decoration
that keeps running where nobody sees it, a listener or a node left behind per visit: each shows up as a count over
its budget.

Headless Chromium draws in software, so "all CPU" (every Chromium process) overstates what compositing costs on a
machine with a GPU: read it as a comparison between two runs on the same machine, not as what a user's PC will show.
The main thread's share is the page's own work and carries over better.

## Evidence from 2026-11-19

Chromium 157, headless, 4 cores. "Before" is the page as of `d816f09`, measured with the same tests.

**The home rails' ‹ › buttons.** A click used to cost 745 style passes and 566 layouts (an observer chain answered
every frame of the glide and went on for a second after it); now 65 and 16. Main-thread work per click went from
474 ms to 199 ms. Clicks also travelled different distances: two quick clicks moved 1188 px instead of two pages
(1980 px), and coming back from the end of a rail moved 1040 px, then 594 px, instead of landing on the stops it had
passed on the way out. Every click now travels one page of whole cards, forward and back over the same stops, and
the covers of the page a click is about to show are loaded before the glide instead of during it.

**Wheel scrolling the album grid** (40 notches). Style passes 580 → 122 a second, layouts 394 → 38, observer
callbacks 572 → 112, main-thread work 2273 ms → 1422 ms.

**At rest, per second:**

| | style passes | layouts | timers and frames | main thread |
| --- | --- | --- | --- | --- |
| Playing, home (Hi-Res badge) | 139 → 33 | 10 → 10 | 29 → 29 | see below |
| Playing, home (DSD badge) | 167 → 33 | 10 → 10 | 29 → 29 | |
| Playing, now playing, line lyrics | 234 → 8 | 107 → 7 | 63 → 6 | 9.8 % → 3.8 % |
| Playing, now playing, word lyrics | 170 → 9 | 56 → 9 | 51 → 10 | 7.6 % → 4.7 % |
| Playing, now playing, Glass | 197 → 5 | 72 → 4 | 60 → 2 | 5.2 % → 1.9 % |
| Playing, home, Glass | 140 → 13 | 10 → 6 | 30 → 29 | 8.9 % → 5.5 % |
| Playing, home, Vinyl | 168 → 52 | 10 → 10 | 29 → 29 | 28.8 % → 13.7 % |
| Paused, minimized, or nothing playing | under 1.2 | 0 | 0 to 1 | about 0.1 % |

On the home page of the default theme the main thread's share is about what it was (10 to 12 % of one core here):
what it pays for is the badge's 24 frames a second, each of which makes Chromium go through the whole page's layers
again, and that part is unchanged. With the badge's loops switched off (設定 → 輕量化頁面 → 關閉音訊鏈路特效) it is
about 3.5 %.

**Compositor layers on the home page.** Default theme 102 → 47, Glass 365 → 70, Vinyl 344 → 49. Every card had one
or two layers of its own: an entrance animation that kept its last frame, Glass's blur behind a play button that
was not showing, Vinyl's record kept ready to slide.

**Thirty rounds of use** (every page, an album, an artist, search, the queue, the signal card, now playing, three
track changes, a rail click, wheel scrolling), read after a full collection every five rounds:

| | before | after |
| --- | --- | --- |
| DOM nodes held, per round | +290 | 0 |
| Event listeners held, per round | +31 | 0 |
| Nodes held after 30 rounds | 14,217 | about 5,700 |
| Animations left behind | 58 | 6 |
| Timers pending | 41 | 1 |
| Style passes a second at rest afterwards | 196 | 29 |

Four things were being kept. The settings page subscribed to host events on every visit and never unsubscribed
(about 150 nodes and 9 to 15 listeners a visit). The shortcuts tab watched `<html>`'s classes for its full-screen
button and let go only the next time those classes changed: on the Mac, where they seldom do, every visit to the tab
stayed (about 200 nodes and 20 listeners). The player bar's cover and the now-playing cover were chained: each new
picture's load handler held the picture it replaced, so every cover shown since the start stayed in memory, one more
for each track or album played. And finished entrance animations stayed attached to their elements.

## Not changed

- The MoodWave module keeps a per-frame loop while its own page follows the playing track. It lives in its own
  repository.
- Now playing's lyric lines are each a compositor layer (about 60), and its blurred background drifts for as long as
  the page is open: in software rendering that is a full core of "all CPU". Both are how the page looks.
