# UI sweep

Opens the player's web UI with a mock host (`mock.js`: a small library, a playing track, canned answers) and walks
every theme × day/night × page × window size, measuring each one with `check.js`:

- **clip**: a button or control partly cut off by its box or the window
- **half**: a line of text only partly visible (for example a third line peeking under a two-line title)
- **hcut**: a line of text cut sideways without an ellipsis
- **overlap**: now-playing info parts on top of each other, a sticker over the title, lyrics over the info column,
  play bar items on top of each other, parts of one sidebar link on top of each other
- **offscreen**: a key control outside the window or under the play bar
- **touch**: the now-playing buttons touching each other, or a round button squashed out of shape
- **orphan**: a two-line title whose second line is a single character or a short stub
- **squeeze**: the play bar dropped the song title although there is room for it
- **faint**: text too faint to read. `contrast.js` measures it from the pixels of a screenshot (so gradients, pictures
  and textures count): the line's median pixel is the paper, the text's own colour laid over it is the ink, and their
  contrast ratio must reach 2.05:1 (`--faint 0` switches it off). Measured at three sizes: the full sidebar, the folded
  one, the two-row bar.

```
npm i playwright && npx playwright install webkit      # once
node sweep.js --root ../../wwwroot --out /tmp/sweep --engine webkit --shots sheet
```

`summary.txt` lists every problem; `sheets/<theme>-<mode>.jpg` shows the pages at six window sizes (red frame = the
checker found something there). Pages: home (paired with another computer, so the 本地 / 遠端 switch shows), album,
settings, home with a MoodWave channel (`homemw`) or station (`homeradio`) playing, now playing with a Japanese title
(`np`), a very long title (`np2`), no lyrics (`npnl`), lyrics without timing (`npplain`), a MoodWave channel (`npmw`,
`npplainmw`) and a MoodWave station (`npradio`). `--title 'レプリカント'` tries one title of your own.
