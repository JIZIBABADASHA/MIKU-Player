using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Miku.Audio;

namespace Miku.Library;

/// <summary>
/// 遠端音樂庫 (port of mac/app/main/remote-library.js): the library of MIKU on another computer (home network or
/// Tailscale). This MIKU pairs with that MIKU's phone-remote server once (a 4-digit code shown there), lists its library
/// and covers, and plays its songs with this computer's own engine: a song not in the cache is read by FFmpeg straight
/// from there (it seeks with HTTP ranges), while the next songs of the queue are copied into a cache. DSD, and every
/// song when a module's playback core is chosen, is copied whole first. Whole albums can be kept here (離線下載).
/// </summary>
public sealed class RemoteLibrary : IDisposable
{
    public static RemoteLibrary Instance { get; private set; }

    sealed class FileEntry
    {
        public string File { get; set; }
        public long Size { get; set; }
        public string Q { get; set; }
        public long Used { get; set; }
        public bool Pin { get; set; }
    }

    sealed class Job
    {
        public Task<FileEntry> Task;
        public long Got, Total;
        public volatile string File;   // where it is written (known once the other computer answered)
        public readonly CancellationTokenSource Cts = new();
    }

    record BaseFormat(string Codec, int Rate, int Bits);

    static readonly string Dir = Path.Combine(AppPaths.Root, "Remote");
    static readonly string OfflineDir = Path.Combine(Dir, "Offline");
    static readonly string CacheDir = Path.Combine(Dir, "Cache");
    static readonly string ArtDir = Path.Combine(CacheDir, "Art");
    static readonly string LibFile = Path.Combine(Dir, "library.json");
    static readonly string IndexFile = Path.Combine(Dir, "files.json");
    static readonly HashSet<string> Lossy = new() { "MP3", "AAC", "OGG", "OPUS", "WMA" };
    const string Caps = "mp3,aac,alac,flac,wav,ogg,opus";
    static readonly Dictionary<string, string> ExtOfType = new()
    {
        ["audio/mpeg"] = ".mp3", ["audio/aac"] = ".aac", ["audio/mp4"] = ".m4a", ["audio/flac"] = ".flac", ["audio/wav"] = ".wav", ["audio/ogg"] = ".ogg",
    };
    static readonly HttpClient Http = new(new SocketsHttpHandler { AutomaticDecompression = System.Net.DecompressionMethods.All, PooledConnectionLifetime = TimeSpan.FromMinutes(5) })
    { Timeout = Timeout.InfiniteTimeSpan };

    readonly Settings _s;
    readonly object _lock = new();
    byte[] _raw;
    Dictionary<string, Track> _tracks = new();
    Dictionary<string, Album> _albums = new();
    readonly Dictionary<string, BaseFormat> _base = new();
    Dictionary<string, FileEntry> _files;
    readonly Dictionary<string, Job> _jobs = new();
    readonly Dictionary<string, DateTime> _failed = new();
    readonly Dictionary<string, DateTime> _artMiss = new();
    readonly List<Track> _pre = new();
    bool _preBusy;
    readonly List<Track> _offlineQueue = new();
    bool _offlineBusy;
    int _offlineDone, _offlineTotal;
    CancellationTokenSource _events;
    Timer _saveTimer;

    public bool Online { get; private set; }
    public bool Pairing { get; private set; }
    public string LastError { get; private set; } = "";
    public string PlayingId { get; set; }

    /// <summary>Something shown in the settings changed (status, cache, downloads).</summary>
    public event Action Changed;
    /// <summary>The library the page lists changed (another library fetched, or shown / no longer shown).</summary>
    public event Action LibraryChanged;
    /// <summary>Settings.RemoteLib changed and should be saved.</summary>
    public event Action Save;
    /// <summary>A whole album finished downloading (or stopped).</summary>
    public event Action OfflineDone;

    public RemoteLibrary(Settings s)
    {
        _s = s;
        _s.RemoteLib ??= new RemoteLibSettings();
        Instance = this;
        try { Directory.CreateDirectory(OfflineDir); Directory.CreateDirectory(ArtDir); } catch { }
        _files = Miku.Json.Load<Dictionary<string, FileEntry>>(IndexFile);
        foreach (var id in _files.Keys.ToList())
            if (_files[id]?.File == null || !File.Exists(_files[id].File)) _files.Remove(id);
        try { if (File.Exists(LibFile)) Parse(File.ReadAllBytes(LibFile)); } catch (Exception ex) { Log.Error("Remote library load", ex); }
    }

    RemoteLibSettings Cfg => _s.RemoteLib;
    public bool Paired => !string.IsNullOrEmpty(Cfg.Url) && !string.IsNullOrEmpty(Cfg.Token);
    public bool Active => Paired && Cfg.Active && _raw != null;
    public int JobCount { get { lock (_lock) return _jobs.Count; } }

    // ───────────────────────────── the library ─────────────────────────────

    static string Str(JsonElement a, int i) => a.GetArrayLength() > i && a[i].ValueKind == JsonValueKind.String ? a[i].GetString() ?? "" : "";
    static double Num(JsonElement a, int i) => a.GetArrayLength() > i && a[i].ValueKind == JsonValueKind.Number ? a[i].GetDouble() : 0;

    void Parse(byte[] buf)
    {
        using var doc = JsonDocument.Parse(buf);
        var root = doc.RootElement;
        var albums = new Dictionary<string, Album>();
        var tracks = new Dictionary<string, Track>();
        if (root.TryGetProperty("albums", out var al))
            foreach (var a in al.EnumerateArray())
            {
                // [id, title, artist, year, genre, added, hasLocalArt, loose, versionGroup, folderName]
                var album = new Album { Id = Str(a, 0), Title = Str(a, 1), Artist = Str(a, 2), Year = (int)Num(a, 3), Genre = Str(a, 4), Folder = Str(a, 9) };
                albums[album.Id] = album;
            }
        if (root.TryGetProperty("tracks", out var tr))
            foreach (var r in tr.EnumerateArray())
            {
                // [id, title, artist, albumId, disc, no, duration, codec, rate, bits, year, composer, added, folder]
                string id = Str(r, 0);
                albums.TryGetValue(Str(r, 3), out var album);
                Track t;
                lock (_lock) _tracks.TryGetValue(id, out t);   // one the player holds keeps its object
                t ??= new Track { Id = id };
                t.Title = Str(r, 1); t.Artist = Str(r, 2); t.AlbumId = Str(r, 3); t.DiscNo = Math.Max(1, (int)Num(r, 4)); t.TrackNo = (int)Num(r, 5);
                t.Duration = Num(r, 6); t.Year = (int)Num(r, 10); t.Composer = Str(r, 11);
                t.Album = album?.Title ?? ""; t.AlbumArtist = album?.Artist ?? ""; t.Genre = album?.Genre ?? "";
                var b = new BaseFormat(Str(r, 7), (int)Num(r, 8), (int)Num(r, 9));
                lock (_lock) _base[id] = b;
                if (string.IsNullOrEmpty(t.Path)) { t.Codec = b.Codec; t.SampleRate = b.Rate; t.Bits = b.Bits; t.Channels = 2; }
                tracks[id] = t;
                album?.Tracks.Add(t);
            }
        lock (_lock) { _raw = buf; _albums = albums; _tracks = tracks; }
    }

    public Track GetTrack(string id) { if (id == null) return null; lock (_lock) return _tracks.TryGetValue(id, out var t) ? t : null; }
    public Album GetAlbum(string id) { if (id == null) return null; lock (_lock) return _albums.TryGetValue(id, out var a) ? a : null; }
    public bool IsRemote(Track t) { if (t?.Id == null) return false; lock (_lock) return _tracks.TryGetValue(t.Id, out var x) && ReferenceEquals(x, t); }

    /// <summary>The library.json the page reads while the other computer's library is shown.</summary>
    public byte[] LibraryJson() { lock (_lock) return _raw; }

    // ───────────────────────────── talking to the other MIKU ─────────────────────────────

    string Url(string p) => Cfg.Url.TrimEnd('/') + p;

    async Task<HttpResponseMessage> Req(string p, HttpMethod method = null, object body = null, int ms = 15000, CancellationToken ct = default, bool headersOnly = false)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(ms);
        var req = new HttpRequestMessage(method ?? HttpMethod.Get, Url(p));
        if (!string.IsNullOrEmpty(Cfg.Token)) req.Headers.Add("X-Miku-Token", Cfg.Token);
        if (body != null) req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        try
        {
            var res = await Http.SendAsync(req, headersOnly ? HttpCompletionOption.ResponseHeadersRead : HttpCompletionOption.ResponseContentRead, timeout.Token);
            if ((int)res.StatusCode == 401 && !string.IsNullOrEmpty(Cfg.Token) && !p.StartsWith("/api/pair")) Unauthorized();
            return res;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new IOException("連不上遠端電腦（逾時）"); }
        catch (HttpRequestException ex) { throw new IOException("連不上遠端電腦：" + (ex.InnerException?.Message ?? ex.Message)); }
    }

    void Unauthorized()
    {
        Cfg.Token = ""; Cfg.Active = false; LastError = "另一台電腦的 MIKU 已取消這台電腦的配對，請重新配對。";
        StopEvents(); Changed?.Invoke(); LibraryChanged?.Invoke(); Save?.Invoke();
    }

    static string Normalize(string u)
    {
        u = (u ?? "").Trim();
        if (u == "") throw new InvalidOperationException("請輸入另一台 MIKU 的網址");
        if (!u.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !u.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) u = "http://" + u;
        if (!Uri.TryCreate(u, UriKind.Absolute, out var x)) throw new InvalidOperationException("網址格式不正確");
        int port = x.IsDefaultPort && !u.Contains(":" + x.Port) ? 8765 : x.Port;
        return $"{x.Scheme}://{x.Host}:{port}";
    }

    static string DeviceName() => (Environment.MachineName.Length > 30 ? Environment.MachineName[..30] : Environment.MachineName) + " 的 MIKU";

    static async Task<string> ErrorOf(HttpResponseMessage r, string fallback)
    {
        try { using var d = JsonDocument.Parse(await r.Content.ReadAsStringAsync()); if (d.RootElement.TryGetProperty("e", out var e) && e.GetString() is { Length: > 0 } s) return s; } catch { }
        return fallback;
    }

    /// <summary>Step 1: the other MIKU shows a pairing code.</summary>
    public async Task PairStart(string u)
    {
        string url = Normalize(u), old = Cfg.Url;
        Cfg.Url = url; Cfg.Token = "";
        try
        {
            using (var ping = await Req("/api/ping", ms: 8000))
            {
                bool miku = false;
                try { using var d = JsonDocument.Parse(await ping.Content.ReadAsStringAsync()); miku = d.RootElement.TryGetProperty("app", out var a) && a.GetString() == "MIKU"; } catch { }
                if (!miku) throw new InvalidOperationException("這個網址不是 MIKU，請確認網址和連接埠");
            }
            using var r = await Req("/api/pair/request", HttpMethod.Post, new { name = DeviceName() }, 8000);
            if (!r.IsSuccessStatusCode) throw new InvalidOperationException(await ErrorOf(r, $"配對要求失敗（{(int)r.StatusCode}）"));
            Pairing = true; LastError = "";
            Save?.Invoke(); Changed?.Invoke();
        }
        catch { if (string.IsNullOrEmpty(Cfg.Token)) Cfg.Url = string.IsNullOrEmpty(old) ? url : old; throw; }
    }

    /// <summary>Step 2: the code read off the other computer's screen.</summary>
    public async Task PairConfirm(string code)
    {
        string token = null;
        using (var r = await Req("/api/pair/confirm", HttpMethod.Post, new { code = (code ?? "").Trim(), name = DeviceName() }, 8000))
        {
            if (!r.IsSuccessStatusCode) throw new InvalidOperationException(await ErrorOf(r, "配對失敗"));
            try { using var d = JsonDocument.Parse(await r.Content.ReadAsStringAsync()); token = d.RootElement.GetProperty("token").GetString(); } catch { }
        }
        if (string.IsNullOrEmpty(token)) throw new InvalidOperationException("配對失敗");
        Cfg.Token = token; Cfg.Active = true; Pairing = false; LastError = "";
        Save?.Invoke();
        await Refresh();
    }

    public void Unpair()
    {
        StopEvents();
        Cfg.Token = ""; Cfg.Active = false;
        Pairing = false; Online = false;
        Save?.Invoke(); Changed?.Invoke(); LibraryChanged?.Invoke();
    }

    public void SetActive(bool on)
    {
        Cfg.Active = on && Paired;
        Save?.Invoke(); LibraryChanged?.Invoke(); Changed?.Invoke();
        if (Cfg.Active) { _ = Refresh(); StartEvents(); } else StopEvents();
    }

    /// <summary>Fetches the other computer's library.json (kept on disk: listed without a connection too).</summary>
    public async Task<bool> Refresh()
    {
        if (!Paired) return false;
        try
        {
            byte[] buf;
            using (var r = await Req("/media/library.json", ms: 60000))
            {
                if (!r.IsSuccessStatusCode) throw new IOException($"讀取音樂庫失敗（{(int)r.StatusCode}）");
                buf = await r.Content.ReadAsByteArrayAsync();
            }
            bool same; lock (_lock) same = _raw != null && _raw.AsSpan().SequenceEqual(buf);
            if (!same)
            {
                Parse(buf);
                Directory.CreateDirectory(Dir);
                File.WriteAllBytes(LibFile + ".tmp", buf);
                File.Move(LibFile + ".tmp", LibFile, true);
            }
            Online = true; LastError = "";
            Changed?.Invoke();
            if (!same && Cfg.Active) LibraryChanged?.Invoke();
            if (Cfg.Active) StartEvents();
            return true;
        }
        catch (Exception ex)
        {
            Online = false; LastError = ex.Message;
            Log.Error("Remote library refresh", ex);
            Changed?.Invoke();
            return false;
        }
    }

    /// <summary>The other MIKU's events: its library changed (fetch it again), and whether it can be reached.</summary>
    public void StartEvents()
    {
        if (_events != null || !Paired) return;
        var cts = _events = new CancellationTokenSource();
        _ = Task.Run(async () =>
        {
            int wait = 3000;
            while (!cts.IsCancellationRequested && Paired)
            {
                try
                {
                    var req = new HttpRequestMessage(HttpMethod.Get, Url("/api/events"));
                    req.Headers.Add("X-Miku-Token", Cfg.Token);
                    req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
                    using var res = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
                    if ((int)res.StatusCode == 401) { Unauthorized(); break; }
                    res.EnsureSuccessStatusCode();
                    if (!Online) { Online = true; LastError = ""; Changed?.Invoke(); _ = Refresh(); }
                    wait = 3000;
                    using var stream = await res.Content.ReadAsStreamAsync(cts.Token);
                    using var reader = new StreamReader(stream, Encoding.UTF8);
                    CancellationTokenSource debounce = null;
                    while (!cts.IsCancellationRequested)
                    {
                        // the server sends a keep-alive every 15 s: nothing for a minute means the connection is gone
                        var lineTask = reader.ReadLineAsync(cts.Token).AsTask();
                        if (await Task.WhenAny(lineTask, Task.Delay(60000, cts.Token)) != lineTask) break;
                        string line = await lineTask;
                        if (line == null) break;
                        if (!line.StartsWith("data: ") || !line.Contains("\"ev\":\"library\"")) continue;
                        debounce?.Cancel();
                        var d = debounce = new CancellationTokenSource();
                        _ = Task.Delay(2500, d.Token).ContinueWith(t => { if (!t.IsCanceled) _ = Refresh(); }, TaskScheduler.Default);
                    }
                }
                catch { }
                if (cts.IsCancellationRequested) break;
                if (Online) { Online = false; Changed?.Invoke(); }
                try { await Task.Delay(wait, cts.Token); } catch { break; }
                wait = Math.Min(wait * 2, 60000);
            }
        });
    }

    void StopEvents() { try { _events?.Cancel(); } catch { } _events = null; }

    // ───────────────────────────── covers ─────────────────────────────

    /// <summary>A cover from the other MIKU (/art/a/…, /art/t/…, /art/r/…), cached on disk; null when it has none or is out of reach.</summary>
    public async Task<byte[]> Art(string p, int size)
    {
        string file = Path.Combine(ArtDir, Miku.Text.Hash(p + "@" + size) + ".jpg");
        try { if (File.Exists(file)) return await File.ReadAllBytesAsync(file); } catch { }
        if (!Paired) return null;
        lock (_lock) if (_artMiss.TryGetValue(file, out var miss) && DateTime.UtcNow - miss < TimeSpan.FromMinutes(10)) return null;
        try
        {
            using var r = await Req("/media" + p + "?s=" + size, ms: 20000);
            if (!r.IsSuccessStatusCode) { lock (_lock) _artMiss[file] = DateTime.UtcNow; return null; }
            var buf = await r.Content.ReadAsByteArrayAsync();
            try { Directory.CreateDirectory(ArtDir); await File.WriteAllBytesAsync(file, buf); } catch { }
            return buf;
        }
        catch { lock (_lock) _artMiss[file] = DateTime.UtcNow; return null; }
    }

    // ───────────────────────────── songs ─────────────────────────────

    BaseFormat Base(Track t) { lock (_lock) return _base.TryGetValue(t.Id, out var b) ? b : new BaseFormat(t.Codec, t.SampleRate, t.Bits); }

    /// <summary>The quality a track is fetched in: lossy files always as they are.</summary>
    string Quality(Track t) { string q = string.IsNullOrEmpty(Cfg.Quality) ? "orig" : Cfg.Quality; return q == "orig" || Lossy.Contains(Base(t).Codec) ? "orig" : q; }

    FileEntry Cached(Track t)
    {
        lock (_lock)
        {
            if (!_files.TryGetValue(t.Id, out var f)) return null;
            if (!File.Exists(f.File)) { _files.Remove(t.Id); return null; }
            return f.Q == "orig" || f.Pin || f.Q == Quality(t) ? f : null;
        }
    }

    void Bind(Track t, FileEntry f)
    {
        t.Path = f.File;
        var b = Base(t);
        if (f.Q == "orig") { t.Codec = b.Codec; t.SampleRate = b.Rate; t.Bits = b.Bits; }
        else { t.Codec = f.File.EndsWith(".aac", StringComparison.OrdinalIgnoreCase) ? "AAC" : "MP3"; t.Bits = 0; t.SampleRate = Formats.Family(b.Rate > 0 ? b.Rate : 44100); }
        t.Channels = 2;
        f.Used = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    string StreamUrl(Track t)
    {
        string q = Quality(t);
        return Url("/stream/" + Uri.EscapeDataString(t.Id) + "?" + (q == "orig" ? "raw=1" : $"q={q}&c={Caps}") + "&t=" + Uri.EscapeDataString(Cfg.Token));
    }

    /// <summary>Streamed straight from the other computer: MIKU's own core, a PCM format (DSD is read from a file).</summary>
    bool CanStream(Track t) => (_s.AudioCore ?? "miku") == "miku" && (Quality(t) != "orig" || !(Base(t).Codec is "DSF" or "DFF"));

    void BindStream(Track t)
    {
        t.Path = StreamUrl(t);
        var b = Base(t);
        if (Quality(t) == "orig") { t.Codec = b.Codec; t.SampleRate = b.Rate; t.Bits = b.Bits; }
        else { t.Codec = "MP3"; t.Bits = 0; t.SampleRate = Formats.Family(b.Rate > 0 ? b.Rate : 44100); }
        t.Channels = 2;
    }

    /// <summary>Ready to play now (also gapless): in the cache, or streamed while the other computer can be reached.</summary>
    public bool IsReady(Track t)
    {
        var f = Cached(t);
        if (f != null) { Bind(t, f); return true; }
        if (Paired && Online && CanStream(t)) { BindStream(t); Prefetch(new[] { t }); return true; }
        if (Paired) Prefetch(new[] { t });
        return false;
    }

    /// <summary>Before a song of the other computer plays: from the cache, streamed, or (DSD, a module's core) copied first.</summary>
    public async Task Prepare(Track t, IEnumerable<Track> next)
    {
        PlayingId = t.Id;
        var f = Cached(t);
        if (f != null) Bind(t, f);
        else
        {
            if (!Paired) throw new InvalidOperationException("還沒有和遠端電腦配對");
            if (!Online)
            {
                try { using var r = await Req("/api/ping", ms: 4000); if (!r.IsSuccessStatusCode) throw new IOException(); Online = true; Changed?.Invoke(); }
                catch { throw new InvalidOperationException("連不上遠端電腦，這首歌還沒下載到這台電腦"); }
            }
            if (CanStream(t)) BindStream(t);
            else if ((_s.AudioCore ?? "miku") == "miku") await PlayWhileCopying(t);
            else Bind(t, await Fetch(t, true));   // a module's core reads the file itself: the whole file first
        }
        SaveIndex();
        Prefetch(next.Where(n => n != null && IsRemote(n)));
    }

    /// <summary>
    /// DSD on MIKU's own core (its header and DoP data are read from a file): copied into the cache, and played from
    /// that file as it grows (GrowingFiles) once its first part is there.
    /// </summary>
    async Task PlayWhileCopying(Track t)
    {
        Job job;
        var task = Fetch(t, true, "orig");
        lock (_lock) _jobs.TryGetValue(t.Id + "|orig", out job);
        var until = DateTime.UtcNow.AddSeconds(60);
        while (!task.IsCompleted)
        {
            if (job != null && job.File != null && job.Total > 0 && Interlocked.Read(ref job.Got) >= Math.Min(job.Total, 1 << 20)) break;
            if (DateTime.UtcNow > until) throw new IOException("遠端電腦回應太慢");
            await Task.Delay(50);
        }
        if (task.IsCompleted) { Bind(t, await task); return; }
        t.Path = job.File;
        var b = Base(t);
        t.Codec = b.Codec; t.SampleRate = b.Rate; t.Bits = b.Bits; t.Channels = 2;
    }

    /// <summary>Copies the given songs into the cache one after another (the song playing keeps most of the connection).</summary>
    public void Prefetch(IEnumerable<Track> list)
    {
        lock (_lock)
        {
            var add = list.Where(n => !_pre.Contains(n)).ToList();
            _pre.InsertRange(0, add);
            if (_pre.Count > 4) _pre.RemoveRange(4, _pre.Count - 4);
            if (_preBusy) return;
            _preBusy = true;
        }
        _ = Task.Run(async () =>
        {
            try
            {
                while (true)
                {
                    Track n;
                    lock (_lock) { if (_pre.Count == 0) break; n = _pre[0]; _pre.RemoveAt(0); }
                    if (Cached(n) == null) { try { await Fetch(n, false); } catch { } }
                }
            }
            finally { lock (_lock) _preBusy = false; }
        });
    }

    /// <summary>Copies one track into the cache; several asks for the same track share one copy. q: orig or the kbps.</summary>
    Task<FileEntry> Fetch(Track t, bool now, string q = null)
    {
        q ??= Quality(t);
        string key = t.Id + "|" + q;
        lock (_lock)
        {
            if (_jobs.TryGetValue(key, out var running)) return running.Task;
            if (!Paired) return Task.FromException<FileEntry>(new InvalidOperationException("還沒有和遠端電腦配對"));
            // a song that just failed (no connection) is not asked for again at once by the look-ahead
            if (!now && _failed.TryGetValue(key, out var at) && DateTime.UtcNow - at < TimeSpan.FromMinutes(1))
                return Task.FromException<FileEntry>(new IOException("稍後再試"));
            var job = new Job();
            job.Task = Task.Run(() => Download(t, q, now, job));
            _jobs[key] = job;
            job.Task.ContinueWith(x =>
            {
                lock (_lock) { _jobs.Remove(key); if (x.IsFaulted) _failed[key] = DateTime.UtcNow; }
                if (x.IsFaulted) Log.Error("Remote fetch " + t.Id, x.Exception?.InnerException ?? x.Exception);
                Changed?.Invoke();
            }, TaskScheduler.Default);
            return job.Task;
        }
    }

    async Task<FileEntry> Download(Track t, string q, bool now, Job job)
    {
        Directory.CreateDirectory(CacheDir);
        string qs = q == "orig" ? "raw=1" : $"q={q}&c={Caps}";
        HttpResponseMessage res = null;
        for (int attempt = 0; ; attempt++)
        {
            res?.Dispose();
            res = await Req("/stream/" + Uri.EscapeDataString(t.Id) + "?" + qs, ms: now ? 20000 : 60000, ct: job.Cts.Token, headersOnly: true);
            if ((int)res.StatusCode == 503 && attempt < 5) { await Task.Delay(2000, job.Cts.Token); continue; }   // the other computer is encoding several songs
            break;
        }
        using (res)
        {
            if ((int)res.StatusCode == 404) throw new FileNotFoundException("遠端電腦上找不到這首歌（檔案可能已移動或刪除）");
            if ((int)res.StatusCode == 415) throw new IOException(await res.Content.ReadAsStringAsync());
            if (!res.IsSuccessStatusCode) throw new IOException($"下載失敗（{(int)res.StatusCode}）");
            string ext = res.Headers.TryGetValues("X-Miku-Ext", out var xe) ? xe.FirstOrDefault() : null;
            if (string.IsNullOrEmpty(ext)) ExtOfType.TryGetValue(res.Content.Headers.ContentType?.MediaType ?? "", out ext);
            ext = new string((ext ?? ".bin").Where(c => c == '.' || char.IsLetterOrDigit(c)).ToArray());
            job.Total = res.Content.Headers.ContentLength ?? 0;
            string safe = new string(t.Id.Where(c => char.IsLetterOrDigit(c) || c == '-').ToArray());
            string file = Path.Combine(CacheDir, safe + (q == "orig" ? "" : "-" + q) + ext);
            // written in place, readable meanwhile: a song can play from it while it comes (PlayWhileCopying); it is
            // in the cache's index only once complete
            if (job.Total > 0) GrowingFiles.Start(file, job.Total);
            job.File = file;
            try
            {
                using var src = await res.Content.ReadAsStreamAsync(job.Cts.Token);
                using (var dst = new FileStream(file, FileMode.Create, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete, 1 << 16, true))
                {
                    var buf = new byte[1 << 16];
                    while (true)
                    {
                        // a stalled connection (the other computer went to sleep) must not hang forever
                        using var stall = CancellationTokenSource.CreateLinkedTokenSource(job.Cts.Token);
                        stall.CancelAfter(30000);
                        int n;
                        try { n = await src.ReadAsync(buf, stall.Token); }
                        catch (OperationCanceledException) when (!job.Cts.IsCancellationRequested) { throw new IOException("下載中斷：遠端電腦沒有回應"); }
                        if (n <= 0) break;
                        await dst.WriteAsync(buf.AsMemory(0, n), job.Cts.Token);
                        await dst.FlushAsync(job.Cts.Token);
                        GrowingFiles.Progress(file, Interlocked.Add(ref job.Got, n));
                    }
                }
                if (job.Total > 0 && job.Got < job.Total) throw new IOException("下載不完整，請再試一次");
            }
            catch { GrowingFiles.End(file); try { File.Delete(file); } catch { } throw; }
            GrowingFiles.End(file);
            FileEntry f;
            lock (_lock)
            {
                _files.TryGetValue(t.Id, out var old);
                // a song kept offline stays as it is (the copy just made is not needed)
                if (old != null && old.Pin && old.File != file) { try { File.Delete(file); } catch { } return old; }
                if (old != null && old.File != file) { try { File.Delete(old.File); } catch { } }
                f = _files[t.Id] = new FileEntry { File = file, Size = job.Got, Q = q, Used = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
            }
            SaveIndex();
            Trim();
            return f;
        }
    }

    /// <summary>How far a song being copied has come.</summary>
    public (long got, long total)? Progress(string id)
    {
        lock (_lock)
            foreach (var (k, j) in _jobs)
                if (k.StartsWith(id + "|")) return (Interlocked.Read(ref j.Got), j.Total);
        return null;
    }

    void SaveIndex()
    {
        lock (_lock)
        {
            _saveTimer?.Dispose();
            _saveTimer = new Timer(_ => { try { Dictionary<string, FileEntry> copy; lock (_lock) copy = new(_files); Directory.CreateDirectory(Dir); Miku.Json.SaveAtomic(IndexFile, copy); } catch (Exception ex) { Log.Error("Remote index", ex); } }, null, 1000, Timeout.Infinite);
        }
    }

    /// <summary>Keeps the cache of played songs under its size (oldest first; offline albums and the playing song stay).</summary>
    public void Trim()
    {
        long limit = (long)(Math.Max(0.5, Cfg.CacheGB) * 1024 * 1024 * 1024);
        lock (_lock)
        {
            var list = _files.Where(x => !x.Value.Pin).OrderBy(x => x.Value.Used).ToList();
            long total = list.Sum(x => x.Value.Size);
            foreach (var (id, f) in list)
            {
                if (total <= limit) break;
                if (id == PlayingId) continue;
                try { File.Delete(f.File); } catch { }
                total -= f.Size;
                _files.Remove(id);
            }
        }
        SaveIndex();
    }

    public void ClearCache()
    {
        lock (_lock)
            foreach (var (id, f) in _files.ToList())
            {
                if (f.Pin || id == PlayingId) continue;
                try { File.Delete(f.File); } catch { }
                _files.Remove(id);
            }
        try { foreach (var f in Directory.GetFiles(ArtDir)) File.Delete(f); } catch { }
        SaveIndex(); Changed?.Invoke();
    }

    // ───────────────────────────── offline albums ─────────────────────────────

    void Pin(string id)
    {
        lock (_lock)
        {
            if (!_files.TryGetValue(id, out var f) || f.Pin) return;
            string dest = Path.Combine(OfflineDir, Path.GetFileName(f.File));
            try { File.Move(f.File, dest, true); f.File = dest; f.Pin = true; }
            catch (Exception ex) { Log.Error("Remote pin", ex); }
        }
        SaveIndex();
    }

    /// <summary>Keeps a whole album on this computer (originals), one song at a time in the background.</summary>
    public int DownloadAlbum(string id)
    {
        var al = GetAlbum(id) ?? throw new InvalidOperationException("找不到這張專輯");
        var todo = new List<Track>();
        foreach (var t in al.Tracks)
        {
            FileEntry f; lock (_lock) _files.TryGetValue(t.Id, out f);
            if (f != null && f.Pin) continue;
            // a song already cached as the original moves to the offline folder instead of being copied again
            if (f != null && f.Q == "orig" && File.Exists(f.File)) { Pin(t.Id); continue; }
            lock (_lock) if (!_offlineQueue.Contains(t)) todo.Add(t);
        }
        lock (_lock) { _offlineQueue.AddRange(todo); _offlineTotal += todo.Count; }
        SaveIndex();
        RunOffline();
        Changed?.Invoke();
        return todo.Count;
    }

    void RunOffline()
    {
        lock (_lock) { if (_offlineBusy) return; _offlineBusy = true; }
        _ = Task.Run(async () =>
        {
            try
            {
                while (true)
                {
                    Track t;
                    lock (_lock) { if (_offlineQueue.Count == 0) break; t = _offlineQueue[0]; }
                    try { await Fetch(t, true, "orig"); Pin(t.Id); lock (_lock) _offlineDone++; }
                    catch (Exception ex)
                    {
                        LastError = $"「{t.Title}」下載失敗：{ex.Message}";
                        if (!Online && ex is IOException) { lock (_lock) _offlineQueue.Clear(); break; }
                    }
                    lock (_lock) if (_offlineQueue.Count > 0 && _offlineQueue[0] == t) _offlineQueue.RemoveAt(0);
                    Changed?.Invoke();
                }
            }
            finally
            {
                lock (_lock) { _offlineBusy = false; _offlineDone = 0; _offlineTotal = 0; }
                Changed?.Invoke(); OfflineDone?.Invoke();
            }
        });
    }

    public void RemoveAlbum(string id)
    {
        var al = GetAlbum(id);
        var ids = new HashSet<string>(al?.Tracks.Select(t => t.Id) ?? Enumerable.Empty<string>());
        lock (_lock)
        {
            _offlineQueue.RemoveAll(t => ids.Contains(t.Id));
            foreach (var tid in ids)
            {
                if (!_files.TryGetValue(tid, out var f) || !f.Pin) continue;
                if (tid == PlayingId) { f.Pin = false; continue; }
                try { File.Delete(f.File); } catch { }
                _files.Remove(tid);
            }
        }
        SaveIndex(); Changed?.Invoke();
    }

    // ───────────────────────────── for the page ─────────────────────────────

    public object Info(Track current, bool currentLoaded)
    {
        lock (_lock)
        {
            long cache = 0, offline = 0;
            var offAlbums = new Dictionary<string, (string title, string artist, int have, long bytes)>();
            foreach (var (id, f) in _files)
            {
                if (!f.Pin) { cache += f.Size; continue; }
                offline += f.Size;
                if (_tracks.TryGetValue(id, out var t) && t.AlbumId != null)
                {
                    offAlbums.TryGetValue(t.AlbumId, out var a);
                    offAlbums[t.AlbumId] = (t.Album, t.AlbumArtist, a.have + 1, a.bytes + f.Size);
                }
            }
            object loading = null;
            if (current != null && !currentLoaded && _tracks.ContainsKey(current.Id))
                foreach (var (k, j) in _jobs)
                    if (k.StartsWith(current.Id + "|")) { loading = new { id = current.Id, title = current.Title, got = Interlocked.Read(ref j.Got), total = j.Total }; break; }
            return new
            {
                url = Cfg.Url, paired = Paired, pairing = Pairing, active = Active, online = Online, error = LastError,
                albums = _albums.Count, tracks = _tracks.Count, quality = string.IsNullOrEmpty(Cfg.Quality) ? "orig" : Cfg.Quality, cacheGB = Cfg.CacheGB,
                cacheBytes = cache, offlineBytes = offline,
                offline = offAlbums.Select(x => new { id = x.Key, title = x.Value.title, artist = x.Value.artist, have = x.Value.have, bytes = x.Value.bytes,
                    count = _albums.TryGetValue(x.Key, out var al) ? al.Tracks.Count : x.Value.have }).OrderBy(x => x.title, StringComparer.CurrentCulture).ToList(),
                offlineIds = _files.Where(x => x.Value.Pin).Select(x => x.Key).ToList(),
                downloading = _offlineQueue.Count > 0 ? new { done = _offlineDone, total = _offlineTotal, title = _offlineQueue[0].Title } : null,
                loading,
            };
        }
    }

    public void SetQuality(string q) { if (q is "orig" or "320" or "192" or "128") Cfg.Quality = q; Save?.Invoke(); Changed?.Invoke(); }
    public void SetCacheGB(double gb) { Cfg.CacheGB = Math.Clamp(gb, 1, 500); Save?.Invoke(); Trim(); Changed?.Invoke(); }

    public void Dispose()
    {
        StopEvents();
        lock (_lock) foreach (var j in _jobs.Values) try { j.Cts.Cancel(); } catch { }
        try { Dictionary<string, FileEntry> copy; lock (_lock) copy = new(_files); Miku.Json.SaveAtomic(IndexFile, copy); } catch { }
    }
}
