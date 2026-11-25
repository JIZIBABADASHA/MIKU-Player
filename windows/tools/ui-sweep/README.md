# UI sweep

Opens the player's web UI with a mock host (`mock.js`: a small library, a playing track, canned answers) and walks
every theme × day/night × page × window size, measuring each one with `check.js`:

- **clip**: a button or control partly cut off by its box or the window
- **half**: a line of text only partly visible (for example a third line peeking under a two-line title)
- **hcut**: a line of text cut sideways without an ellipsis
- **overlap**: now-playing info parts on top of each other, a sticker over the title, lyrics over the info column,
  play bar items on top of each other, parts of one sidebar link on top of each other
- **offscreen**: a key control outside the window or under the play bar

```
npm i playwright && npx playwright install webkit      # once
node sweep.js --root ../../wwwroot --out /tmp/sweep --engine webkit --shots sheet
```

`summary.txt` lists every problem; `sheets/<theme>-<mode>.png` shows the pages at six window sizes (red frame = the
checker found something there). Pages: home, album, settings, home with a MoodWave channel playing (`homemw`), now
playing with a Japanese title (`np`), a very long title (`np2`), no lyrics (`npnl`) and a MoodWave channel (`npmw`).
