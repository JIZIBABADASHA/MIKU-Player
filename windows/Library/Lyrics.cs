using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Miku.Library;

public sealed class LyricWord
{
    public double T { get; set; }
    public string W { get; set; }
}

public sealed class LyricLine
{
    public double T { get; set; }
    public string Text { get; set; }
    public string Trans { get; set; }
    public List<LyricWord> Words { get; set; }
}

public sealed class LyricsResult
{
    public string Source { get; set; }
    public bool Synced { get; set; }
    public bool Instrumental { get; set; }
    public List<LyricLine> Lines { get; set; } = new();
    public DateTime Fetched { get; set; }
    /// <summary>The user picked this result by hand (or said "none of these"): never replace it automatically.</summary>
    public bool Manual { get; set; }
}

public sealed class LyricCandidate
{
    public string Key { get; set; }
    public string Source { get; set; }
    public string Title { get; set; }
    public string Artist { get; set; }
    public string Album { get; set; }
    public double Duration { get; set; }
    public double Diff { get; set; }
    public bool Synced { get; set; }
}

public static class Lrc
{
    static readonly Regex TimeTag = new(@"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]", RegexOptions.Compiled);
    static readonly Regex WordTag = new(@"<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>", RegexOptions.Compiled);
    static readonly Regex Meta = new(@"^\[(ar|ti|al|by|re|ve|length|au|offset|#)\s*:(.*)\]\s*$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    static double Seconds(Match m)
    {
        double min = double.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        double sec = double.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
        double frac = 0;
        if (m.Groups[3].Success)
        {
            string f = m.Groups[3].Value;
            frac = double.Parse(f, CultureInfo.InvariantCulture) / Math.Pow(10, f.Length);
        }
        return min * 60 + sec + frac;
    }

    public static bool LooksSynced(string text) => text != null && TimeTag.Matches(text).Count >= 3;

    public static List<LyricLine> Parse(string text)
    {
        var lines = new List<LyricLine>();
        double offset = 0;
        foreach (var raw in text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n'))
        {
            string line = raw.Trim();
            if (line.Length == 0) continue;
            var meta = Meta.Match(line);
            if (meta.Success)
            {
                if (meta.Groups[1].Value.Equals("offset", StringComparison.OrdinalIgnoreCase) && double.TryParse(meta.Groups[2].Value.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var ms))
                    offset = ms / 1000.0;
                continue;
            }
            var times = new List<double>();
            int pos = 0;
            while (true)
            {
                var m = TimeTag.Match(line, pos);
                if (!m.Success || m.Index != pos) break;
                times.Add(Seconds(m));
                pos = m.Index + m.Length;
            }
            if (times.Count == 0) continue;
            string body = line[pos..];
            List<LyricWord> words = null;
            var wm = WordTag.Matches(body);
            if (wm.Count > 0)
            {
                words = new List<LyricWord>();
                for (int i = 0; i < wm.Count; i++)
                {
                    int start = wm[i].Index + wm[i].Length;
                    int end = i + 1 < wm.Count ? wm[i + 1].Index : body.Length;
                    string w = body[start..end];
                    if (w.Length > 0) words.Add(new LyricWord { T = Seconds(wm[i]) - offset, W = w });
                }
                body = WordTag.Replace(body, "");
            }
            body = body.Trim();
            foreach (var t in times)
                lines.Add(new LyricLine { T = Math.Max(0, t - offset), Text = body, Words = times.Count == 1 ? words : null });
        }
        lines.Sort((a, b) => a.T.CompareTo(b.T));
        // two lines with the same timestamp: the second one is a translation
        var merged = new List<LyricLine>();
        foreach (var l in lines)
        {
            var prev = merged.Count > 0 ? merged[^1] : null;
            if (prev != null && Math.Abs(prev.T - l.T) < 0.011 && prev.Trans == null && l.Text.Length > 0 && prev.Text.Length > 0)
                prev.Trans = l.Text;
            else merged.Add(l);
        }
        // collapse runs of empty lines
        var result = new List<LyricLine>();
        foreach (var l in merged)
        {
            if (l.Text.Length == 0 && (result.Count == 0 || result[^1].Text.Length == 0)) { if (result.Count > 0) continue; }
            result.Add(l);
        }
        while (result.Count > 0 && result[^1].Text.Length == 0) result.RemoveAt(result.Count - 1);
        return result;
    }

    public static List<LyricLine> Plain(string text) =>
        text.Replace("\r\n", "\n").Split('\n').Select(s => s.Trim()).Where(s => !Meta.IsMatch(s))
            .Select(s => new LyricLine { T = -1, Text = TimeTag.Replace(s, "").Trim() }).ToList();

    public static void MergeTranslation(List<LyricLine> lines, List<LyricLine> trans)
    {
        if (trans == null || trans.Count == 0) return;
        foreach (var l in lines)
        {
            if (l.Text.Length == 0 || l.Trans != null) continue;
            var hit = trans.FirstOrDefault(t => Math.Abs(t.T - l.T) < 0.35 && t.Text.Length > 0);
            if (hit != null && !string.Equals(hit.Text, l.Text, StringComparison.Ordinal)) l.Trans = hit.Text;
        }
    }
}

public sealed class LyricsService
{
    readonly Settings _s;
    readonly ConcurrentDictionary<string, Task<LyricsResult>> _inflight = new();

    public LyricsService(Settings s) { _s = s; }

    public Task<LyricsResult> GetAsync(Track t, bool refresh = false)
    {
        if (refresh) { try { File.Delete(CachePath(t)); } catch { } }
        return _inflight.GetOrAdd(t.Id, key => Task.Run(async () =>
        {
            try { return await Resolve(t); }
            catch (Exception ex) { Log.Error("Lyrics", ex); return new LyricsResult(); }
            finally { _inflight.TryRemove(t.Id, out var removed); }
        }));
    }

    /// <summary>Look up lyrics for every track in the library (local files and cache first, online only when needed).</summary>
    public async Task FetchAll(IEnumerable<Track> tracks, IProgress<(int done, int total, int found)> progress, CancellationToken ct)
    {
        var list = tracks.ToList();
        int done = 0, found = 0;
        progress?.Report((0, list.Count, 0));
        foreach (var t in list)
        {
            if (ct.IsCancellationRequested) break;
            bool hadCache = File.Exists(CachePath(t));
            var r = await GetAsync(t);
            if (r.Lines.Count > 0 || r.Instrumental) found++;
            done++;
            if (done % 5 == 0 || done == list.Count) progress?.Report((done, list.Count, found));
            // only pause after a real network lookup, to stay polite to LRCLIB / NetEase
            if (!hadCache && File.Exists(CachePath(t)))
                try { await Task.Delay(350, ct); } catch (OperationCanceledException) { break; }
        }
    }

    /* ── manual choice: loose search the user picks from ── */

    /// <summary>All plausible matches from LRCLIB and NetEase, without the strict length filter, closest first.</summary>
    public async Task<List<LyricCandidate>> Candidates(Track t)
    {
        // the first of several artists ("ほぼ日P ;  初音ミク"), like the automatic search
        string artist = Text.FirstArtist(string.IsNullOrWhiteSpace(t.Artist) ? t.AlbumArtist : t.Artist);
        var list = new List<LyricCandidate>();
        var lrclib = Task.Run(async () =>
        {
            var r = new List<LyricCandidate>();
            string url = "https://lrclib.net/api/search?track_name=" + Uri.EscapeDataString(t.Title) + "&artist_name=" + Uri.EscapeDataString(artist ?? "");
            using var res = await Net.Http.GetAsync(url);
            if (!res.IsSuccessStatusCode) return r;
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
            foreach (var e in doc.RootElement.EnumerateArray())
            {
                if (Str(e, "syncedLyrics") == null && Str(e, "plainLyrics") == null) continue;
                double dur = e.TryGetProperty("duration", out var dd) && dd.ValueKind == JsonValueKind.Number ? dd.GetDouble() : 0;
                r.Add(new LyricCandidate { Key = "lrclib:" + e.GetProperty("id").GetRawText(), Source = "LRCLIB", Title = Str(e, "trackName"), Artist = Str(e, "artistName"),
                    Album = Str(e, "albumName"), Duration = dur, Synced = Str(e, "syncedLyrics") != null });
            }
            return r;
        });
        var netease = Task.Run(async () =>
        {
            var r = new List<LyricCandidate>();
            string q = Uri.EscapeDataString((t.Title + " " + artist).Trim());
            using var req = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Get,
                $"https://music.163.com/api/search/get/web?csrf_token=&hlpretag=&hlposttag=&s={q}&type=1&offset=0&total=true&limit=12");
            req.Headers.Referrer = new Uri("https://music.163.com/");
            using var res = await Net.Http.SendAsync(req);
            if (!res.IsSuccessStatusCode) return r;
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
            if (!doc.RootElement.TryGetProperty("result", out var result) || !result.TryGetProperty("songs", out var songs)) return r;
            foreach (var s in songs.EnumerateArray())
            {
                if (Text.Similarity(Str(s, "name"), t.Title) < 0.5) continue;
                string ar = s.TryGetProperty("artists", out var arr) ? string.Join(", ", arr.EnumerateArray().Select(a => Str(a, "name"))) : "";
                string al = s.TryGetProperty("album", out var alb) ? Str(alb, "name") : null;
                double dur = s.TryGetProperty("duration", out var d) && d.ValueKind == JsonValueKind.Number ? d.GetDouble() / 1000 : 0;
                r.Add(new LyricCandidate { Key = "ne:" + s.GetProperty("id").GetInt64(), Source = "網易雲音樂", Title = Str(s, "name"), Artist = ar, Album = al, Duration = dur, Synced = true });
            }
            return r;
        });
        try { list.AddRange(await lrclib); } catch (Exception ex) { Log.Info("LRCLIB candidates: " + ex.Message); }
        try { list.AddRange(await netease); } catch (Exception ex) { Log.Info("NetEase candidates: " + ex.Message); }
        foreach (var c in list) c.Diff = t.Duration > 0 && c.Duration > 0 ? Math.Round(c.Duration - t.Duration, 1) : 0;
        return list.OrderBy(c => c.Duration > 0 && t.Duration > 0 ? Math.Abs(c.Diff) : 30).ThenBy(c => c.Synced ? 0 : 1).Take(15).ToList();
    }

    /// <summary>Download the chosen candidate and pin it as this track's lyrics.</summary>
    public async Task<LyricsResult> Apply(Track t, string key)
    {
        LyricsResult r = null;
        if (key.StartsWith("lrclib:"))
        {
            using var res = await Net.Http.GetAsync("https://lrclib.net/api/get/" + key[7..]);
            if (res.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
                var h = doc.RootElement;
                string synced = Str(h, "syncedLyrics"), plain = Str(h, "plainLyrics");
                if (synced != null) r = new LyricsResult { Source = "LRCLIB", Synced = true, Lines = Lrc.Parse(synced) };
                else if (plain != null) r = new LyricsResult { Source = "LRCLIB", Lines = Lrc.Plain(plain) };
            }
        }
        else if (key.StartsWith("ne:") && long.TryParse(key[3..], out var id)) r = await NetEaseLyric(id);
        if (r == null) return null;
        r.Manual = true; r.Fetched = DateTime.UtcNow;
        try { await File.WriteAllTextAsync(CachePath(t), Json.Serialize(r)); } catch { }
        return r;
    }

    /// <summary>"None of these are right": remember that, so the wrong lyrics never come back on their own.</summary>
    public async Task Clear(Track t)
    {
        var r = new LyricsResult { Source = "已標記為錯誤", Manual = true, Fetched = DateTime.UtcNow };
        try { await File.WriteAllTextAsync(CachePath(t), Json.Serialize(r)); } catch { }
    }

    static string CachePath(Track t) => Path.Combine(AppPaths.Lyrics, t.Id + ".v2.json") /* v2: stricter length matching, old caches re-fetched */;

    async Task<LyricsResult> Resolve(Track t)
    {
        LyricsResult plainFallback = null;

        // 1. sidecar .lrc / .txt
        foreach (var ext in new[] { ".lrc", ".LRC", ".txt" })
        {
            string p = Path.ChangeExtension(t.Path, ext);
            if (!File.Exists(p)) continue;
            string text = Text.DecodeUnknown(await File.ReadAllBytesAsync(p));
            if (Lrc.LooksSynced(text)) return new LyricsResult { Source = "本機 LRC", Synced = true, Lines = Lrc.Parse(text) };
            plainFallback ??= new LyricsResult { Source = "本機歌詞", Lines = Lrc.Plain(text) };
        }
        // 2. embedded
        string emb = TagReader.EmbeddedLyrics(t);
        if (emb != null)
        {
            if (Lrc.LooksSynced(emb)) return new LyricsResult { Source = "內嵌歌詞", Synced = true, Lines = Lrc.Parse(emb) };
            plainFallback ??= new LyricsResult { Source = "內嵌歌詞", Lines = Lrc.Plain(emb) };
        }
        // 3. cache of online results
        string cache = CachePath(t);
        if (File.Exists(cache))
        {
            try
            {
                var c = Json.Deserialize<LyricsResult>(await File.ReadAllTextAsync(cache));
                if (c.Manual) return c.Lines.Count > 0 ? c : (plainFallback ?? c);
                if (c.Synced && c.Lines.Count > 0) return c;
                // a previous "not found" is only trusted for a few minutes: opening the song again searches online again
                if (c.Lines.Count > 0 || c.Instrumental || DateTime.UtcNow - c.Fetched < TimeSpan.FromMinutes(10))
                    return plainFallback ?? c;
            }
            catch { }
        }
        if (!_s.OnlineLyrics) return plainFallback ?? new LyricsResult();

        // 4. online: LRCLIB, then NetEase (much better coverage of Japanese / Chinese music)
        LyricsResult online = null;
        bool failed = false;                       // a service could not be asked (offline, timeout, refused)
        try { online = await LrcLib(t); } catch (Exception ex) { failed = true; Log.Info("LRCLIB: " + ex.Message); }
        if (online == null || !online.Synced || (_s.LyricsTranslation && online.Lines.All(l => l.Trans == null) && LikelyForeign(online)))
        {
            try
            {
                var ne = await NetEase(t);
                if (ne != null && (online == null || (ne.Synced && !online.Synced) || (ne.Synced && ne.Lines.Any(l => l.Trans != null)))) online = ne;
            }
            catch (Exception ex) { failed = true; Log.Info("NetEase: " + ex.Message); }
        }
        var result = online ?? new LyricsResult();
        result.Fetched = DateTime.UtcNow;
        // "not found" is remembered only when the services answered: a lookup that failed (e.g. many songs skipped
        // quickly, some requests timed out or were refused) would otherwise hide lyrics that exist for 10 minutes
        if (result.Lines.Count > 0 || result.Instrumental || !failed)
            try { await File.WriteAllTextAsync(cache, Json.Serialize(result)); } catch { }
        if (result.Lines.Count == 0 && plainFallback != null) return plainFallback;
        if (!result.Synced && plainFallback != null) return plainFallback;
        return result;
    }

    static bool LikelyForeign(LyricsResult r)
    {
        // Kana or latin lyrics benefit from a Chinese translation; Chinese lyrics don't.
        string all = string.Concat(r.Lines.Take(20).Select(l => l.Text));
        int kana = all.Count(c => c >= '぀' && c <= 'ヿ');
        int han = all.Count(c => c >= '一' && c <= '鿿');
        int latin = all.Count(c => c < 128 && char.IsLetter(c));
        return kana > 5 || latin > han * 2;
    }

    /// <summary>
    /// A reply that is not an answer (too many requests, a server error …) is a failed lookup, not "no lyrics": it
    /// throws, so the result is not remembered as "not found". LRCLIB's 404 on /get is its "no such song".
    /// </summary>
    static void Answered(System.Net.Http.HttpResponseMessage res, bool notFoundIsAnAnswer = false)
    {
        if (res.IsSuccessStatusCode || (notFoundIsAnAnswer && res.StatusCode == System.Net.HttpStatusCode.NotFound)) return;
        throw new System.Net.Http.HttpRequestException($"{(int)res.StatusCode} {res.ReasonPhrase}", null, res.StatusCode);
    }

    static async Task<LyricsResult> LrcLib(Track t)
    {
        // the first of several artists ("ほぼ日P ;  初音ミク"): the services match one name
        string artist = Text.FirstArtist(string.IsNullOrWhiteSpace(t.Artist) ? t.AlbumArtist : t.Artist);
        string url = "https://lrclib.net/api/get?artist_name=" + Uri.EscapeDataString(artist ?? "") +
                     "&track_name=" + Uri.EscapeDataString(t.Title) +
                     "&album_name=" + Uri.EscapeDataString(t.Album ?? "") +
                     "&duration=" + Math.Round(t.Duration).ToString(CultureInfo.InvariantCulture);
        JsonElement? hit = null;
        using (var res = await Net.Http.GetAsync(url))
        {
            Answered(res, notFoundIsAnAnswer: true);
            if (res.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
                hit = doc.RootElement.Clone();
            }
        }
        if (hit == null || (Str(hit.Value, "syncedLyrics") == null && !Bool(hit.Value, "instrumental")))
        {
            string s = "https://lrclib.net/api/search?track_name=" + Uri.EscapeDataString(t.Title) + "&artist_name=" + Uri.EscapeDataString(artist ?? "");
            using var res = await Net.Http.GetAsync(s);
            Answered(res);
            if (res.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
                JsonElement? best = null; double bestDiff = 99;
                foreach (var e in doc.RootElement.EnumerateArray())
                {
                    double d = e.TryGetProperty("duration", out var dd) && dd.ValueKind == JsonValueKind.Number ? Math.Abs(dd.GetDouble() - t.Duration) : 50;
                    if (t.Duration > 0 && d > 2.5) continue;
                    if (Text.Similarity(Str(e, "trackName"), t.Title) < 0.7) continue;
                    if (Str(e, "syncedLyrics") != null) d -= 10;
                    if (d < bestDiff) { bestDiff = d; best = e.Clone(); }
                }
                hit = best ?? hit;
            }
        }
        if (hit == null) return null;
        var h = hit.Value;
        if (Bool(h, "instrumental")) return new LyricsResult { Source = "LRCLIB", Instrumental = true };
        string synced = Str(h, "syncedLyrics");
        if (synced != null) return new LyricsResult { Source = "LRCLIB", Synced = true, Lines = Lrc.Parse(synced) };
        string plain = Str(h, "plainLyrics");
        return plain != null ? new LyricsResult { Source = "LRCLIB", Lines = Lrc.Plain(plain) } : null;
    }

    static async Task<LyricsResult> NetEase(Track t)
    {
        // the first of several artists ("ほぼ日P ;  初音ミク"): the services match one name
        string artist = Text.FirstArtist(string.IsNullOrWhiteSpace(t.Artist) ? t.AlbumArtist : t.Artist);
        string q = Uri.EscapeDataString((t.Title + " " + artist).Trim());
        using var req = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Get,
            $"https://music.163.com/api/search/get/web?csrf_token=&hlpretag=&hlposttag=&s={q}&type=1&offset=0&total=true&limit=12");
        req.Headers.Referrer = new Uri("https://music.163.com/");
        using var res = await Net.Http.SendAsync(req);
        Answered(res);
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        if (!doc.RootElement.TryGetProperty("result", out var result) || !result.TryGetProperty("songs", out var songs)) return null;
        long bestId = 0; double bestScore = 0;
        foreach (var s in songs.EnumerateArray())
        {
            double titleSim = Text.Similarity(Str(s, "name"), t.Title);
            string ar = s.TryGetProperty("artists", out var arr) ? string.Join(" ", arr.EnumerateArray().Select(a => Str(a, "name"))) : "";
            double artistSim = string.IsNullOrWhiteSpace(artist) ? 0.5 : Math.Max(Text.Similarity(artist, ar), Text.Similarity(artist, ar, false));
            double dur = s.TryGetProperty("duration", out var d) && d.ValueKind == JsonValueKind.Number ? d.GetDouble() / 1000 : 0;
            // a different length means a different cut (longer intro, radio edit, TV size...) whose timings won't line up: reject it
            double durScore = t.Duration <= 0 || dur <= 0 ? 0.5 : Math.Abs(dur - t.Duration) <= 1.5 ? 1 : Math.Abs(dur - t.Duration) <= 3 ? 0.6 : 0;
            if (titleSim < 0.7 || durScore == 0) continue;
            double score = titleSim * 0.45 + artistSim * 0.3 + durScore * 0.25;
            if (score > bestScore) { bestScore = score; bestId = s.GetProperty("id").GetInt64(); }
        }
        if (bestId == 0 || bestScore < 0.62) return null;
        return await NetEaseLyric(bestId);
    }

    static async Task<LyricsResult> NetEaseLyric(long bestId)
    {
        using var req2 = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Get, $"https://music.163.com/api/song/lyric?id={bestId}&lv=1&kv=1&tv=-1");
        req2.Headers.Referrer = new Uri("https://music.163.com/");
        using var res2 = await Net.Http.SendAsync(req2);
        Answered(res2);
        using var ld = JsonDocument.Parse(await res2.Content.ReadAsStringAsync());
        var root = ld.RootElement;
        string lrc = root.TryGetProperty("lrc", out var l) ? Str(l, "lyric") : null;
        string tl = root.TryGetProperty("tlyric", out var tlo) ? Str(tlo, "lyric") : null;
        if (string.IsNullOrWhiteSpace(lrc)) return null;
        if (lrc.Contains("纯音乐，请欣赏")) return new LyricsResult { Source = "網易雲音樂", Instrumental = true };
        var r = new LyricsResult { Source = "網易雲音樂", Synced = Lrc.LooksSynced(lrc) };
        r.Lines = r.Synced ? Lrc.Parse(lrc) : Lrc.Plain(lrc);
        // drop credit lines like "作词 : xxx" at the start
        r.Lines = r.Lines.Where((x, i) => !(i < 6 && Regex.IsMatch(x.Text, @"^(作词|作曲|编曲|作詞|編曲|制作人|製作)\s*[:：]"))).ToList();
        if (!string.IsNullOrWhiteSpace(tl) && r.Synced) Lrc.MergeTranslation(r.Lines, Lrc.Parse(tl));
        return r;
    }

    static string Str(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && v.GetString().Length > 0 ? v.GetString() : null;
    static bool Bool(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
}
