using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Miku.Library;

public sealed class ArtworkService
{
    readonly MusicLibrary _lib;
    readonly Settings _s;
    readonly SemaphoreSlim _resize = new(Math.Max(2, Environment.ProcessorCount - 1));
    readonly SemaphoreSlim _online = new(2);
    readonly ConcurrentDictionary<string, Task<byte[]>> _inflight = new();
    readonly ConcurrentDictionary<string, Task<bool>> _onlineInflight = new();
    DateTime _lastMusicBrainz = DateTime.MinValue;
    DateTime _lastITunes = DateTime.MinValue;
    readonly SemaphoreSlim _itunesGate = new(1, 1);
    static string OverridePath(string albumId) => Path.Combine(AppPaths.Art, "Override", "a_" + albumId + ".jpg");

    /// <summary>Raised when online artwork for an album or artist becomes available (kind, id).</summary>
    public event Action<string, string> Updated;

    public ArtworkService(MusicLibrary lib, Settings settings) { _lib = lib; _s = settings; }

    // ───────────────────────────── album / track art ─────────────────────────────

    public Task<byte[]> AlbumAsync(string albumId, int size) => Cached("a_" + albumId, size, () => AlbumSource(albumId));

    public Task<byte[]> TrackAsync(string trackId, int size)
    {
        var t = _lib.GetTrack(trackId);
        if (t == null) return Task.FromResult<byte[]>(null);
        var album = _lib.GetAlbum(t.AlbumId);
        // Loose tracks (no album tag) each have their own picture, unless the user picked one for the folder.
        if (album != null && (!album.Loose || File.Exists(OverridePath(album.Id)))) return AlbumAsync(album.Id, size);
        return Cached("t_" + trackId, size, () => TrackSource(t));
    }

    byte[] AlbumSource(string albumId)
    {
        var a = _lib.GetAlbum(albumId);
        if (a == null) return null;
        string ov = OverridePath(albumId);
        if (File.Exists(ov)) { try { return File.ReadAllBytes(ov); } catch { } }
        if (a.ArtPath != null) { try { return File.ReadAllBytes(a.ArtPath); } catch { } }
        foreach (var t in a.Tracks.Where(t => t.HasPic).Take(3))
        {
            var b = TagReader.EmbeddedPicture(t);
            if (b != null && b.Length > 100) return b;
        }
        string online = Path.Combine(AppPaths.OnlineArt, "a_" + albumId + ".jpg");
        if (File.Exists(online)) return File.ReadAllBytes(online);
        if (_s.OnlineArt) _ = a.Loose && a.Tracks.Count > 0 ? FetchTrackOnline(a.Tracks[0]) : FetchAlbumOnline(a);
        if (a.Loose && a.Tracks.Count > 0)
        {
            string t0 = Path.Combine(AppPaths.OnlineArt, "t_" + a.Tracks[0].Id + ".jpg");
            if (File.Exists(t0)) return File.ReadAllBytes(t0);
        }
        return null;
    }

    byte[] TrackSource(Track t)
    {
        string ov = OverridePath(t.AlbumId);
        if (File.Exists(ov)) { try { return File.ReadAllBytes(ov); } catch { } }
        if (t.HasPic) { var b = TagReader.EmbeddedPicture(t); if (b != null) return b; }
        var a = _lib.GetAlbum(t.AlbumId);
        if (a?.ArtPath != null) { try { return File.ReadAllBytes(a.ArtPath); } catch { } }
        string online = Path.Combine(AppPaths.OnlineArt, "t_" + t.Id + ".jpg");
        if (File.Exists(online)) return File.ReadAllBytes(online);
        if (_s.OnlineArt) _ = FetchTrackOnline(t);
        return null;
    }

    async Task<byte[]> Cached(string key, int size, Func<byte[]> source)
    {
        size = Math.Clamp(size <= 0 ? 600 : size, 32, 2400);
        // snap to a few sizes so the cache stays small
        size = new[] { 64, 128, 256, 384, 512, 768, 1024, 1600, 2400 }.First(s => s >= size);
        string thumb = Path.Combine(AppPaths.Thumbs, $"{key}_{size}.jpg");
        if (File.Exists(thumb)) { try { return await File.ReadAllBytesAsync(thumb); } catch { } }
        var task = _inflight.GetOrAdd(thumb, _ => Task.Run(async () =>
        {
            byte[] src = source();
            if (src == null) return null;
            await _resize.WaitAsync();
            try
            {
                var bytes = Resize(src, size);
                if (bytes != null) { try { await File.WriteAllBytesAsync(thumb, bytes); } catch { } }
                return bytes;
            }
            finally { _resize.Release(); }
        }));
        try { return await task; }
        finally { _inflight.TryRemove(thumb, out _); }
    }

    public void ForgetThumbs(string key)
    {
        try { foreach (var f in Directory.EnumerateFiles(AppPaths.Thumbs, key + "_*.jpg")) File.Delete(f); } catch { }
    }

    static readonly ImageCodecInfo Jpeg = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);

    public static byte[] Resize(byte[] src, int size)
    {
        try
        {
            using var ms = new MemoryStream(src);
            using var img = Image.FromStream(ms, false, false);
            int w = img.Width, h = img.Height;
            if (w <= 0 || h <= 0) return null;
            double scale = Math.Min(1.0, (double)size / Math.Max(w, h));
            int nw = Math.Max(1, (int)Math.Round(w * scale)), nh = Math.Max(1, (int)Math.Round(h * scale));
            using var bmp = new Bitmap(nw, nh, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.CompositingQuality = CompositingQuality.HighQuality;
                g.SmoothingMode = SmoothingMode.HighQuality;
                using var attrs = new ImageAttributes();
                attrs.SetWrapMode(WrapMode.TileFlipXY);
                g.Clear(Color.Black);
                g.DrawImage(img, new Rectangle(0, 0, nw, nh), 0, 0, w, h, GraphicsUnit.Pixel, attrs);
            }
            using var outMs = new MemoryStream();
            using var p = new EncoderParameters(1);
            p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, size >= 1024 ? 94L : 90L);
            bmp.Save(outMs, Jpeg, p);
            return outMs.ToArray();
        }
        catch (Exception ex)
        {
            // GDI+ can't decode some formats (e.g. WebP); the browser can, so hand over the original.
            Log.Info("Resize failed (" + ex.Message + "), serving original image");
            return src.Length > 100 ? src : null;
        }
    }

    // ───────────────────────────── online lookup ─────────────────────────────

    const string MissExt = ".miss3"; // bump to retry everything after improving the search

    static bool RecentlyMissed(string file) =>
        File.Exists(file) && DateTime.UtcNow - File.GetLastWriteTimeUtc(file) < TimeSpan.FromDays(5);

    static string CleanArtist(string s) => s is null or "Various Artists" or "未知演出者" ? "" : s.Trim().Trim('【', '】', '[', ']', '(', ')').Trim();

    /// <summary>Automatic search: album + artist, album alone, folder name, then each track as a song.</summary>
    async Task<string> FindAlbumUrl(Album a)
    {
        string artist = CleanArtist(a.Artist);
        string folder = Path.GetFileName(a.Folder ?? "");
        var titles = new List<string>();
        if (!a.Loose && !string.IsNullOrWhiteSpace(a.Title)) titles.Add(a.Title);
        if (!string.IsNullOrWhiteSpace(folder) && Text.Norm(folder) != Text.Norm(a.Title)) titles.Add(folder);
        foreach (var title in titles)
        {
            var c = await AlbumCandidates(artist, title, 12);
            string url = BestAlbum(c, artist, title, strict: false);
            if (url != null) return url;
            if (artist.Length > 0)
            {
                c = await AlbumCandidates("", title, 12);
                url = BestAlbum(c, artist, title, strict: true);
                if (url != null) return url;
            }
        }
        foreach (var t in a.Tracks.Take(8))
        {
            string url = await FindSongUrl(t);
            if (url != null) return url;
        }
        return null;
    }

    async Task<string> FindSongUrl(Track t)
    {
        var c = await SongCandidates(CleanArtist(t.Artist), t.Title, 15);
        double best = 0; string url = null;
        foreach (var x in c)
        {
            double ts = Text.Similarity(t.Title, x.Title);
            if (ts < 0.8) continue;
            double ars = string.IsNullOrWhiteSpace(t.Artist) ? 0.5 : Math.Max(Text.Similarity(t.Artist, x.Artist), Text.Similarity(t.Artist, x.Artist, false));
            bool durOk = t.Duration > 0 && x.Duration > 0 && Math.Abs(t.Duration - x.Duration) <= 3;
            if (ars < 0.5 && !durOk) continue;
            double score = ts * 0.5 + ars * 0.3 + (durOk ? 0.2 : 0);
            if (score > best) { best = score; url = x.Url; }
        }
        return url;
    }

    static string BestAlbum(List<ArtCandidate> c, string artist, string title, bool strict)
    {
        double best = 0; string url = null;
        foreach (var x in c)
        {
            double ts = Text.Similarity(title, x.Title);
            double ars = string.IsNullOrWhiteSpace(artist) ? 0.6 : Math.Max(Text.Similarity(artist, x.Artist), Text.Similarity(artist, x.Artist, false));
            bool ok = strict ? ts >= 0.95 : ts >= 0.72 && (ars >= 0.5 || ts >= 0.95);
            if (!ok) continue;
            double score = ts * 0.62 + ars * 0.38;
            if (score > best) { best = score; url = x.Url; }
        }
        return best >= 0.6 ? url : null;
    }

    Task<bool> FetchAlbumOnline(Album a)
    {
        string target = Path.Combine(AppPaths.OnlineArt, "a_" + a.Id + ".jpg");
        string miss = target + MissExt;
        if (RecentlyMissed(miss)) return Task.FromResult(false);
        return _onlineInflight.GetOrAdd(target, key => Task.Run(async () =>
        {
            await _online.WaitAsync();
            try
            {
                string url = await FindAlbumUrl(a);
                bool ok = url != null && await Download(url, target);
                if (ok)
                {
                    ForgetThumbs("a_" + a.Id);
                    Updated?.Invoke("album", a.Id);
                }
                else File.WriteAllText(miss, DateTime.UtcNow.ToString("o"));
                return ok;
            }
            catch (Exception ex) { Log.Info("Online art failed for " + a.Title + ": " + ex.Message); return false; }
            finally { _online.Release(); _onlineInflight.TryRemove(target, out var removed); }
        }));
    }

    Task<bool> FetchTrackOnline(Track t)
    {
        string target = Path.Combine(AppPaths.OnlineArt, "t_" + t.Id + ".jpg");
        string miss = target + MissExt;
        if (RecentlyMissed(miss)) return Task.FromResult(false);
        return _onlineInflight.GetOrAdd(target, key => Task.Run(async () =>
        {
            await _online.WaitAsync();
            try
            {
                string url = await FindSongUrl(t);
                if (url == null)
                {
                    // fall back to the folder name, e.g. an untagged album folder
                    var a = _lib.GetAlbum(t.AlbumId);
                    string folder = a == null ? null : Path.GetFileName(a.Folder ?? "");
                    if (!string.IsNullOrWhiteSpace(folder))
                        url = BestAlbum(await AlbumCandidates(CleanArtist(t.Artist), folder, 12), CleanArtist(t.Artist), folder, false);
                }
                bool ok = url != null && await Download(url, target);
                if (ok)
                {
                    ForgetThumbs("t_" + t.Id);
                    Updated?.Invoke("track", t.Id);
                    var album = _lib.GetAlbum(t.AlbumId);
                    if (album != null) { ForgetThumbs("a_" + album.Id); Updated?.Invoke("album", album.Id); }
                }
                else File.WriteAllText(miss, DateTime.UtcNow.ToString("o"));
                return ok;
            }
            catch (Exception ex) { Log.Info("Online track art failed: " + ex.Message); return false; }
            finally { _online.Release(); _onlineInflight.TryRemove(target, out var removed); }
        }));
    }

    /// <summary>Look up every album that has no local art (runs in the background after a scan).</summary>
    public async Task FetchAllMissing(IProgress<(int done, int total, int found)> progress, CancellationToken ct, bool retryMisses = true)
    {
        var missing = _lib.Albums.Where(a => a.ArtPath == null && !a.Tracks.Any(t => t.HasPic)
            && !File.Exists(OverridePath(a.Id))
            && !File.Exists(Path.Combine(AppPaths.OnlineArt, "a_" + a.Id + ".jpg"))
            && !(a.Loose && a.Tracks.Count > 0 && File.Exists(Path.Combine(AppPaths.OnlineArt, "t_" + a.Tracks[0].Id + ".jpg")))).ToList();
        int done = 0, found = 0;
        foreach (var a in missing)
        {
            ct.ThrowIfCancellationRequested();
            if (retryMisses)
            {
                try { File.Delete(Path.Combine(AppPaths.OnlineArt, "a_" + a.Id + ".jpg" + MissExt)); } catch { }
                if (a.Tracks.Count > 0) try { File.Delete(Path.Combine(AppPaths.OnlineArt, "t_" + a.Tracks[0].Id + ".jpg" + MissExt)); } catch { }
            }
            bool ok = a.Loose ? await FetchTrackOnline(a.Tracks[0]) : await FetchAlbumOnline(a);
            if (ok) found++;
            progress?.Report((++done, missing.Count, found));
        }
    }

    public void RetryAlbum(string albumId)
    {
        var a = _lib.GetAlbum(albumId);
        if (a == null) return;
        try { File.Delete(Path.Combine(AppPaths.OnlineArt, "a_" + a.Id + ".jpg" + MissExt)); } catch { }
        _ = FetchAlbumOnline(a);
    }

    // ───────────────────────────── manual choice ─────────────────────────────

    /// <summary>Where the current album picture comes from: override | folder | embedded | online | none.</summary>
    public string SourceOf(string albumId)
    {
        var a = _lib.GetAlbum(albumId);
        if (a == null) return "none";
        if (File.Exists(OverridePath(albumId))) return "override";
        if (a.ArtPath != null) return "folder";
        if (a.Tracks.Any(t => t.HasPic)) return "embedded";
        if (File.Exists(Path.Combine(AppPaths.OnlineArt, "a_" + albumId + ".jpg"))) return "online";
        if (a.Loose && a.Tracks.Count > 0 && File.Exists(Path.Combine(AppPaths.OnlineArt, "t_" + a.Tracks[0].Id + ".jpg"))) return "online";
        return "none";
    }

    /// <summary>All candidate pictures for the picker: album results, then song results for the first tracks.</summary>
    public async Task<List<ArtCandidate>> Candidates(string albumId, string query)
    {
        var a = _lib.GetAlbum(albumId);
        var list = new List<ArtCandidate>();
        if (!string.IsNullOrWhiteSpace(query))
        {
            list.AddRange(await AlbumCandidates("", query, 25));
            list.AddRange(await SongCandidates("", query, 15));
        }
        else if (a != null)
        {
            string artist = CleanArtist(a.Artist);
            string title = a.Loose ? Path.GetFileName(a.Folder ?? "") : a.Title;
            list.AddRange(await AlbumCandidates(artist, title, 20));
            if (list.Count < 6) list.AddRange(await AlbumCandidates("", title, 20));
            foreach (var t in a.Tracks.Take(3)) list.AddRange(await SongCandidates(CleanArtist(t.Artist), t.Title, 8));
        }
        // de-duplicate by image
        return list.Where(c => c.Url != null).GroupBy(c => c.Url).Select(g => g.First()).Take(60).ToList();
    }

    public async Task<bool> SetOverrideFromUrl(string albumId, string url)
    {
        var bytes = await Net.Http.GetByteArrayAsync(url);
        return SetOverride(albumId, bytes);
    }

    public bool SetOverride(string albumId, byte[] bytes)
    {
        if (bytes == null || bytes.Length < 500) throw new InvalidOperationException("圖片太小或無效");
        // normalise anything GDI+ can read (png, bmp, gif…) to a high quality JPEG, keep WebP etc. as-is
        byte[] data = bytes;
        try
        {
            using var ms = new MemoryStream(bytes);
            using var img = Image.FromStream(ms, false, true);
            if (img.Width < 50) throw new InvalidOperationException("圖片太小");
            data = Resize(bytes, Math.Min(3000, Math.Max(img.Width, img.Height))) ?? bytes;
        }
        catch (ArgumentException) { }
        string path = OverridePath(albumId);
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        File.WriteAllBytes(path, data);
        ForgetThumbs("a_" + albumId);
        var a = _lib.GetAlbum(albumId);
        if (a != null) foreach (var t in a.Tracks) ForgetThumbs("t_" + t.Id);
        Updated?.Invoke("album", albumId);
        if (a != null) foreach (var t in a.Tracks.Take(200)) Updated?.Invoke("track", t.Id);
        return true;
    }

    public void ClearOverride(string albumId)
    {
        try { File.Delete(OverridePath(albumId)); } catch { }
        ForgetThumbs("a_" + albumId);
        Updated?.Invoke("album", albumId);
    }

    /// <summary>The automatic online picture was wrong: drop it and search again excluding it.</summary>
    public void RejectOnline(string albumId)
    {
        var a = _lib.GetAlbum(albumId);
        try { File.Delete(Path.Combine(AppPaths.OnlineArt, "a_" + albumId + ".jpg")); } catch { }
        if (a != null && a.Tracks.Count > 0) try { File.Delete(Path.Combine(AppPaths.OnlineArt, "t_" + a.Tracks[0].Id + ".jpg")); } catch { }
        ForgetThumbs("a_" + albumId);
        Updated?.Invoke("album", albumId);
    }

    // ───────────────────────────── providers ─────────────────────────────

    public sealed class ArtCandidate
    {
        public string Url { get; set; }
        public string Thumb { get; set; }
        public string Title { get; set; }
        public string Artist { get; set; }
        public string Source { get; set; }
        public string Size { get; set; }
        [System.Text.Json.Serialization.JsonIgnore] public double Duration { get; set; }
    }

    async Task<List<ArtCandidate>> AlbumCandidates(string artist, string title, int limit)
    {
        var all = new List<ArtCandidate>();
        all.AddRange(await DeezerAlbums(artist, title, limit));
        all.AddRange(await ITunes(artist, title, "album", "tw", limit));
        all.AddRange(await ITunes(artist, title, "album", "jp", limit));
        if (all.Count < 3) all.AddRange(await MusicBrainz(artist, title));
        return all;
    }

    async Task<List<ArtCandidate>> SongCandidates(string artist, string title, int limit)
    {
        var all = new List<ArtCandidate>();
        all.AddRange(await DeezerSongs(artist, title, limit));
        all.AddRange(await ITunes(artist, title, "song", "tw", limit));
        all.AddRange(await ITunes(artist, title, "song", "jp", limit));
        return all;
    }

    static async Task<JsonDocument> GetJson(string url, Action<System.Net.Http.HttpRequestMessage> setup = null)
    {
        using var req = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Get, url);
        setup?.Invoke(req);
        using var res = await Net.Http.SendAsync(req);
        if (!res.IsSuccessStatusCode) return null;
        var s = await res.Content.ReadAsStreamAsync();
        return await JsonDocument.ParseAsync(s);
    }

    static string Str(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    async Task<List<ArtCandidate>> ITunes(string artist, string title, string entity, string country, int limit)
    {
        var list = new List<ArtCandidate>();
        await _itunesGate.WaitAsync();
        try
        {
            // the Apple search API allows roughly 20 requests a minute
            var wait = TimeSpan.FromSeconds(2.6) - (DateTime.UtcNow - _lastITunes);
            if (wait > TimeSpan.Zero) await Task.Delay(wait);
            _lastITunes = DateTime.UtcNow;
            string term = Uri.EscapeDataString((artist + " " + title).Trim());
            using var doc = await GetJson($"https://itunes.apple.com/search?term={term}&entity={entity}&limit={limit}&country={country}");
            if (doc == null || !doc.RootElement.TryGetProperty("results", out var r)) return list;
            foreach (var e in r.EnumerateArray())
            {
                string art = Str(e, "artworkUrl100");
                if (art == null) continue;
                double dur = e.TryGetProperty("trackTimeMillis", out var tm) && tm.ValueKind == JsonValueKind.Number ? tm.GetDouble() / 1000 : 0;
                list.Add(new ArtCandidate
                {
                    Url = art.Replace("100x100bb", "1600x1600bb"),
                    Thumb = art.Replace("100x100bb", "300x300bb"),
                    Title = entity == "song" ? Str(e, "trackName") : Str(e, "collectionName"),
                    Artist = Str(e, "artistName"),
                    Source = "Apple Music" + (country == "jp" ? " JP" : ""),
                    Size = "1600px",
                    Duration = dur,
                });
            }
        }
        catch { }
        finally { _itunesGate.Release(); }
        return list;
    }

    static async Task<List<ArtCandidate>> DeezerAlbums(string artist, string title, int limit)
    {
        var list = new List<ArtCandidate>();
        try
        {
            string q = string.IsNullOrWhiteSpace(artist) ? title : $"artist:\"{artist}\" album:\"{title}\"";
            using var doc = await GetJson($"https://api.deezer.com/search/album?limit={limit}&q=" + Uri.EscapeDataString(q));
            if (doc == null || !doc.RootElement.TryGetProperty("data", out var data)) return list;
            foreach (var e in data.EnumerateArray())
            {
                string xl = Str(e, "cover_xl");
                if (xl == null || xl.Contains("/cover//")) continue;
                list.Add(new ArtCandidate { Url = xl, Thumb = Str(e, "cover_medium") ?? xl, Title = Str(e, "title"), Artist = e.TryGetProperty("artist", out var a) ? Str(a, "name") : null, Source = "Deezer", Size = "1000px" });
            }
        }
        catch { }
        return list;
    }

    static async Task<List<ArtCandidate>> DeezerSongs(string artist, string title, int limit)
    {
        var list = new List<ArtCandidate>();
        try
        {
            string q = string.IsNullOrWhiteSpace(artist) ? title : $"artist:\"{artist}\" track:\"{title}\"";
            using var doc = await GetJson($"https://api.deezer.com/search?limit={limit}&q=" + Uri.EscapeDataString(q));
            if (doc == null || !doc.RootElement.TryGetProperty("data", out var data)) return list;
            foreach (var e in data.EnumerateArray())
            {
                if (!e.TryGetProperty("album", out var al)) continue;
                string xl = Str(al, "cover_xl");
                if (xl == null || xl.Contains("/cover//")) continue;
                double dur = e.TryGetProperty("duration", out var d) && d.ValueKind == JsonValueKind.Number ? d.GetDouble() : 0;
                list.Add(new ArtCandidate { Url = xl, Thumb = Str(al, "cover_medium") ?? xl, Title = Str(e, "title"), Artist = e.TryGetProperty("artist", out var a) ? Str(a, "name") : null, Source = "Deezer · " + Str(al, "title"), Size = "1000px", Duration = dur });
            }
        }
        catch { }
        return list;
    }

    async Task<List<ArtCandidate>> MusicBrainz(string artist, string title)
    {
        var list = new List<ArtCandidate>();
        try
        {
            var wait = TimeSpan.FromSeconds(1.1) - (DateTime.UtcNow - _lastMusicBrainz);
            if (wait > TimeSpan.Zero) await Task.Delay(wait);
            _lastMusicBrainz = DateTime.UtcNow;
            string q = $"releasegroup:\"{title.Replace("\"", "")}\"" + (string.IsNullOrWhiteSpace(artist) ? "" : $" AND artist:\"{artist.Replace("\"", "")}\"");
            using var doc = await GetJson("https://musicbrainz.org/ws/2/release-group/?fmt=json&limit=8&query=" + Uri.EscapeDataString(q));
            if (doc == null || !doc.RootElement.TryGetProperty("release-groups", out var rgs)) return list;
            foreach (var e in rgs.EnumerateArray())
            {
                string name = null;
                if (e.TryGetProperty("artist-credit", out var ac) && ac.GetArrayLength() > 0) name = Str(ac[0], "name");
                string id = Str(e, "id");
                list.Add(new ArtCandidate { Url = $"https://coverartarchive.org/release-group/{id}/front-1200", Thumb = $"https://coverartarchive.org/release-group/{id}/front-250", Title = Str(e, "title"), Artist = name, Source = "MusicBrainz", Size = "1200px" });
            }
        }
        catch { }
        return list;
    }

    static async Task<bool> Download(string url, string target)
    {
        try
        {
            var bytes = await Net.Http.GetByteArrayAsync(url);
            if (bytes.Length < 2000) return false;
            using (var ms = new MemoryStream(bytes)) using (Image.FromStream(ms, false, true)) { } // validate
            await File.WriteAllBytesAsync(target, bytes);
            return true;
        }
        catch { return false; }
    }

    // ───────────────────────────── artist pictures ─────────────────────────────

    public Task<byte[]> ArtistAsync(string name, int size)
    {
        string id = Text.Hash("artist|" + Text.Norm(name));
        return Cached("r_" + id, size, () =>
        {
            string file = Path.Combine(AppPaths.OnlineArt, "r_" + id + ".jpg");
            if (File.Exists(file)) return File.ReadAllBytes(file);
            if (_s.ArtistImages && _s.OnlineArt) _ = FetchArtist(name, id, file);
            return null;
        });
    }

    Task<bool> FetchArtist(string name, string id, string target)
    {
        string miss = target + MissExt;
        if (RecentlyMissed(miss) || string.IsNullOrWhiteSpace(name) || name is "Various Artists" or "未知演出者") return Task.FromResult(false);
        return _onlineInflight.GetOrAdd(target, key => Task.Run(async () =>
        {
            await _online.WaitAsync();
            try
            {
                string url = null;
                using (var doc = await GetJson("https://api.deezer.com/search/artist?limit=8&q=" + Uri.EscapeDataString(name)))
                {
                    if (doc != null && doc.RootElement.TryGetProperty("data", out var data))
                    {
                        double best = 0;
                        foreach (var e in data.EnumerateArray())
                        {
                            string pic = Str(e, "picture_xl");
                            if (pic == null || pic.Contains("/artist//")) continue;
                            double s = Math.Max(Text.Similarity(name, Str(e, "name")), Text.Similarity(name, Str(e, "name"), false));
                            if (s >= 0.85 && s > best) { best = s; url = pic; }
                        }
                    }
                }
                bool ok = url != null && await Download(url, target);
                if (ok) { ForgetThumbs("r_" + id); Updated?.Invoke("artist", name); }
                else File.WriteAllText(miss, DateTime.UtcNow.ToString("o"));
                return ok;
            }
            catch { return false; }
            finally { _online.Release(); _onlineInflight.TryRemove(target, out var removed); }
        }));
    }
}
