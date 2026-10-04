using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Miku.Audio;

namespace Miku.Library;

/// <summary>
/// Recognising tracks by their sound (tag editor 「聲紋辨識」): a Chromaprint fingerprint of the first two minutes
/// (FFmpeg decodes, fpcalc fingerprints) looked up at AcoustID, which answers with MusicBrainz recordings and the
/// releases (album, disc, track number) they are on. fpcalc is downloaded once into the profile folder.
/// Fingerprints are kept (fingerprints.json) as long as the file doesn't change.
/// </summary>
public sealed class FingerprintService
{
    const string FpcalcZip = "https://github.com/acoustid/chromaprint/releases/download/v1.5.1/chromaprint-fpcalc-1.5.1-windows-x86_64.zip";
    const string FpcalcZipSha256 = "36b478e16aa69f757f376645db0d436073a42c0097b6bb2677109e7835b59bbc";
    static readonly string ToolsDir = Path.Combine(AppPaths.Root, "tools");
    static readonly string CacheFile = Path.Combine(AppPaths.Root, "fingerprints.json");

    readonly Settings _s;
    readonly ConcurrentDictionary<string, CachedPrint> _cache;
    readonly SemaphoreSlim _download = new(1, 1);
    readonly ConcurrentDictionary<string, JsonElement> _lookups = new();
    int _dirty;

    public sealed class CachedPrint
    {
        public string Fp { get; set; }
        public long Size { get; set; }
        public long Mtime { get; set; }
    }

    public FingerprintService(Settings s)
    {
        _s = s;
        _cache = new ConcurrentDictionary<string, CachedPrint>(Json.Load<Dictionary<string, CachedPrint>>(CacheFile), StringComparer.OrdinalIgnoreCase);
    }

    public bool HasKey => !string.IsNullOrWhiteSpace(_s.AcoustIdKey);

    public static string FpcalcPath
    {
        get
        {
            foreach (var p in new[] { Path.Combine(AppPaths.AppDir, "fpcalc.exe"), Path.Combine(AppPaths.AppDir, "tools", "fpcalc.exe"), Path.Combine(ToolsDir, "fpcalc.exe") })
                if (File.Exists(p)) return p;
            return null;
        }
    }

    /// <summary>fpcalc from the Chromaprint release (about 1.5 MB), checked against its known hash.</summary>
    public async Task EnsureFpcalc()
    {
        if (FpcalcPath != null) return;
        await _download.WaitAsync();
        try
        {
            if (FpcalcPath != null) return;
            byte[] zip;
            try { zip = await Net.Http.GetByteArrayAsync(FpcalcZip); }
            catch (Exception ex) { throw new InvalidOperationException("無法下載聲紋元件 fpcalc：" + ex.Message); }
            if (Convert.ToHexString(SHA256.HashData(zip)).ToLowerInvariant() != FpcalcZipSha256) throw new InvalidOperationException("下載的聲紋元件不正確，請稍後再試");
            using var za = new ZipArchive(new MemoryStream(zip));
            var entry = za.Entries.FirstOrDefault(e => e.Name.Equals("fpcalc.exe", StringComparison.OrdinalIgnoreCase)) ?? throw new InvalidOperationException("下載的檔案裡沒有 fpcalc.exe");
            Directory.CreateDirectory(ToolsDir);
            string tmp = Path.Combine(ToolsDir, "fpcalc.exe.tmp");
            using (var src = entry.Open()) using (var dst = File.Create(tmp)) await src.CopyToAsync(dst);
            File.Move(tmp, Path.Combine(ToolsDir, "fpcalc.exe"), true);
            Log.Info("fpcalc downloaded");
        }
        finally { _download.Release(); }
    }

    /// <summary>The fingerprint of the first two minutes (cached while the file is unchanged).</summary>
    public async Task<string> Fingerprint(Track t, CancellationToken ct)
    {
        var fi = new FileInfo(t.Path);
        if (!fi.Exists) throw new FileNotFoundException("找不到檔案");
        if (_cache.TryGetValue(t.Path, out var c) && c.Size == fi.Length && c.Mtime == fi.LastWriteTimeUtc.Ticks && !string.IsNullOrEmpty(c.Fp)) return c.Fp;
        string fpcalc = FpcalcPath ?? throw new InvalidOperationException("缺少聲紋元件 fpcalc");
        if (!Ffmpeg.Available) throw new InvalidOperationException("找不到 FFmpeg");
        // FFmpeg decodes every format MIKU plays (DSD, APE…) to 44.1 kHz 16-bit stereo; fpcalc reads it from a pipe.
        // The same fingerprint as fpcalc reading the file itself.
        using var dec = Ffmpeg.Start(new[] { "-nostdin", "-hide_banner", "-loglevel", "error", "-i", t.Path, "-map", "0:a:0", "-t", "120", "-ac", "2", "-ar", "44100", "-f", "s16le", "pipe:1" })
            ?? throw new InvalidOperationException("無法啟動 FFmpeg");
        var psi = new ProcessStartInfo(fpcalc) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in new[] { "-json", "-format", "s16le", "-rate", "44100", "-channels", "2", "-length", "120", "-" }) psi.ArgumentList.Add(arg);
        using var fp = Process.Start(psi) ?? throw new InvalidOperationException("無法啟動 fpcalc");
        using var reg = ct.Register(() => { try { dec.Kill(); } catch { } try { fp.Kill(); } catch { } });
        var output = fp.StandardOutput.ReadToEndAsync();
        _ = dec.StandardError.ReadToEndAsync();
        _ = fp.StandardError.ReadToEndAsync();
        try { await dec.StandardOutput.BaseStream.CopyToAsync(fp.StandardInput.BaseStream, 1 << 16, ct); }
        catch (IOException) { }   // fpcalc stops reading after 120 s of audio
        try { fp.StandardInput.Close(); } catch { }
        string json = await output;
        await fp.WaitForExitAsync(ct);
        try { if (!dec.HasExited) dec.Kill(); } catch { }
        ct.ThrowIfCancellationRequested();
        string print = null;
        try { using var doc = JsonDocument.Parse(json); print = doc.RootElement.TryGetProperty("fingerprint", out var f) ? f.GetString() : null; } catch { }
        if (string.IsNullOrEmpty(print)) throw new InvalidOperationException("無法分析這個檔案的音訊");
        _cache[t.Path] = new CachedPrint { Fp = print, Size = fi.Length, Mtime = fi.LastWriteTimeUtc.Ticks };
        Interlocked.Exchange(ref _dirty, 1);
        return print;
    }

    public void SaveCache()
    {
        if (Interlocked.Exchange(ref _dirty, 0) == 0) return;
        try
        {
            // only files that still exist
            var keep = _cache.Where(kv => File.Exists(kv.Key)).ToDictionary(kv => kv.Key, kv => kv.Value);
            Json.SaveAtomic(CacheFile, keep);
        }
        catch (Exception ex) { Log.Error("Save fingerprints", ex); }
    }

    /// <summary>AcoustID lookup: results with MusicBrainz recordings, their releases and track positions.</summary>
    public async Task<JsonElement> Lookup(string fingerprint, double duration, CancellationToken ct)
    {
        string key = fingerprint + "|" + (int)Math.Round(duration);
        if (_lookups.TryGetValue(key, out var hit)) return hit;
        await RateGate.AcoustId.WaitAsync(true, ct);
        using var body = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client"] = _s.AcoustIdKey?.Trim() ?? "",
            ["format"] = "json",
            ["duration"] = ((int)Math.Round(duration)).ToString(),
            ["fingerprint"] = fingerprint,
            ["meta"] = "recordings releases tracks",
        });
        using var res = await Net.Http.PostAsync("https://api.acoustid.org/v2/lookup", body, ct);
        string text = await res.Content.ReadAsStringAsync(ct);
        JsonElement root;
        try { using var doc = JsonDocument.Parse(text); root = doc.RootElement.Clone(); }
        catch { throw new InvalidOperationException($"AcoustID 沒有回應（HTTP {(int)res.StatusCode}）"); }
        if (root.TryGetProperty("status", out var st) && st.GetString() != "ok")
        {
            string msg = root.TryGetProperty("error", out var err) && err.TryGetProperty("message", out var m) ? m.GetString() : "未知錯誤";
            int code = root.TryGetProperty("error", out var err2) && err2.TryGetProperty("code", out var cd) && cd.TryGetInt32(out var n) ? n : 0;
            throw new InvalidOperationException(code == 4 ? "AcoustID 金鑰無效，請到設定確認" : "AcoustID：" + msg);
        }
        _lookups[key] = root;
        return root;
    }

    // ───────────────────────────── one album ─────────────────────────────

    public sealed class TrackMatch
    {
        public string Id { get; set; }
        public string Status { get; set; }        // ok | none | error
        public string Error { get; set; }
        public double Score { get; set; }
        public string Recording { get; set; }
        public string Title { get; set; }
        public string Artist { get; set; }
        /// <summary>Where this recording is on each release: release id → "disc/no".</summary>
        public Dictionary<string, string> On { get; set; } = new();
    }

    public sealed class ReleaseMatch
    {
        public string Id { get; set; }
        public string Title { get; set; }
        public string Artist { get; set; }
        public string Date { get; set; }
        public string Country { get; set; }
        public string Format { get; set; }
        public int Tracks { get; set; }
        public int Discs { get; set; }
        public int Matched { get; set; }
    }

    static string Str(JsonElement e, string n) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    static int Int(JsonElement e, string n) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : 0;
    static IEnumerable<JsonElement> Arr(JsonElement e, string n) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Array ? v.EnumerateArray() : Enumerable.Empty<JsonElement>();

    static string ArtistsOf(JsonElement e)
    {
        var list = Arr(e, "artists").ToList();
        if (list.Count == 0) return null;
        var sb = new System.Text.StringBuilder();
        for (int i = 0; i < list.Count; i++)
        {
            sb.Append(Str(list[i], "name"));
            string jp = Str(list[i], "joinphrase");
            sb.Append(jp ?? (i < list.Count - 1 ? ", " : ""));
        }
        return sb.ToString().Trim();
    }

    /// <summary>
    /// Fingerprints and looks up the tracks (a few at a time), reporting each one, and ranks the releases by how
    /// many of them they hold.
    /// </summary>
    public async Task<object> Identify(IReadOnlyList<Track> tracks, Action<object> progress, CancellationToken ct)
    {
        if (!HasKey) throw new InvalidOperationException("還沒有設定 AcoustID 金鑰");
        progress(new { stage = "tool" });
        await EnsureFpcalc();
        var matches = new TrackMatch[tracks.Count];
        var releases = new ConcurrentDictionary<string, ReleaseMatch>();
        var counts = new ConcurrentDictionary<string, int>();
        using var gate = new SemaphoreSlim(Math.Clamp(Environment.ProcessorCount / 2, 2, 4));
        await Task.WhenAll(tracks.Select(async (t, i) =>
        {
            await gate.WaitAsync(ct);
            var m = matches[i] = new TrackMatch { Id = t.Id, Status = "none" };
            try
            {
                progress(new { id = t.Id, state = "print" });
                string print = await Fingerprint(t, ct);
                progress(new { id = t.Id, state = "lookup" });
                var root = await Lookup(print, t.Duration, ct);
                // the best result that has recordings
                var best = Arr(root, "results").Where(r => Arr(r, "recordings").Any())
                    .OrderByDescending(r => r.TryGetProperty("score", out var rs) && rs.ValueKind == JsonValueKind.Number ? rs.GetDouble() : 0).FirstOrDefault();
                if (best.ValueKind == JsonValueKind.Object)
                {
                    m.Score = best.TryGetProperty("score", out var sc) && sc.ValueKind == JsonValueKind.Number ? Math.Round(sc.GetDouble(), 3) : 0;
                    var recs = Arr(best, "recordings").ToList();
                    // the recording that is on the most releases is the "main" one; titles of the others are variants
                    var rec = recs.OrderByDescending(r => Arr(r, "releases").Count()).First();
                    m.Recording = Str(rec, "id"); m.Title = Str(rec, "title"); m.Artist = ArtistsOf(rec);
                    m.Status = m.Title != null ? "ok" : "none";
                    foreach (var r in recs)
                        foreach (var rel in Arr(r, "releases"))
                        {
                            string rid = Str(rel, "id");
                            if (rid == null) continue;
                            foreach (var med in Arr(rel, "mediums"))
                                foreach (var tr in Arr(med, "tracks"))
                                    m.On[rid] = $"{Math.Max(1, Int(med, "position"))}/{Int(tr, "position")}";
                            if (!m.On.ContainsKey(rid)) m.On[rid] = "";
                            releases.GetOrAdd(rid, _ =>
                            {
                                var date = rel.TryGetProperty("date", out var d) && d.ValueKind == JsonValueKind.Object
                                    ? string.Join("-", new[] { Int(d, "year"), Int(d, "month"), Int(d, "day") }.TakeWhile(x => x > 0).Select((x, k) => k == 0 ? x.ToString() : x.ToString("00")))
                                    : null;
                                return new ReleaseMatch
                                {
                                    Id = rid, Title = Str(rel, "title"), Artist = ArtistsOf(rel) ?? m.Artist, Date = date, Country = Str(rel, "country"),
                                    Tracks = Int(rel, "track_count"), Discs = Math.Max(1, Int(rel, "medium_count")),
                                    Format = string.Join(" + ", Arr(rel, "mediums").Select(x => Str(x, "format")).Where(x => x != null).Distinct()),
                                };
                            });
                        }
                    foreach (var rid in m.On.Keys) counts.AddOrUpdate(rid, 1, (_, n) => n + 1);
                }
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex) { m.Status = "error"; m.Error = ex.Message; Log.Info($"Identify {t.Path}: {ex.Message}"); }
            finally
            {
                gate.Release();
                progress(new { id = t.Id, state = m.Status, title = m.Title, artist = m.Artist, score = m.Score, error = m.Error });
            }
        }));
        SaveCache();
        foreach (var (rid, n) in counts) if (releases.TryGetValue(rid, out var r)) r.Matched = n;
        // most matched first; then the release whose size is closest to the tracks identified, the earliest
        var ranked = releases.Values.OrderByDescending(r => r.Matched)
            .ThenBy(r => r.Tracks > 0 ? Math.Abs(r.Tracks - tracks.Count) : 999)
            .ThenBy(r => r.Date ?? "9999").Take(40).ToList();
        return new { tracks = matches, releases = ranked };
    }
}
