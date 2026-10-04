using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Miku.Audio;
using Miku.Library;

namespace Miku.Host;

public sealed class MainForm : Form
{
    const string AppHost = "app.miku";
    const string MediaHost = "media.miku";
    static readonly Color Bg = Color.FromArgb(14, 15, 19);

    readonly WebView2 _web;
    readonly Settings _s;
    readonly MusicLibrary _lib;
    readonly ArtworkService _art;
    readonly LyricsService _lyrics;
    IAudioEngine _engine;
    readonly Player _player;
    readonly System.Windows.Forms.Timer _tick;
    readonly System.Windows.Forms.Timer _saveTimer;
    bool _ready;
    CancellationTokenSource _artJob;
    CancellationTokenSource _lyricsJob;
    readonly string _debugDir;
    readonly System.Windows.Forms.Timer _debugTimer;
    bool _debugBusy;
    bool _scanStarted;
    WebView2 _yt;
    Task _ytInit;

    /// <summary>YouTube Music runs in its own WebView2 layered over the content area (same profile, so the login persists).</summary>
    Task EnsureYt() => _ytInit ??= InitYt();

    CoreWebView2SharedBuffer _ytBuf;
    YtMeta _ytMeta = new();
    Track _liveTrack;

    sealed class YtMeta
    {
        public double T { get; set; }
        public double D { get; set; }
        public bool P { get; set; }
        public string Title { get; set; }
        public string By { get; set; }
        public string Img { get; set; }
        public double Gap { get; set; }
    }
    string _ytSink;
    long _ytMetaAt;          // Stopwatch timestamp when _ytMeta arrived
    double _liveLatency;     // smoothed seconds from the page's currentTime to the DAC

    /// <summary>
    /// Position of YouTube Music as heard from the DAC. The page reports currentTime only about every 0.5 s while the
    /// state goes out every 0.2 s, so it is extrapolated from the moment the report arrived (otherwise the same old
    /// value is sent two or three times and the progress bar keeps jumping back). The page also runs ahead of what is
    /// heard by the capture / output buffers (about 0.4 s with the MIKU core, 1 s with Rplay): that latency is
    /// subtracted, smoothed so its natural ripple doesn't make the bar jitter, so the bar and lyrics follow the sound.
    /// </summary>
    double LivePosition(bool playing)
    {
        var m = _ytMeta;
        double t = m.T;
        if (m.P && playing && _ytMetaAt != 0)
            t += Math.Min(1.5, (Stopwatch.GetTimestamp() - _ytMetaAt) / (double)Stopwatch.Frequency);
        if (m.D > 0) t = Math.Min(t, m.D);
        double lat = LiveLatencyEstimate();
        _liveLatency = _liveLatency <= 0 ? lat : _liveLatency + (lat - _liveLatency) * 0.1;   // ~2 s time constant at 5 Hz
        return Math.Max(0, t - _liveLatency);
    }

    double LiveLatencyEstimate()
    {
#if HAS_RPLAY
        if (_engine is RplayEngine r) return r.LiveLatency;
#endif
        // MIKU core: LiveSource's fill (ring + its own buffer) + the output buffer
        return LiveBus.Fill + Math.Clamp(_s.BufferMs, 30, 1000) / 1000.0;
    }

    const string YtTapScript = @"(() => {
  if (window.top !== window) return;
  const wv = window.chrome && window.chrome.webview;
  if (!wv) return;
  let buf = null, ring = null, hdr = null, cap = 0, ctx = null, node = null, ready = null, lastMsg = 0, gapMax = 0, lastMeta = 0, kind = '';
  const hooked = new WeakSet();
  wv.addEventListener('sharedbufferreceived', e => {
    buf = e.getBuffer();
    hdr = new Uint32Array(buf, 0, 4);
    ring = new Float32Array(buf, 16);
    cap = ring.length / 2;
    hdr[0] = 0;
  });
  function write(l, r) {
    if (!ring) return;
    let w = hdr[0];
    for (let k = 0; k < l.length; k++) { const p = (w % cap) * 2; ring[p] = l[k]; ring[p + 1] = r[k]; w = (w + 1) >>> 0; }
    hdr[0] = w;
  }
  function chunk(l, r) {
    const now = performance.now();
    if (lastMsg) gapMax = Math.max(gapMax, now - lastMsg);
    lastMsg = now;
    write(l, r);
    if (now - lastMeta > 450) meta();
  }
  // the tap runs on the audio thread (AudioWorklet) and hands blocks to this thread by message, so a busy
  // page can only delay the audio (MIKU's buffer absorbs that) but never lose any of it
  const WORKLET = `class MikuTap extends AudioWorkletProcessor {
    constructor() { super(); this.n = 0; this.l = new Float32Array(2048); this.r = new Float32Array(2048); }
    process(inputs) {
      const i = inputs[0];
      if (i && i.length) {
        const L = i[0], R = i[1] || i[0];
        this.l.set(L, this.n); this.r.set(R, this.n); this.n += L.length;
        if (this.n >= 2048) {
          this.port.postMessage([this.l, this.r], [this.l.buffer, this.r.buffer]);
          this.l = new Float32Array(2048); this.r = new Float32Array(2048); this.n = 0;
        }
      }
      return true;
    }
  }
  registerProcessor('miku-tap', MikuTap);`;
  function ensure() {
    if (ready) return ready;
    // render without any output device: the page must never open the DAC itself
    try { ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback', sinkId: { type: 'none' } }); }
    catch (e) { ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' }); }
    ready = (async () => {
      try {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(url);
        node = new AudioWorkletNode(ctx, 'miku-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
        node.port.onmessage = e => chunk(e.data[0], e.data[1]);
        kind = 'worklet';
      } catch (err) {
        // fallback: main-thread processor with a large buffer so short stalls don't drop audio
        node = ctx.createScriptProcessor(16384, 2, 2);
        node.onaudioprocess = e => { const ib = e.inputBuffer; chunk(ib.getChannelData(0), ib.numberOfChannels > 1 ? ib.getChannelData(1) : ib.getChannelData(0)); };
        kind = 'script';
      }
      node.connect(ctx.destination);
      wv.postMessage('yt-rate:' + ctx.sampleRate + ':' + (ctx.sinkId && ctx.sinkId.type ? 'none' : 'device') + ':' + kind);
    })();
    return ready;
  }
  async function hook(v) {
    try {
      await ensure();
      if (!hooked.has(v)) { hooked.add(v); ctx.createMediaElementSource(v).connect(node); }
      if (ctx.state !== 'running') await ctx.resume();
    } catch (err) { wv.postMessage('yt-err:' + (err && err.message || err)); }
  }
  // route every media element into the tap *before* it starts playing, so Chromium never opens its own
  // output stream on the DAC (even a muted one blocks WASAPI exclusive mode for MIKU)
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const el = this;
    if (hooked.has(el)) return origPlay.apply(el, arguments);
    return hook(el).then(() => origPlay.call(el));
  };
  // hook any media element that already exists or appears later
  const scan = () => document.querySelectorAll('video, audio').forEach(v => { if (!hooked.has(v) && !v.paused) hook(v); });
  setInterval(scan, 1000);
  document.addEventListener('play', e => {
    const v = e.target;
    if (v && (v.tagName === 'VIDEO' || v.tagName === 'AUDIO')) hook(v);
    wv.postMessage('yt-play');
  }, true);
  document.addEventListener('pause', () => wv.postMessage('yt-pause'), true);
  // F11 = MIKU's full screen, also while this page has the keyboard focus
  document.addEventListener('keydown', e => { if (e.key === 'F11') { e.preventDefault(); e.stopPropagation(); wv.postMessage('miku-f11'); } }, true);
  window.__mikuStop = () => { document.querySelectorAll('video,audio').forEach(v => v.pause()); if (ctx && ctx.state === 'running') ctx.suspend(); };
  function meta() {
    lastMeta = performance.now();
    const v = document.querySelector('video');
    if (!v) return;
    const bar = document.querySelector('ytmusic-player-bar');
    const q = s => bar && bar.querySelector(s);
    const img = q('img.image') || q('img');
    const title = (q('.title') || {}).textContent || '';
    const [t, d] = trackTime(v, q, title);
    wv.postMessage(JSON.stringify({ k: 'meta', t, d, p: !v.paused,
      title, by: (q('.byline') || {}).textContent || '', img: img ? img.src : '', gap: Math.round(gapMax) }));
    gapMax = 0;
  }
  // YouTube Music plays a queue gaplessly as one media stream: the <video> timeline does not restart at 0 for each
  // song (currentTime / duration include the songs before it). The player bar's slider has the song's own position
  // (whole seconds) and length, so use its length, and the song's start in the stream (currentTime - slider value,
  // the smallest one seen for this song) to keep the exact, smooth currentTime.
  let songKey = '', songStart = null;
  function trackTime(v, q, title) {
    const ct = v.currentTime || 0, vd = isFinite(v.duration) ? v.duration : 0;
    const pb = q('#progress-bar');
    const now = pb ? parseFloat(pb.getAttribute('aria-valuenow') ?? pb.value) : NaN;
    const max = pb ? parseFloat(pb.getAttribute('aria-valuemax') ?? pb.max) : NaN;
    if (!(max > 0) || !isFinite(now)) return [ct, vd];
    const key = title + '|' + max;
    if (key !== songKey) { songKey = key; songStart = null; }
    const s = ct - now;   // the slider shows whole seconds: s overestimates the start by up to 1 s
    if (songStart === null || s < songStart || s > songStart + 2) songStart = s;   // > 2 s: the stream jumped (same song again)
    return [Math.min(max, Math.max(0, ct - songStart)), max];
  }
  // Seek to a position in the current song (the time MIKU shows). Use the player's own API, which maps the song time
  // onto the gapless stream itself; setting video.currentTime directly bypasses YouTube Music's player (and it is in
  // stream time, not song time). Fallback: the song's start in the stream + the song time.
  window.__mikuSeek = sec => {
    const p = document.getElementById('movie_player');
    if (p && typeof p.seekTo === 'function') { p.seekTo(sec, true); return 'api'; }
    const v = document.querySelector('video');
    if (!v) return 'none';
    v.currentTime = (songStart ?? 0) + sec;
    return 'video';
  };
  setInterval(() => { if (performance.now() - lastMeta > 450) meta(); }, 500);
})();";

    async Task InitYt()
    {
        _yt = new WebView2 { Visible = false, DefaultBackgroundColor = Color.FromArgb(3, 3, 3) };
        Controls.Add(_yt);
        _yt.BringToFront();
        await _yt.EnsureCoreWebView2Async(_web.CoreWebView2.Environment);
        var core = _yt.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDevToolsEnabled = true;
        // shared memory ring the page writes captured audio into (2 s of 48 kHz stereo float)
        int cap = LiveBus.Rate * 2;
        _ytBuf = core.Environment.CreateSharedBuffer((ulong)(16 + cap * 2 * 4));
        LiveBus.Ptr = _ytBuf.Buffer;
        LiveBus.CapFrames = cap;
        await core.AddScriptToExecuteOnDocumentCreatedAsync(YtTapScript);
        core.DOMContentLoaded += (_, _) =>
        {
            try { core.PostSharedBufferToScript(_ytBuf, CoreWebView2SharedBufferAccess.ReadWrite, null); }
            catch (Exception ex) { Log.Error("YT shared buffer", ex); }
        };
        core.WebMessageReceived += (_, e) =>
        {
            string m = null;
            try { m = e.TryGetWebMessageAsString(); } catch { }
            if (m == "yt-play") _ = OnYtPlay();
            else if (m == "miku-f11") SetFullScreen(!_fullScreen);   // F11 while the YouTube Music page has the focus
            else if (m != null && m.StartsWith("yt-rate:"))
            {
                var parts = m.Split(':');
                if (int.TryParse(parts[1], out int sr) && sr > 8000) LiveBus.SourceRate = sr;
                _ytSink = string.Join("/", parts.Skip(2));
                Log.Info("YouTube capture " + m);
            }
            else if (m != null && m.StartsWith("yt-err:")) { Log.Info("YouTube audio hook: " + m); Post("error", new { message = "無法把 YouTube 的聲音導入 MIKU：" + m[7..] }); }
            else if (m == "yt-pause") { if (_engine.Track?.IsLive == true && _engine.IsPlaying) _engine.Pause(); PostSoon("state"); }
            else if (m != null && m.StartsWith("{"))
            {
                try
                {
                    var meta = Json.Deserialize<YtMeta>(m);
                    if (meta != null)
                    {
                        meta.Title = meta.Title?.Trim(); meta.By = meta.By?.Trim();
                        bool changed = meta.Title != _ytMeta.Title || meta.By != _ytMeta.By;
                        _ytMeta = meta;
                        _ytMetaAt = Stopwatch.GetTimestamp();
                        if (changed && _engine.Track?.IsLive == true) PostSoon("state");
                    }
                }
                catch { }
            }
        };
        core.NewWindowRequested += (_, e) =>
        {
            // keep YouTube / Google sign-in inside the panel, open anything else in the browser
            var u = new Uri(e.Uri);
            if (u.Host.EndsWith("youtube.com") || u.Host.EndsWith("google.com") || u.Host.EndsWith("gstatic.com")) { e.Handled = true; core.Navigate(e.Uri); }
            else { e.Handled = true; OpenExternal(e.Uri); }
        };
        // the page's own audio output is never used (MIKU plays it); muting also stops Chromium from
        // opening the DAC, which would block exclusive mode
        core.IsMuted = true;
        try { await core.CallDevToolsProtocolMethodAsync("Page.setBypassCSP", "{\"enabled\":true}"); }
        catch (Exception ex) { Log.Error("YT bypass CSP", ex); }
        core.Navigate("https://music.youtube.com/");
    }

    /// <summary>YouTube started playing: route it through MIKU's engine (device, exclusive mode, DSP, volume).</summary>
    async Task OnYtPlay()
    {
        if (_engine.Track?.IsLive == true && _engine.IsLoaded)
        {
            if (!_engine.IsPlaying) _engine.Resume();
            PostSoon("state");
            return;
        }
        if (_ytLoading) return;
        _ytLoading = true;
        try
        {
            if (_engine.Track != null && !_engine.Track.IsLive) _player.SaveState();
            _liveTrack ??= new Track { Id = "yt-live", Title = "YouTube Music", Codec = "YouTube", SampleRate = LiveBus.Rate, Bits = 0, Channels = 2 };
            await _engine.LoadAsync(_liveTrack, 0, true);
            if (!_engine.IsLoaded && _engine.LastFailureWasDevice)
            {
                // the DAC may still be closing the album's stream: try once more before giving up
                await Task.Delay(800);
                if (_engine.Track?.IsLive == true) await _engine.LoadAsync(_liveTrack, 0, true); // unless an album track was picked meanwhile
            }
            // never leave YouTube playing silently: if MIKU couldn't take it, pause the page too
            if (!_engine.IsLoaded && _engine.Track?.IsLive == true) PauseYt();
        }
        finally { _ytLoading = false; }
        PostSoon("state");
    }

    bool LiveActive => _engine.Track?.IsLive == true;
    bool _ytLoading; // switching to YouTube: the album track is still playing until the live stream opens

    async Task YtScript(string js)
    {
        if (_yt?.CoreWebView2 == null) return;
        try { await _yt.CoreWebView2.ExecuteScriptAsync(js); } catch { }
    }

    Task YtClick(string selector) => YtScript($"(document.querySelector('ytmusic-player-bar {selector}') || {{ click(){{}} }}).click()");

    void PauseYt()
    {
        if (_yt == null || !IsHandleCreated) return;
        BeginInvoke(new Action(async () =>
        {
            if (_yt.CoreWebView2 == null) return;
            try { await _yt.CoreWebView2.ExecuteScriptAsync("window.__mikuStop ? window.__mikuStop() : document.querySelectorAll('video,audio').forEach(v => v.pause())"); } catch { }
        }));
    }
    bool _autoArtStarted;

    /// <summary>
    /// Developer hook, only active when a "debug" folder exists next to the exe:
    /// runs debug\cmd.js in the page, then saves a screenshot and the result.
    /// </summary>
    async Task DebugTick()
    {
        if (_debugBusy || _web.CoreWebView2 == null) return;
        string cmd = Path.Combine(_debugDir, "cmd.js");
        if (!File.Exists(cmd)) return;
        _debugBusy = true;
        try
        {
            string script = await File.ReadAllTextAsync(cmd);
            File.Delete(cmd);
            string result;
            try { result = await _web.CoreWebView2.ExecuteScriptAsync(script); }
            catch (Exception ex) { result = "EXCEPTION " + ex.Message; }
            int wait = 900;
            var m = System.Text.RegularExpressions.Regex.Match(script, @"//\s*wait\s*(\d+)");
            if (m.Success) wait = int.Parse(m.Groups[1].Value);
            await Task.Delay(wait);
            using (var ms = new MemoryStream())
            {
                var cap = _web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, ms);
                if (await Task.WhenAny(cap, Task.Delay(4000)) == cap && ms.Length > 0)
                    await File.WriteAllBytesAsync(Path.Combine(_debugDir, "shot.png"), ms.ToArray());
            }
            string log = "";
            try
            {
                using var lf = new FileStream(AppPaths.LogFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                using var sr = new StreamReader(lf);
                string all = sr.ReadToEnd();
                log = all.Length > 6000 ? all[^6000..] : all;
            }
            catch { }
            await File.WriteAllTextAsync(Path.Combine(_debugDir, "result.txt"), result + "\n----- log -----\n" + log);
        }
        catch (Exception ex) { Log.Error("Debug", ex); }
        finally { _debugBusy = false; }
    }

    public MainForm()
    {
        _s = Json.Load<Settings>(AppPaths.Settings);
        if (_s.Dsp.Bands.Count == 0) _s.Dsp.Bands = DefaultBands();

        Text = Program.AppName;
        BackColor = Bg;
        MinimumSize = new Size(980, 640);
        StartPosition = FormStartPosition.Manual;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        RestoreWindow();

        _web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Bg };
        Controls.Add(_web);

        _lib = new MusicLibrary(_s);
        _art = new ArtworkService(_lib, _s);
        ArtworkService.DropOldThumbs();
        _lyrics = new LyricsService(_s);
        _engine = CreateEngine();
        _player = new Player(_engine, _lib, _s);
        WireEngine(_engine);
        _player.NowChanged += () => PostSoon("state");
        _player.QueueChanged += () => PostSoon("queue");
        _lib.ProgressChanged += p =>
        {
            Post("scan", p);
            if (!p.Scanning && !_autoArtStarted && _s.OnlineArt && _lib.Count > 0)
            {
                _autoArtStarted = true;
                var cts = _artJob = new CancellationTokenSource();
                _ = Task.Run(async () => { try { await _art.FetchAllMissing(null, cts.Token, retryMisses: false); } catch { } });
            }
        };
        _lib.Changed += () => { _player.Validate(); Post("library", new { revision = _lib.Revision }); };
        _art.Updated += (kind, id) => Post("art", new { kind, id });

        _tick = new System.Windows.Forms.Timer { Interval = 200 };
        _tick.Tick += (_, _) => { if (_ready) Post("state", State(), tick: true); };
        _debugDir = Path.Combine(AppPaths.AppDir, "debug");
        if (Directory.Exists(_debugDir))
        {
            _debugTimer = new System.Windows.Forms.Timer { Interval = 400 };
            _debugTimer.Tick += async (_, _) => await DebugTick();
            _debugTimer.Start();
        }
        _saveTimer = new System.Windows.Forms.Timer { Interval = 1500 };
        _saveTimer.Tick += (_, _) => { _saveTimer.Stop(); SaveSettings(); };

        Load += async (_, _) => await InitWebView();
        Shown += (_, _) => StartRemote();
    }

    static List<EqBand> DefaultBands() => new[] { 32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000 }
        .Select((f, i) => new EqBand { Fc = f, Q = 1.0, Type = i == 0 ? "LSC" : i == 9 ? "HSC" : "PK" }).ToList();

    // ───────────────────────────── window chrome ─────────────────────────────

    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try
        {
            int dark = 1;
            DwmSetWindowAttribute(Handle, 20, ref dark, 4);              // immersive dark mode
            int caption = Bg.R | (Bg.G << 8) | (Bg.B << 16);
            DwmSetWindowAttribute(Handle, 35, ref caption, 4);           // caption colour (Win 11)
            int text = 0xE6E2DC;
            DwmSetWindowAttribute(Handle, 36, ref text, 4);              // caption text colour
        }
        catch { }
        RegisterHotKey(Handle, 1, 0, 0xB3); // play/pause
        RegisterHotKey(Handle, 2, 0, 0xB0); // next
        RegisterHotKey(Handle, 3, 0, 0xB1); // previous
        RegisterHotKey(Handle, 4, 0, 0xB2); // stop
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x0312) // WM_HOTKEY
        {
            switch (m.WParam.ToInt32())
            {
                // while YouTube is the source, media keys drive the YouTube player (like MIKU's own buttons)
                case 1: _ = LiveActive ? YtClick(".play-pause-button") : _player.Toggle(); break;
                case 2: _ = LiveActive ? YtClick(".next-button") : _player.Next(); break;
                case 3: _ = LiveActive ? YtClick(".previous-button") : _player.Previous(); break;
                case 4: if (LiveActive) PauseYt(); else _engine.Pause(); break;
            }
        }
        base.WndProc(ref m);
    }

    void RestoreWindow()
    {
        var w = _s.Window;
        Rectangle r = w is { Length: 4 } ? new Rectangle(w[0], w[1], w[2], w[3]) : Rectangle.Empty;
        if (r.Width > 300 && Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(r))) Bounds = r;
        else
        {
            var wa = Screen.PrimaryScreen.WorkingArea;
            int width = Math.Min(1480, wa.Width - 80), height = Math.Min(940, wa.Height - 60);
            Bounds = new Rectangle(wa.X + (wa.Width - width) / 2, wa.Y + (wa.Height - height) / 2, width, height);
        }
        if (_s.Maximized) WindowState = FormWindowState.Maximized;
    }

    // ───────────────────────────── playback core（Settings.AudioCore）─────────────────────────────

    IAudioEngine CreateEngine()
    {
        Action<Action> ui = a => { if (IsDisposed) return; if (InvokeRequired) Invoke(a); else a(); };
#if HAS_RPLAY
        if (_s.AudioCore == "rplay")
        {
            try { return new RplayEngine(_s, ui); }
            catch (Exception ex) { Log.Error("Rplay core", ex); _s.AudioCore = "miku"; }
        }
#else
        // 這個版本沒有編進 Rplay 內核（建置時找不到 ../Rplay），設定成 rplay 也只能用 MIKU 內核
        if (_s.AudioCore == "rplay") Log.Info("Rplay core is not included in this build, using the MIKU core");
#endif
        return new AudioEngine(_s, ui);
    }

    /// <summary>這個版本有沒有編進 Rplay 內核（MIKU.csproj：../Rplay 存在時定義 HAS_RPLAY）。</summary>
#if HAS_RPLAY
    static bool RplayIncluded => true;
#else
    static bool RplayIncluded => false;
#endif

    void WireEngine(IAudioEngine engine)
    {
        engine.Changed += () => { if (!ReferenceEquals(engine, _engine)) return; PostSoon("state"); if (_engine.IsPlaying && _engine.Track?.IsLive != true && !_ytLoading) PauseYt(); };
        engine.Loading += t => { if (!ReferenceEquals(engine, _engine)) return; if (t != null && !t.IsLive && LiveActive) PauseYt(); };
        engine.Failed += msg => { if (ReferenceEquals(engine, _engine)) Post("error", new { message = msg }); };
    }

    /// <summary>
    /// 設定切換了播放內核：短暫停頓後從同一個位置繼續（原本在播就繼續播，YouTube Music 也接著播）。
    /// 1. 先建立新內核、接上 Player 和介面，再停掉舊內核：舊內核在停止過程中發出的事件（例如 Ended）不會再讓 Player 換歌
    /// 2. 舊內核放開 DAC 之後才開新的：回收殘留的 WASAPI / COM 物件，再等一下（獨佔模式、ASIO 都需要時間交接）
    /// 3. 新內核開不到裝置時重試幾次
    /// </summary>
    /// <summary>What was playing when the core switch started; the state shows it until the new core has loaded it.</summary>
    sealed record CoreSwitch(Track Track, bool Playing, double Pos, SignalInfo Signal);
    volatile CoreSwitch _switching;

    async Task SwitchCoreAsync()
    {
        var old = _engine;
        var t = old.Track;
        double pos = old.Position;
        bool play = old.IsPlaying;
        bool isLive = t?.IsLive == true;
        // until the new core has loaded the track, the state keeps showing it (otherwise the empty new core makes the
        // UI fall back to the queue's local track for a moment, or show "paused" at 0:00)
        _switching = t == null ? null : new CoreSwitch(t, play, pos, old.Signal);
        try
        {
            var engine = CreateEngine();
            _engine = engine;
            _player.ReplaceEngine(engine);
            WireEngine(engine);
            Log.Info($"Playback core: {(engine is AudioEngine ? "MIKU" : "Rplay")} (switching at {(isLive ? "YouTube" : t?.Id ?? "-")} {pos:0.00}s, playing={play})");

            try { old.Stop(); } catch (Exception ex) { Log.Error("Stop old core", ex); }
            try { old.Dispose(); } catch (Exception ex) { Log.Error("Dispose old core", ex); }
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            await Task.Delay(300);

            if (t != null)
            {
                for (int attempt = 1; attempt <= 3; attempt++)
                {
                    await engine.LoadAsync(t, isLive ? 0 : pos, play);
                    if (!play || engine.IsLoaded || !engine.LastFailureWasDevice) break;
                    Log.Info($"Switch core: the DAC is not free yet (attempt {attempt}), retrying");
                    await Task.Delay(500);
                }
            }
        }
        finally { _switching = null; }
        PostSoon("state");
    }

    // ───────────────────────────── full screen (F11) ─────────────────────────────

    bool _fullScreen;
    FormWindowState _beforeFullScreen;

    /// <summary>
    /// Full screen: no window frame, covering the taskbar. F11 toggles it (in the app and on the YouTube Music page),
    /// Esc leaves it when nothing else is open. Leaving restores the window as it was.
    /// </summary>
    void SetFullScreen(bool on)
    {
        if (on == _fullScreen || IsDisposed) return;
        SuspendLayout();
        if (on)
        {
            _beforeFullScreen = WindowState;
            // a maximized window must be restored first, or the borderless maximize keeps the old work area
            if (WindowState != FormWindowState.Normal) WindowState = FormWindowState.Normal;
            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Maximized;
        }
        else
        {
            WindowState = FormWindowState.Normal;
            FormBorderStyle = FormBorderStyle.Sizable;
            WindowState = _beforeFullScreen == FormWindowState.Minimized ? FormWindowState.Normal : _beforeFullScreen;
        }
        _fullScreen = on;
        ResumeLayout();
        Post("fullscreen", new { on });
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _tick.Stop();
        _player.SaveState();
        // closed in full screen: remember the window as it was before it
        if (_fullScreen) SetFullScreen(false);
        _s.Maximized = WindowState == FormWindowState.Maximized;
        var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        _s.Window = new[] { b.X, b.Y, b.Width, b.Height };
        SaveSettings();
        for (int i = 1; i <= 4; i++) UnregisterHotKey(Handle, i);
        try { _remote?.Dispose(); } catch { }
        try { _engine.Dispose(); } catch { }
        base.OnFormClosing(e);
    }

    void SaveSettings()
    {
        try { lock (_s) Json.SaveAtomic(AppPaths.Settings, _s); }
        catch (Exception ex) { Log.Error("Save settings", ex); }
    }

    void SaveSoon() { if (IsHandleCreated) BeginInvoke(new Action(() => { _saveTimer.Stop(); _saveTimer.Start(); })); }

    // ───────────────────────────── WebView2 ─────────────────────────────

    async Task InitWebView()
    {
        try
        {
            var options = new CoreWebView2EnvironmentOptions("--disable-features=msSmartScreenProtection,ElasticOverscroll,CalculateNativeWinOcclusion --disable-audio-output --autoplay-policy=no-user-gesture-required");
            var env = await CoreWebView2Environment.CreateAsync(null, AppPaths.WebView, options);
            await _web.EnsureCoreWebView2Async(env);
        }
        catch (Exception ex)
        {
            Log.Error("WebView2", ex);
            MessageBox.Show(this, "需要 Microsoft Edge WebView2 執行階段才能顯示介面。\n請至 https://go.microsoft.com/fwlink/p/?LinkId=2124703 安裝後再開啟。\n\n" + ex.Message,
                Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }
        var core = _web.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDevToolsEnabled = true;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false;
        core.Settings.IsPinchZoomEnabled = false;
        core.Settings.IsSwipeNavigationEnabled = false;
        core.SetVirtualHostNameToFolderMapping(AppHost, Path.Combine(AppPaths.AppDir, "wwwroot"), CoreWebView2HostResourceAccessKind.Allow);
        core.AddWebResourceRequestedFilter($"https://{MediaHost}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnResource;
        core.WebMessageReceived += OnMessage;
        core.NewWindowRequested += (_, e) => { e.Handled = true; OpenExternal(e.Uri); };
        core.NavigationStarting += (_, e) =>
        {
            if (!e.Uri.StartsWith($"https://{AppHost}/", StringComparison.OrdinalIgnoreCase)) { e.Cancel = true; OpenExternal(e.Uri); }
        };
        _lib.Load();
        core.Navigate($"https://{AppHost}/index.html");
    }

    static void OpenExternal(string uri)
    {
        if (uri != null && (uri.StartsWith("https://") || uri.StartsWith("http://")))
            try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
    }

    /// <summary>library.json and artwork, shared by the desktop page and the phone remote.</summary>
    async Task<(byte[] data, string type, string cache)> MediaAsync(string path, System.Collections.Specialized.NameValueCollection query)
    {
        int size = int.TryParse(query?["s"], out var sz) ? Math.Clamp(sz, 16, 2000) : 600;
        byte[] data = null; string type = "image/jpeg"; string cache = "max-age=86400";
        if (path == "/library.json")
        {
            data = await Task.Run(() => _lib.ExportJson());
            type = "application/json; charset=utf-8"; cache = "no-store";
        }
        else if (path.StartsWith("/art/a/")) data = await _art.AlbumAsync(Uri.UnescapeDataString(path[7..]), size);
        else if (path.StartsWith("/art/t/")) data = await _art.TrackAsync(Uri.UnescapeDataString(path[7..]), size);
        else if (path.StartsWith("/art/r/")) data = await _art.ArtistAsync(Uri.UnescapeDataString(path[7..]), size);
        return (data, type, cache);
    }

    async void OnResource(object sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var deferral = e.GetDeferral();
        try
        {
            var uri = new Uri(e.Request.Uri);
            var (data, type, cache) = await MediaAsync(uri.AbsolutePath, System.Web.HttpUtility.ParseQueryString(uri.Query));
            string headers = $"Content-Type: {type}\r\nCache-Control: {cache}\r\nAccess-Control-Allow-Origin: *";
            e.Response = data != null
                ? _web.CoreWebView2.Environment.CreateWebResourceResponse(new MemoryStream(data), 200, "OK", headers)
                : _web.CoreWebView2.Environment.CreateWebResourceResponse(null, 404, "Not Found", "Access-Control-Allow-Origin: *\r\nCache-Control: no-store");
        }
        catch (Exception ex)
        {
            Log.Error("Resource " + e.Request.Uri, ex);
            try { e.Response = _web.CoreWebView2.Environment.CreateWebResourceResponse(null, 500, "Error", "Access-Control-Allow-Origin: *"); } catch { }
        }
        finally { deferral.Complete(); }
    }

    // ───────────────────────────── phone remote ─────────────────────────────

    RemoteServer _remote;
    int _remoteTick;
    static readonly HashSet<string> RemoteEvents = new() { "state", "queue", "error", "library", "favs" };
    // desktop RPCs a paired phone may call (nothing that opens dialogs, touches files or changes output settings)
    static readonly HashSet<string> RemoteAllowed = new()
    {
        "state", "queue", "play", "toggle", "next", "prev", "seek", "volume", "shuffle", "repeat",
        "queue.add", "queue.remove", "queue.move", "queue.jump", "queue.clear", "track", "lyrics", "lyricsLive",
    };

    void StartRemote()
    {
        _remote ??= new RemoteServer(RemoteRpc, (p, q) => OnUi(() => MediaAsync(p, q)),
            (name, code) => Post("remotePair", new { name, code }),
            name => { Post("remotePaired", new { name }); Post("remoteChanged", RemoteInfo()); });
        _remote.Stop();
        if (_s.RemoteEnabled) _remote.Start(Math.Clamp(_s.RemotePort, 1024, 65535));
        Post("remoteChanged", RemoteInfo());
    }

    object RemoteInfo() => new
    {
        enabled = _s.RemoteEnabled,
        port = _s.RemotePort,
        running = _remote?.Running == true,
        error = _remote?.LastError,
        urls = _remote?.Running == true ? _remote.Urls() : new List<string>(),
        devices = _remote?.DeviceList() ?? new List<object>(),
        code = _remote?.PendingCode,
    };

    /// <summary>Runs on the UI thread (where the player, WebViews and settings live) and returns the result.</summary>
    Task<T> OnUi<T>(Func<Task<T>> f)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            BeginInvoke(new Action(async () =>
            {
                try { tcs.SetResult(await f()); } catch (Exception ex) { tcs.SetException(ex); }
            }));
        }
        catch (Exception ex) { tcs.SetException(ex); }
        return tcs.Task;
    }

    Task<object> RemoteRpc(string m, JsonElement a) => OnUi(async () =>
    {
        switch (m)
        {
            case "hello":
                return (object)new
                {
                    app = "MIKU", version = Application.ProductVersion,
                    state = State(), queue = QueueDto(), favorites = _s.Favorites,
                    revision = _lib.Revision, yt = _yt?.CoreWebView2 != null,
                    device = _engine.Caps?.Name,
                };
            case "fav":
            {
                string id = S(a, "id");
                if (B(a, "on")) _s.Favorites.Add(id); else _s.Favorites.Remove(id);
                SaveSoon();
                Post("favs", _s.Favorites);
                return null;
            }
            case "yt.toggle":
            case "yt.next":
            case "yt.prev":
                if (_yt?.CoreWebView2 == null) throw new InvalidOperationException("YouTube Music 還沒開啟，請先在電腦上的 MIKU 打開一次 YouTube Music。");
                await YtClick(m == "yt.toggle" ? ".play-pause-button" : m == "yt.next" ? ".next-button" : ".previous-button");
                return null;
        }
        if (!RemoteAllowed.Contains(m)) throw new InvalidOperationException("遙控不支援這個操作：" + m);
        return await HandleRpc(m, a);
    });

    // ───────────────────────────── messaging ─────────────────────────────

    readonly HashSet<string> _pending = new();
    void PostSoon(string what)
    {
        if (!IsHandleCreated) return;
        lock (_pending) { if (!_pending.Add(what)) return; }
        BeginInvoke(new Action(async () =>
        {
            await Task.Delay(30);
            lock (_pending) _pending.Remove(what);
            if (what == "state") Post("state", State());
            else if (what == "queue") Post("queue", QueueDto());
        }));
    }

    void Post(string ev, object data, bool tick = false)
    {
        if (IsDisposed) return;
        string json = null;
        // phones get state about every 0.6 s (plus immediately on every change) instead of the desktop's 5×/s
        if (_remote != null && RemoteEvents.Contains(ev) && _remote.HasClients && (!tick || ++_remoteTick % 3 == 0))
        {
            try { _remote.Broadcast(json = Json.Serialize(new { ev, d = data })); } catch (Exception ex) { Log.Error("Remote broadcast", ex); }
        }
        if (!_ready) return;
        json ??= Json.Serialize(new { ev, d = data });
        if (InvokeRequired) { try { BeginInvoke(new Action(() => Send(json))); } catch { } }
        else Send(json);
    }

    void Send(string json)
    {
        try { _web.CoreWebView2?.PostWebMessageAsJson(json); } catch (Exception ex) { Log.Error("Post", ex); }
    }

    async void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string raw;
        try { raw = e.TryGetWebMessageAsString(); } catch { return; }
        JsonElement msg;
        try { msg = JsonDocument.Parse(raw).RootElement; } catch { return; }
        int id = msg.TryGetProperty("id", out var idEl) ? idEl.GetInt32() : 0;
        string method = msg.GetProperty("m").GetString();
        JsonElement args = msg.TryGetProperty("a", out var a) ? a : default;
        object result = null; string error = null;
        try { result = await HandleRpc(method, args); }
        catch (Exception ex) { error = ex.Message; Log.Error("RPC " + method, ex); }
        if (id != 0) Send(Json.Serialize(new { id, r = result, e = error }));
    }

    static string S(JsonElement a, string n) => a.ValueKind == JsonValueKind.Object && a.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    static double D(JsonElement a, string n, double def = 0) => a.ValueKind == JsonValueKind.Object && a.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : def;
    static int I(JsonElement a, string n, int def = 0) => a.ValueKind == JsonValueKind.Object && a.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : def;
    static bool B(JsonElement a, string n) => a.ValueKind == JsonValueKind.Object && a.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.True;
    static List<string> L(JsonElement a, string n) => a.ValueKind == JsonValueKind.Object && a.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Array
        ? v.EnumerateArray().Select(x => x.GetString()).Where(x => x != null).ToList() : new List<string>();

    async Task<object> HandleRpc(string m, JsonElement a)
    {
        switch (m)
        {
            case "ready":
                _ready = true;
                _tick.Start();
                if (!_scanStarted && _s.Folders.Count > 0) { _scanStarted = true; _lib.StartScan(); }
                return Init();
            case "init": return Init();
            case "state": return State();
            case "queue": return QueueDto();

            // transport
            case "play":
            {
                var ids = L(a, "ids");
                bool shuffle = a.TryGetProperty("shuffle", out var sh) ? sh.ValueKind == JsonValueKind.True : _s.Shuffle;
                await _player.PlayList(ids, I(a, "start", -1), shuffle);
                return null;
            }
            case "toggle":
                if (LiveActive) { await YtClick(".play-pause-button"); return null; }
                await _player.Toggle(); return null;
            case "next":
                if (LiveActive) { await YtClick(".next-button"); return null; }
                await _player.Next(); return null;
            case "prev":
                if (LiveActive) { await YtClick(".previous-button"); return null; }
                await _player.Previous(); return null;
            case "seek":
                if (LiveActive)
                {
                    string pos = D(a, "pos").ToString(System.Globalization.CultureInfo.InvariantCulture);
                    // song time (what MIKU shows), through the player's API: see __mikuSeek in the tap script
                    await YtScript("window.__mikuSeek ? window.__mikuSeek(" + pos + ") : (() => { const v = document.querySelector('video'); if (v) v.currentTime = " + pos + "; })()");
                    return null;
                }
                await _player.Seek(D(a, "pos")); return null;
            case "lyricsLive":
            {
                var ym = _ytMeta;
                if (string.IsNullOrWhiteSpace(ym.Title)) return null;
                var parts = (ym.By ?? "").Split('•', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
                string artist = parts.Length > 0 ? parts[0].Replace(" 和 ", " ").Replace(" & ", " ") : "";
                var t = new Track { Id = "yt-" + Miku.Text.Hash(ym.Title + "|" + artist), Title = ym.Title, Artist = artist, Album = parts.Length > 1 ? parts[1] : "", Duration = ym.D, Codec = "YouTube" };
                var r = await _lyrics.GetAsync(t);
                var lines = r.Lines.Select(l => new LyricLine { T = l.T, Text = l.Text, Words = l.Words, Trans = Miku.Text.CleanTranslation(l.Trans) }).ToList();
                return new { id = t.Id, r.Source, r.Synced, r.Instrumental, Lines = lines, offset = _s.LyricOffsets.GetValueOrDefault(t.Id) };
            }

            case "stop": _engine.Stop(); return null;
            case "volume":
                _s.VolumeDb = Math.Clamp(D(a, "db", _s.VolumeDb), -80, 0);
                if (a.TryGetProperty("muted", out var mu)) _s.Muted = mu.ValueKind == JsonValueKind.True;
                _engine.ApplyVolume();
                _engine.RefreshSignal();
                SaveSoon();
                return null;
            case "shuffle": _player.SetShuffle(B(a, "on")); SaveSoon(); return null;
            case "repeat": _player.SetRepeat(S(a, "mode")); SaveSoon(); return null;

            // queue
            case "queue.add": _player.Add(L(a, "ids"), B(a, "next")); return null;
            case "queue.remove": _player.Remove(I(a, "i")); return null;
            case "queue.move": _player.Move(I(a, "from"), I(a, "to")); return null;
            case "queue.jump": await _player.JumpTo(I(a, "i")); return null;
            case "queue.clear": _player.ClearUpcoming(); return null;

            // settings
            case "settings": return ApplySettings(a);
            case "dsp":
                _s.Dsp = a.Deserialize<DspConfig>(Json.Options) ?? _s.Dsp;
                _engine.ApplyDsp();
                SaveSoon();
                return null;
            case "presets":
                _s.Presets = a.Deserialize<List<EqPreset>>(Json.Options) ?? new();
                SaveSoon();
                return null;
            case "devices": return await Task.Run(DevicesDto);
            case "probe":
                return await Task.Run(() =>
                {
                    Devices.Invalidate(S(a, "id"));
                    using var d = Devices.Open(S(a, "id"));
                    return CapsDto(Devices.Probe(d));
                });
            case "folder.add":
            {
                using var dlg = new FolderBrowserDialog { Description = "選擇音樂資料夾", UseDescriptionForTitle = true, ShowNewFolderButton = false };
                if (dlg.ShowDialog(this) != DialogResult.OK) return null;
                if (!_s.Folders.Contains(dlg.SelectedPath, StringComparer.OrdinalIgnoreCase)) _s.Folders.Add(dlg.SelectedPath);
                SaveSettings();
                _lib.StartScan();
                return _s.Folders;
            }
            case "folder.addPath":
            {
                string p = S(a, "path");
                if (p != null && Directory.Exists(p) && !_s.Folders.Contains(p, StringComparer.OrdinalIgnoreCase)) _s.Folders.Add(p);
                SaveSettings();
                _lib.StartScan();
                return _s.Folders;
            }
            case "folder.remove":
                _s.Folders.RemoveAll(f => string.Equals(f, S(a, "path"), StringComparison.OrdinalIgnoreCase));
                SaveSettings();
                _lib.StartScan();
                return _s.Folders;
            case "rescan": _lib.StartScan(B(a, "full")); return null;
            case "album.reread":
            {
                string id = S(a, "id");
                var (newId, count) = await Task.Run(() => _lib.RereadAlbum(id));   // thumbnails: ArtworkService (TracksRead)
                return new { albumId = newId, tracks = count };
            }
            case "suggestFolders":
                return new[] { @"D:\MUSIC", @"D:\Music", @"E:\Music", @"E:\MUSIC", Environment.GetFolderPath(Environment.SpecialFolder.MyMusic) }
                    .Where(Directory.Exists).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

            // content
            case "lyrics":
            {
                var t = _lib.GetTrack(S(a, "id"));
                if (t == null) return null;
                var r = await _lyrics.GetAsync(t, B(a, "refresh"));
                var lines = r.Lines.Select(l => new LyricLine { T = l.T, Text = l.Text, Words = l.Words, Trans = Miku.Text.CleanTranslation(l.Trans) }).ToList();
                return new { id = t.Id, r.Source, r.Synced, r.Instrumental, Lines = lines, offset = _s.LyricOffsets.GetValueOrDefault(t.Id) };
            }
            case "lyrics.candidates":
            {
                var t = _lib.GetTrack(S(a, "id"));
                return t == null ? null : await _lyrics.Candidates(t);
            }
            case "lyrics.apply":
            {
                var t = _lib.GetTrack(S(a, "id"));
                if (t == null) return null;
                var r = await _lyrics.Apply(t, S(a, "key"));
                if (r == null) return null;
                var lines = r.Lines.Select(l => new LyricLine { T = l.T, Text = l.Text, Words = l.Words, Trans = Miku.Text.CleanTranslation(l.Trans) }).ToList();
                return new { id = t.Id, r.Source, r.Synced, r.Instrumental, Lines = lines, offset = _s.LyricOffsets.GetValueOrDefault(t.Id) };
            }
            case "lyrics.clear":
            {
                var t = _lib.GetTrack(S(a, "id"));
                if (t != null) await _lyrics.Clear(t);
                return null;
            }
            case "lyrics.autoAlign":
            {
                var t = _lib.GetTrack(S(a, "id"));
                if (t == null) return null;
                var ly = await _lyrics.GetAsync(t);
                if (!ly.Synced || ly.Lines.Count < 4) return new { ok = false, reason = "這首歌沒有同步歌詞" };
                var r = await Task.Run(() => LyricAlign.Estimate(t, ly.Lines.Where(l => l.Text.Length > 0).Select(l => l.T).ToList()));
                if (r == null) return new { ok = false, reason = "無法分析這首歌的音訊" };
                if (!r.Ok) return new { ok = false, reason = "分析結果不夠可靠，請手動調整", offset = r.Offset, confidence = r.Confidence };
                _s.LyricOffsets[t.Id] = r.Offset;
                SaveSoon();
                return new { ok = true, offset = r.Offset, confidence = r.Confidence };
            }
            case "lyricsOffset":
                _s.LyricOffsets[S(a, "id")] = D(a, "offset");
                SaveSoon();
                return null;
            case "fav":
            {
                string id = S(a, "id");
                if (B(a, "on")) _s.Favorites.Add(id); else _s.Favorites.Remove(id);
                SaveSoon();
                return null;
            }
            case "recent.add":
            {
                string id = S(a, "id");
                if (string.IsNullOrEmpty(id)) return null;
                _s.Recent.Remove(id);
                _s.Recent.Insert(0, id);
                if (_s.Recent.Count > 200) _s.Recent.RemoveRange(200, _s.Recent.Count - 200);
                SaveSoon();
                return null;
            }
            case "recent.clear": _s.Recent.Clear(); SaveSoon(); return null;
            case "search.add":
            {
                string q = S(a, "q")?.Trim();
                if (string.IsNullOrEmpty(q)) return null;
                _s.SearchHistory.RemoveAll(x => string.Equals(x, q, StringComparison.OrdinalIgnoreCase));
                _s.SearchHistory.Insert(0, q);
                if (_s.SearchHistory.Count > 20) _s.SearchHistory.RemoveRange(20, _s.SearchHistory.Count - 20);
                SaveSoon();
                return null;
            }
            case "search.remove":
            {
                string q = S(a, "q");
                _s.SearchHistory.RemoveAll(x => string.Equals(x, q, StringComparison.OrdinalIgnoreCase));
                SaveSoon();
                return null;
            }
            case "search.clear": _s.SearchHistory.Clear(); SaveSoon(); return null;
            case "art.retry": _art.RetryAlbum(S(a, "id")); return null;
            case "art.info":
            {
                string id = S(a, "id");
                return new { source = _art.SourceOf(id), confirmed = _s.ArtConfirmed.Contains(id) };
            }
            case "art.candidates": return await _art.Candidates(S(a, "id"), S(a, "q"));
            case "art.setUrl":
                await _art.SetOverrideFromUrl(S(a, "id"), S(a, "url"));
                _s.ArtConfirmed.Add(S(a, "id")); SaveSoon();
                return true;
            case "art.setData":
            {
                string data = S(a, "data") ?? "";
                int comma = data.IndexOf(',');
                if (comma >= 0 && data.StartsWith("data:")) data = data[(comma + 1)..];
                _art.SetOverride(S(a, "id"), Convert.FromBase64String(data));
                _s.ArtConfirmed.Add(S(a, "id")); SaveSoon();
                return true;
            }
            case "art.clear": _art.ClearOverride(S(a, "id")); _s.ArtConfirmed.Remove(S(a, "id")); SaveSoon(); return null;
            case "art.confirm": _s.ArtConfirmed.Add(S(a, "id")); SaveSoon(); return null;
            case "art.reject": _art.RejectOnline(S(a, "id")); _s.ArtConfirmed.Remove(S(a, "id")); SaveSoon(); return null;
            case "art.fetchMissing":
            {
                _artJob?.Cancel();
                var cts = _artJob = new CancellationTokenSource();
                var progress = new Progress<(int done, int total, int found)>(p => Post("artJob", new { p.done, p.total, p.found }));
                _ = Task.Run(async () =>
                {
                    try { await _art.FetchAllMissing(progress, cts.Token); } catch { }
                    Post("artJob", new { done = -1 });
                });
                return null;
            }
            case "art.cancel": _artJob?.Cancel(); return null;
            case "lyrics.fetchAll":
            {
                _lyricsJob?.Cancel();
                var cts = _lyricsJob = new CancellationTokenSource();
                var progress = new Progress<(int done, int total, int found)>(p => Post("lyricsJob", new { p.done, p.total, p.found }));
                _ = Task.Run(async () =>
                {
                    try { await _lyrics.FetchAll(_lib.AllTracks, progress, cts.Token); } catch (Exception ex) { Log.Info("Lyrics job: " + ex.Message); }
                    Post("lyricsJob", new { done = -1 });
                });
                return null;
            }
            case "lyrics.cancel": _lyricsJob?.Cancel(); return null;
            case "artistArt.info": return new { source = _art.ArtistSourceOf(S(a, "name")) };
            case "artistArt.candidates": return await _art.ArtistCandidates(S(a, "name"), S(a, "q"));
            case "artistArt.setUrl": return await _art.SetArtistOverrideFromUrl(S(a, "name"), S(a, "url"));
            case "artistArt.setData":
            {
                string data = S(a, "data") ?? "";
                int comma = data.IndexOf(',');
                if (comma >= 0 && data.StartsWith("data:")) data = data[(comma + 1)..];
                return _art.SetArtistOverride(S(a, "name"), Convert.FromBase64String(data));
            }
            case "artistArt.clear": _art.ClearArtistOverride(S(a, "name")); return null;
            case "track":
            {
                var t = _lib.GetTrack(S(a, "id"));
                return t == null ? null : new { t.Id, t.Path, t.Title, t.Artist, t.AlbumArtist, t.Album, t.Genre, t.Composer, t.Year, t.TrackNo, t.DiscNo, t.Duration, t.SampleRate, t.Bits, t.Channels, t.Bitrate, t.Codec, t.Size, t.RgTrack, t.RgAlbum };
            }
            case "reveal":
            {
                var t = _lib.GetTrack(S(a, "id"));
                if (t != null) Process.Start("explorer.exe", $"/select,\"{t.Path}\"");
                return null;
            }
            case "autoeq.search": return await AutoEq.Search(S(a, "q"));
            case "autoeq.get": return await AutoEq.Fetch(S(a, "path"), S(a, "name"));
            case "yt.show":
            {
                await EnsureYt();
                double dpr = D(a, "dpr", 1);
                var r = new Rectangle((int)Math.Round(D(a, "x") * dpr), (int)Math.Round(D(a, "y") * dpr), (int)Math.Round(D(a, "w") * dpr), (int)Math.Round(D(a, "h") * dpr));
                _yt.Bounds = r;
                _yt.Visible = true;
                _yt.BringToFront();
                return null;
            }
            case "yt.hide": if (_yt != null) _yt.Visible = false; return null;
            case "yt.nav":
                if (_yt?.CoreWebView2 != null)
                {
                    switch (S(a, "to"))
                    {
                        case "back": if (_yt.CoreWebView2.CanGoBack) _yt.CoreWebView2.GoBack(); break;
                        case "forward": if (_yt.CoreWebView2.CanGoForward) _yt.CoreWebView2.GoForward(); break;
                        case "reload": _yt.CoreWebView2.Reload(); break;
                        case "liked": _yt.CoreWebView2.Navigate("https://music.youtube.com/playlist?list=LM"); break;
                        case "library": _yt.CoreWebView2.Navigate("https://music.youtube.com/library"); break;
                        default: _yt.CoreWebView2.Navigate("https://music.youtube.com/"); break;
                    }
                }
                return null;
            case "devtools": _web.CoreWebView2.OpenDevToolsWindow(); return null;
            case "fullscreen":
                // { on: true | false }, or toggle without it
                SetFullScreen(a.ValueKind == JsonValueKind.Object && a.TryGetProperty("on", out var fsOn) ? fsOn.ValueKind == JsonValueKind.True : !_fullScreen);
                return _fullScreen;
            case "remote.info": return RemoteInfo();
            case "remote.revoke": _remote?.Revoke(S(a, "id")); return RemoteInfo();
            case "quit": BeginInvoke(new Action(Close)); return null;
            case "openUrl": OpenExternal(S(a, "url")); return null;
            case "ui":
                _s.Ui[S(a, "key")] = S(a, "value");
                SaveSoon();
                return null;
        }
        throw new InvalidOperationException("Unknown method " + m);
    }

    object Init() => new
    {
        settings = _s,
        version = Application.ProductVersion,
        ffmpeg = Ffmpeg.Available,
        rplay = RplayIncluded,
        asio = Devices.AsioDrivers(),
        scan = _lib.Progress,
        state = State(),
        queue = QueueDto(),
    };

    object State()
    {
        var meter = _engine.Meter();
        var resampling = _engine.ResamplingMeter();
        var sw = _switching;
        var current = _engine.Track ?? sw?.Track;
        bool playing = _engine.IsPlaying || sw?.Playing == true;
        bool loaded = _engine.IsLoaded || sw != null;
        var signal = _engine.Signal ?? sw?.Signal;
        if (current?.IsLive == true)
        {
            var m = _ytMeta;
            var parts = (m.By ?? "").Split('•', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
            return new
            {
                trackId = "yt-live",
                playing,
                loaded,
                pos = LivePosition(playing),
                dur = m.D,
                index = _player.Index,
                volumeDb = _s.VolumeDb,
                muted = _s.Muted,
                volumeMode = _s.VolumeMode,
                repeat = _s.Repeat,
                shuffle = _s.Shuffle,
                signal,
                live = new { title = m.Title, artist = parts.Length > 0 ? parts[0] : "", album = parts.Length > 1 ? parts[1] : "", img = m.Img },
                liveStats = new { fill = Math.Round(LiveBus.Fill, 3), adj = Math.Round(LiveBus.Adj * 1000, 2), resyncs = LiveBus.Resyncs, starves = LiveBus.Starves, rate = LiveBus.SourceRate, sink = _ytSink, gap = m.Gap },
                meter = new { l = meter.l, r = meter.r, clips = meter.clips, underruns = meter.underruns, resampleOverloads = resampling.overloads, resamplePeak = _engine.ResamplingMeterAvailable ? (double?)resampling.peak : null, resampleMeterAvailable = _engine.ResamplingMeterAvailable },
            };
        }
        var t = current ?? _player.Current;
        return new
        {

            trackId = t?.Id,
            playing,
            loaded,
            pos = sw != null && !_engine.IsLoaded ? sw.Pos : _engine.IsLoaded ? _engine.Position : (_engine.Track == null ? _s.ResumePosition : _engine.Position),
            dur = t?.Duration ?? 0,
            index = _player.Index,
            volumeDb = _s.VolumeDb,
            muted = _s.Muted,
            volumeMode = _s.VolumeMode,
            repeat = _s.Repeat,
            shuffle = _s.Shuffle,
            signal,
            meter = new { l = meter.l, r = meter.r, clips = meter.clips, underruns = meter.underruns, resampleOverloads = resampling.overloads, resamplePeak = _engine.ResamplingMeterAvailable ? (double?)resampling.peak : null, resampleMeterAvailable = _engine.ResamplingMeterAvailable },
        };
    }

    object QueueDto() => new { ids = _player.Queue, index = _player.Index, shuffle = _s.Shuffle, repeat = _s.Repeat };

    object DevicesDto()
    {
        var list = Devices.List();
        object caps = null;
        try
        {
            using var d = Devices.Open(_s.DeviceId);
            caps = CapsDto(Devices.Probe(d));
        }
        catch { }
        return new { devices = list, caps, asio = Devices.AsioDrivers() };
    }

    static object CapsDto(DeviceCaps c) => new
    {
        c.Id, c.Name, c.MixRate, c.MixChannels, c.HardwareVolume, summary = c.Summary(),
        rates = c.Rates.ToList(),
        formats = c.Exclusive.ToDictionary(kv => kv.Key.ToString(), kv => kv.Value.Select(Formats.Describe).ToList()),
    };

    static readonly HashSet<string> OutputKeys = new(StringComparer.OrdinalIgnoreCase) { "outputMode", "deviceId", "asioDriver", "bufferMs", "upsampling", "fixedRate", "dop", "dsdMode", "dsdPcmRate", "replayGain", "replayGainPreamp", "rplayProfile", "rplayMaxDsd" };

    object ApplySettings(JsonElement patch)
    {
        bool reconfigure = false, volume = false, remote = false, core = false;
        foreach (var prop in patch.EnumerateObject())
        {
            var pi = typeof(Settings).GetProperty(prop.Name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            if (pi == null || !pi.CanWrite || pi.Name is nameof(Settings.Queue) or nameof(Settings.Folders) or nameof(Settings.Favorites) or nameof(Settings.Recent) or nameof(Settings.SearchHistory)) continue;
            var value = prop.Value.Deserialize(pi.PropertyType, Json.Options);
            var old = pi.GetValue(_s);
            if (Equals(old, value)) continue;
            pi.SetValue(_s, value);
            if (OutputKeys.Contains(prop.Name)) reconfigure = true;
            if (pi.Name == nameof(Settings.AudioCore)) core = true;
            if (pi.Name == nameof(Settings.VolumeMode)) { volume = true; reconfigure = true; }
            if (pi.Name is nameof(Settings.RemoteEnabled) or nameof(Settings.RemotePort)) remote = true;
            if (pi.Name == nameof(Settings.AutoContinue) && _engine.IsPlaying) _player.EnsureAutoNext();
        }
        SaveSoon();
        if (remote) StartRemote();
        if (core) _ = Task.Run(async () => { try { await SwitchCoreAsync(); } catch (Exception ex) { Log.Error("Switch core", ex); Post("error", new { message = "切換播放內核失敗：" + ex.Message }); } });
        else if (reconfigure) _ = Task.Run(async () => { await _engine.ReconfigureAsync(); PostSoon("state"); });
        else if (volume) _engine.ApplyVolume();
        return _s;
    }
}
