# UI sweep

Opens the player's web UI with a mock host (`mock.js`: a small library, a playing track, canned answers) and walks
every theme × day/night × page × window size, measuring each one with `check.js`:

- **clip**: a button or control partly cut off by its box or the window, or an action button squeezed until its own
  label is cut (the "is this cover right?" prompt on a narrow album page)
  A control in a page that scrolls up and down is still flagged when it is cut at the page's **side**: no scrolling
  brings that back (the 專輯 page's toolbar ran out of the page to the right at 980x640 and lost its last buttons).
- **half**: a line of text only partly visible (for example a third line peeking under a two-line title); a lyric
  line whose first row has scrolled out of the box while its other rows or its translation still show at reading
  strength (terminal left 「take me higher」 and its translation under the top edge)
- **hcut**: a line of text cut sideways without an ellipsis
- **overlap**: now-playing info parts on top of each other, a sticker over the title, lyrics over the info column
  (timed lines, the untimed block and the "no lyrics" notice alike: vinyl's untimed lyrics once sat on the player
  unnoticed), play bar items on top of each other, parts of one sidebar link on top of each other, the seam of a
  two-colour backdrop running through the cover or the title (flat 2 with MoodWave's wheel), a theme's small printed
  label in the top row, or a strip of ornament drawn along the top of now playing, running behind an extension's
  panel (neon's "LIVE.FEED" and gold's bead garland behind the MoodWave logo in a short window)
  On the library pages: a theme's ornament hung in a corner of the page (a pseudo-element of the page's own boxes, such as
  washi's crescent moon at night) on, or within 4px of, a button of the page's title row or of the top bar.
  The sidebar: no row of its list shows on top of another (a row scrolled under the pinned 設定 must be hidden or cut).
- **cut**: a row of lyrics cut at the side by the window or its box
- **offscreen**: a key control outside the window or under the play bar; 設定 out of sight in the sidebar, so that the
  list has to be scrolled to reach it (a short window: it now stays at the bottom of the list)
- **touch**: the now-playing buttons touching each other, a round button squashed out of shape, or lyrics flush
  against the player (less than 8 px of air)
- **orphan**: a two-line title whose second line is a single character or a short stub; a timed lyric line ending
  in one character on a row of its own (a phrase with no space in it, longer than the row); a line of untimed
  lyrics ending in a short word on a row of its own
- **font**: now playing carries a different font variable than the theme's own. On a MoodWave channel the page takes
  the theme's night colours from a generated copy; that copy once carried an older title font too (vinyl, wood)
- **squeeze**: the play bar dropped the song title although there is room for it. The MoodWave pages bring the
  channel's strip in the way the app does (the bar's left part slides in from the edge), because measuring on the
  way once left the bar compact until the window was resized
- **blank**: a song is playing and the play bar's title cannot be seen: empty, or left invisible. The title comes in
  with a short entrance that starts from invisible; the app once played it again whenever the same song was drawn
  again (4 s after the start, among others), and a still taken on a busy machine caught it before its first frame.
  The sweep now waits for the app's start-up redraws, ends entrances that have not been given a frame, and checks
  the bar's title once more right after each screenshot, so a picture and its check cannot disagree
- **short**: a name that must be whole is cut with an ellipsis: a channel in MoodWave's wheel on now playing
  (its names are set in the theme's font; terminal's monospace cut "Shuffle All"), and an album's name cut after two
  lines while an ornament shares its row (vinyl's turntable: it now gives way when the name needs the room)
- **align**: a theme's mark before the page title (終端機's "$") is off the middle of the title by more than about a
  fifth of its height. The page set includes `mwtitle`: MoodWave's own title (its heart, then the name), where the heart
  pulled the row's baseline down and the "$" with it.
- **tilt**: a tilted sticker on the cover leans the wrong way for its corner: clockwise on a right corner, the other way
  on a left one (fit.js marks the side the poster's NOW PLAYING burst went to: data-st r / l).
- **junk**: a value that was never filled in is on show as text: "undefined", "NaN" or "[object Object]" (設定 > 音訊
  read "undefined ms" for the buffer size, because the test data had no buffer size; the hosts always send one).
- **faint**: text too faint to read. `contrast.js` measures it from the pixels of a screenshot (so gradients, pictures
  and textures count): the line's median pixel is the paper, the text's own colour laid over it is the ink, and their
  contrast ratio must reach 2.05:1 (`--faint 0` switches it off). Measured at three sizes: the full sidebar, the folded
  one, the two-row bar. Dense bold characters (瀏覽 at 13px) cover more than half of their line box, so the median is a
  blend of ink and paper and read as 1.9:1 for cream on red: when the top or the bottom pixel row of the line box is one
  flat colour inside the fill the text sits on, that row is the paper.

```
npm i playwright && npx playwright install webkit      # once
node sweep.js --root ../../wwwroot --out /tmp/sweep --engine webkit --shots sheet
```

`summary.txt` lists every problem; `sheets/<theme>-<mode>.jpg` shows the pages at six window sizes (red frame = the
checker found something there). Pages: home (paired with another computer, so the 本地 / 遠端 switch shows), album,
settings, home with a MoodWave channel (`homemw`) or station (`homeradio`) playing, now playing with a Japanese title
(`np`), a very long title (`np2`), no lyrics (`npnl`), lyrics without timing (`npplain`), a MoodWave channel (`npmw`,
`npplainmw`) and a MoodWave station (`npradio`). `--title 'レプリカント'` tries one title of your own.
