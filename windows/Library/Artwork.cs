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
    static string OverridePath(string albumId) => Path.Combine(AppPaths.Art, "Override", "a_" + albumId + ".jpg");

    /// <summary>Raised when online artwork for an album or artist becomes available (kind, id).</summary>
    public event Action<string, string> Updated;

    public ArtworkService(MusicLibrary lib, Settings settings)
    {
        _lib = lib; _s = settings;
        _lib.TracksRead += Reread;
    }

    /// <summary>
    /// Tags read again (a scan found changed files, an album was re-read): the embedded picture or the folder picture
    /// may have changed, so drop the thumbnails made from the old one and tell the UI (Updated).
    /// </summary>
    void Reread(List<Track> tracks)
    {
        foreach (var id in tracks.Select(t => t.AlbumId).Where(id => id != null).Distinct())
        {
            ForgetThumbs("a_" + id);
            Updated?.Invoke("album", id);
        }
        // a folder without an album tag shows each track's own picture
        foreach (var t in tracks.Where(t => _lib.GetAlbum(t.AlbumId)?.Loose != false).Take(500))
        {
            ForgetThumbs("t_" + t.Id);
            Updated?.Invoke("track", t.Id);
        }
    }

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

    /// <summary>
    /// Version of the album picture rules; thumbnails made with other rules are dropped at start
    /// (<see cref="DropOldThumbs"/>) and the UI's picture URLs carry it (core.js ART_RULES).
    /// 2: the embedded picture wins over a picture file in the folder.
    /// </summary>
    public const int Rules = 2;

    /// <summary>Delete the cached thumbnails once after <see cref="Rules"/> changed: they are made again when needed.</summary>
    public static void DropOldThumbs()
    {
        string mark = Path.Combine(AppPaths.Thumbs, ".rules");
        try
        {
            if (File.Exists(mark) && File.ReadAllText(mark).Trim() == Rules.ToString()) return;
            foreach (var f in Directory.EnumerateFiles(AppPaths.Thumbs, "*.jpg")) { try { File.Delete(f); } catch { } }
            File.WriteAllText(mark, Rules.ToString());
        }
        catch (Exception ex) { Log.Error("Thumbs", ex); }
    }

    byte[] AlbumSource(string albumId)
    {
        var a = _lib.GetAlbum(albumId);
        if (a == null) return null;
        string ov = OverridePath(albumId);
        if (File.Exists(ov)) { try { return File.ReadAllBytes(ov); } catch { } }
        // the picture in the files first: it is what gets updated when the tags are edited, while an old cover.jpg
        // next to them often stays behind
        foreach (var t in a.Tracks.Where(t => t.HasPic).Take(3))
        {
            var b = TagReader.EmbeddedPicture(t);
            if (b != null && b.Length > 100) return b;
        }
        if (a.ArtPath != null) { try { return File.ReadAllBytes(a.ArtPath); } catch { } }
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

    static readonly int[] ThumbSizes = { 64, 128, 256, 384, 512, 768, 1024, 1600, 2400 };

    async Task<byte[]> Cached(string key, int size, Func<byte[]> source)
    {
        size = Math.Clamp(size <= 0 ? 600 : size, 32, 2400);
        // snap to a few sizes so the cache stays small
        size = Array.Find(ThumbSizes, s => s >= size);
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

    static string CleanArtist(string s) => Text.FirstArtist(s).Trim('【', '】', '[', ']', '(', ')').Trim();

    static readonly System.Text.RegularExpressions.Regex Bracketed = new(@"\s*[\(（\[【][^\)）\]】]*[\)）\]】]", System.Text.RegularExpressions.RegexOptions.Compiled);
    static readonly System.Text.RegularExpressions.Regex Joiners = new(@"\s*(?:,|、|&|＆|×|/|／|\bfeat\.?(?=\s)|\bft\.|\bwith\b)\s*", System.Text.RegularExpressions.RegexOptions.Compiled | System.Text.RegularExpressions.RegexOptions.IgnoreCase);

    /// <summary>
    /// The artist to put in a search: the first name only, without "(CV. 渡部優衣)" and the like. A credit such as
    /// "ウイニングチケット (CV. 渡部優衣), ナリタタイシン (CV. 渡部恵子) & ビワハヤヒデ (CV. 近藤 唯)" finds nothing as a whole.
    /// </summary>
    public static string SearchArtist(string s)
    {
        string first = Text.FirstArtist(s);
        string bare = Bracketed.Replace(first, "").Trim();
        if (bare.Length > 0) first = bare;
        string part = Joiners.Split(first).Select(p => p.Trim()).FirstOrDefault(p => p.Length > 0) ?? first;
        return part.Trim('【', '】', '[', ']', '(', ')').Trim();
    }

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
        if (a.Tracks.Any(t => t.HasPic)) return "embedded";
        if (a.ArtPath != null) return "folder";
        if (File.Exists(Path.Combine(AppPaths.OnlineArt, "a_" + albumId + ".jpg"))) return "online";
        if (a.Loose && a.Tracks.Count > 0 && File.Exists(Path.Combine(AppPaths.OnlineArt, "t_" + a.Tracks[0].Id + ".jpg"))) return "online";
        return "none";
    }

    /// <summary>
    /// Candidate pictures for the picker. <paramref name="part"/>: "albums" (album results, shown first), "songs"
    /// (song results for the first tracks, added after), or null for both. Every service is asked at the same time.
    /// </summary>
    public async Task<List<ArtCandidate>> Candidates(string albumId, string query, string part = null,
        Action<List<ArtCandidate>> onResults = null, CancellationToken ct = default)
    {
        var a = _lib.GetAlbum(albumId);
        bool albums = part != "songs", songs = part != "albums";
        var all = new List<ArtCandidate>();
        if (!string.IsNullOrWhiteSpace(query))
        {
            if (albums) all.AddRange(await AlbumCandidates("", query, 25, true, onResults, ct));
            ct.ThrowIfCancellationRequested();
            if (songs && (!albums || all.Select(c => c.Url).Distinct().Count() < 12))
                all.AddRange(await SongCandidates("", query, 15, true, onResults, ct));
        }
        else if (a != null)
        {
            string artist = SearchArtist(a.Artist);
            string title = a.Loose ? Path.GetFileName(a.Folder ?? "") : a.Title;
            if (albums)
            {
                all.AddRange(await AlbumCandidates(artist, title, 20, true, onResults, ct));
                ct.ThrowIfCancellationRequested();
                if (artist.Length > 0 && all.Select(c => c.Url).Distinct().Count() < 3)
                    all.AddRange(await AlbumCandidates("", title, 20, true, onResults, ct));
            }
            ct.ThrowIfCancellationRequested();
            if (songs && (!albums || all.Select(c => c.Url).Distinct().Count() < 12))
                all.AddRange((await Task.WhenAll(a.Tracks.Take(3).Select(t =>
                    SongCandidates(SearchArtist(t.Artist), t.Title, 8, true, onResults, ct)))).SelectMany(l => l));
        }
        // de-duplicate by image
        return all.Where(c => c.Url != null).GroupBy(c => c.Url).Select(g => g.First()).Take(60).ToList();
    }

    public async Task<bool> SetOverrideFromUrl(string albumId, string url)
    {
        var bytes = await Net.Http.GetByteArrayAsync(url);
        return SetOverride(albumId, bytes);
    }

    /// <summary>A picture the user picked, normalised: anything GDI+ can read (png, bmp, gif…) to a high quality JPEG, WebP etc. as-is.</summary>
    static byte[] UserPicture(byte[] bytes)
    {
        if (bytes == null || bytes.Length < 500) throw new InvalidOperationException("圖片太小或無效");
        byte[] data = bytes;
        try
        {
            using var ms = new MemoryStream(bytes);
            using var img = Image.FromStream(ms, false, true);
            if (img.Width < 50) throw new InvalidOperationException("圖片太小");
            data = Resize(bytes, Math.Min(3000, Math.Max(img.Width, img.Height))) ?? bytes;
        }
        catch (ArgumentException) { }
        return data;
    }

    public bool SetOverride(string albumId, byte[] bytes)
    {
        byte[] data = UserPicture(bytes);
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

    /// <summary>
    /// A new cover was written into the files (tag editor): drop the pictures MIKU keeps for the album itself (the
    /// user's override and the online one), which would hide it.
    /// </summary>
    public void DropStoredArt(string albumId)
    {
        var a = _lib.GetAlbum(albumId);
        try { File.Delete(OverridePath(albumId)); } catch { }
        try { File.Delete(Path.Combine(AppPaths.OnlineArt, "a_" + albumId + ".jpg")); } catch { }
        if (a != null && a.Tracks.Count > 0) try { File.Delete(Path.Combine(AppPaths.OnlineArt, "t_" + a.Tracks[0].Id + ".jpg")); } catch { }
        ForgetThumbs("a_" + albumId);
        Updated?.Invoke("album", albumId);
    }

    /// <summary>The album's id changed (its title was edited): the picture the user chose for it goes along.</summary>
    public void MoveStoredArt(string oldId, string newId)
    {
        if (oldId == null || newId == null || oldId == newId) return;
        foreach (var (from, to) in new[] { (OverridePath(oldId), OverridePath(newId)),
            (Path.Combine(AppPaths.OnlineArt, "a_" + oldId + ".jpg"), Path.Combine(AppPaths.OnlineArt, "a_" + newId + ".jpg")) })
            try { if (File.Exists(from) && !File.Exists(to)) File.Move(from, to); } catch { }
        ForgetThumbs("a_" + newId);
        Updated?.Invoke("album", newId);
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

    static async Task<List<ArtCandidate>> Collect(IEnumerable<Task<List<ArtCandidate>>> tasks, Action<List<ArtCandidate>> onResults)
    {
        var lists = await Task.WhenAll(tasks.Select(async task => {
            var batch = await task;
            if (batch.Count > 0) onResults?.Invoke(batch);
            return batch;
        }));
        return lists.SelectMany(l => l).ToList();
    }

    /// <summary>Album covers from Deezer and Apple Music (tw, jp), reported as each provider replies; MusicBrainz when they have little.</summary>
    async Task<List<ArtCandidate>> AlbumCandidates(string artist, string title, int limit, bool user = false,
        Action<List<ArtCandidate>> onResults = null, CancellationToken ct = default)
    {
        var all = await Collect(new[] { DeezerAlbums(artist, title, limit, user, ct),
            ITunes(artist, title, "album", "tw", limit, user, ct), ITunes(artist, title, "album", "jp", limit, user, ct) }, onResults);
        if (all.Count < 3 && !ct.IsCancellationRequested)
        {
            var extra = await MusicBrainz(artist, title, user, ct);
            if (extra.Count > 0) onResults?.Invoke(extra);
            all.AddRange(extra);
        }
        return all;
    }

    /// <summary>Covers of albums holding a song: Deezer and Apple Music; a search the user waits for asks only Apple's jp store (it has the same covers as tw, and Apple allows few requests).</summary>
    async Task<List<ArtCandidate>> SongCandidates(string artist, string title, int limit, bool user = false,
        Action<List<ArtCandidate>> onResults = null, CancellationToken ct = default)
    {
        var tasks = new List<Task<List<ArtCandidate>>> { DeezerSongs(artist, title, limit, user, ct), ITunes(artist, title, "song", "jp", limit, user, ct) };
        if (!user) tasks.Add(ITunes(artist, title, "song", "tw", limit, user, ct));
        return await Collect(tasks, onResults);
    }

    readonly ConcurrentDictionary<string, string> _dims = new();

    /// <summary>
    /// The real pixel size of candidate pictures ("1400×1400"), for the picker: read from the first bytes of each
    /// image (JPEG / PNG / WebP header), not the whole file. "" when unknown.
    /// </summary>
    public async Task<Dictionary<string, string>> Dimensions(IEnumerable<string> urls)
    {
        var list = urls.Where(u => u != null && (u.StartsWith("https://") || u.StartsWith("http://"))).Distinct().Take(80).ToList();
        using var gate = new SemaphoreSlim(8);
        var results = await Task.WhenAll(list.Select(async u =>
        {
            if (_dims.TryGetValue(u, out var known)) return (Url: u, Dim: known);
            await gate.WaitAsync();
            try
            {
                string d = await ReadDimensions(u);
                if (d != null) _dims[u] = d;
                return (Url: u, Dim: d ?? "");
            }
            finally { gate.Release(); }
        }));
        return results.ToDictionary(r => r.Url, r => r.Dim);
    }

    static async Task<string> ReadDimensions(string url)
    {
        try
        {
            using var req = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Get, url);
            req.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(0, 262143);
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            using var res = await Net.Http.SendAsync(req, System.Net.Http.HttpCompletionOption.ResponseHeadersRead, cts.Token);
            if (!res.IsSuccessStatusCode) return null;
            using var s = await res.Content.ReadAsStreamAsync(cts.Token);
            var buf = new byte[262144];
            int n = 0, r;
            // a server that ignores the range sends the whole picture: stop reading once the header is in
            while (n < buf.Length && (r = await s.ReadAsync(buf.AsMemory(n, buf.Length - n), cts.Token)) > 0)
            {
                n += r;
                if (ParseDimensions(buf, n) is { } wh) return $"{wh.W}×{wh.H}";
            }
            return ParseDimensions(buf, n) is { } last ? $"{last.W}×{last.H}" : null;
        }
        catch { return null; }
    }

    /// <summary>The bytes of the picture an album shows now (for writing it into the files), or null.</summary>
    public byte[] CurrentPicture(string albumId) => AlbumSource(albumId);

    /// <summary>The pixel size of the picture an album shows now ("1400×1400"), or null.</summary>
    public string SourceDims(string albumId)
    {
        try
        {
            var b = AlbumSource(albumId);
            return b != null && ParseDimensions(b, b.Length) is { } wh ? $"{wh.W}×{wh.H}" : null;
        }
        catch { return null; }
    }

    static (int W, int H)? ParseDimensions(byte[] b, int n)
    {
        // PNG: IHDR right after the signature
        if (n >= 24 && b[0] == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G')
            return ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19], (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]);
        // WebP (VP8 / VP8L / VP8X)
        if (n >= 30 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P')
        {
            if (b[12] == 'V' && b[13] == 'P' && b[14] == '8' && b[15] == ' ') return ((b[26] | (b[27] << 8)) & 0x3FFF, (b[28] | (b[29] << 8)) & 0x3FFF);
            if (b[12] == 'V' && b[13] == 'P' && b[14] == '8' && b[15] == 'L') { int v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return ((v & 0x3FFF) + 1, ((v >> 14) & 0x3FFF) + 1); }
            if (b[12] == 'V' && b[13] == 'P' && b[14] == '8' && b[15] == 'X') return (1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
            return null;
        }
        // JPEG: the frame header (SOFn) holds the size
        if (n >= 4 && b[0] == 0xFF && b[1] == 0xD8)
        {
            int i = 2;
            while (i + 9 < n)
            {
                if (b[i] != 0xFF) { i++; continue; }
                byte m = b[i + 1];
                if (m == 0xFF) { i++; continue; }
                if (m == 0xD8 || m == 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
                int len = (b[i + 2] << 8) | b[i + 3];
                if (m >= 0xC0 && m <= 0xCF && m != 0xC4 && m != 0xC8 && m != 0xCC)
                    return ((b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]);
                if (len < 2) return null;
                i += 2 + len;
            }
        }
        return null;
    }

    static async Task<JsonDocument> GetJson(string url, Action<System.Net.Http.HttpRequestMessage> setup = null, CancellationToken ct = default)
    {
        using var req = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Get, url);
        setup?.Invoke(req);
        using var res = await Net.Http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode) return null;
        using var s = await res.Content.ReadAsStreamAsync(ct);
        return await JsonDocument.ParseAsync(s, cancellationToken: ct);
    }

    static readonly ConcurrentDictionary<string, (DateTime expires, string json)> SearchCache = new();
    static async Task<JsonDocument> SearchJson(string url, RateGate gate, bool user, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (SearchCache.TryGetValue(url, out var cached) && cached.expires > DateTime.UtcNow)
            return JsonDocument.Parse(cached.json);
        // Background discovery can wait for its quota; only interactive searches cap that wait.
        if (gate != null && !user) await gate.WaitAsync(false, ct);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(user ? 8 : 15));
        if (gate != null && user) await gate.WaitAsync(true, deadline.Token);
        var doc = await GetJson(url, ct: deadline.Token);
        if (doc != null)
        {
            var root = doc.RootElement;
            if ((root.TryGetProperty("results", out var rows) || root.TryGetProperty("data", out rows) || root.TryGetProperty("release-groups", out rows))
                && rows.ValueKind == JsonValueKind.Array)
            {
                SearchCache[url] = (DateTime.UtcNow.AddSeconds(rows.GetArrayLength() > 0 ? 300 : 30), root.GetRawText());
                if (SearchCache.Count > 256)
                    foreach (var old in SearchCache.OrderBy(p => p.Value.expires).Take(SearchCache.Count - 256)) SearchCache.TryRemove(old.Key, out _);
            }
        }
        return doc;
    }

    static string Str(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    async Task<List<ArtCandidate>> ITunes(string artist, string title, string entity, string country, int limit, bool user = false, CancellationToken ct = default)
    {
        var list = new List<ArtCandidate>();
        try
        {
            // the Apple search API allows roughly 20 requests a minute (shared with the tag editor's searches)
            string term = Uri.EscapeDataString((artist + " " + title).Trim());
            using var doc = await SearchJson($"https://itunes.apple.com/search?term={term}&entity={entity}&limit={limit}&country={country}", RateGate.Apple, user, ct);
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
        return list;
    }

    static async Task<List<ArtCandidate>> DeezerAlbums(string artist, string title, int limit, bool user = false, CancellationToken ct = default)
    {
        var list = new List<ArtCandidate>();
        try
        {
            string q = string.IsNullOrWhiteSpace(artist) ? title : $"artist:\"{artist}\" album:\"{title}\"";
            using var doc = await SearchJson($"https://api.deezer.com/search/album?limit={limit}&q=" + Uri.EscapeDataString(q), null, user, ct);
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

    static async Task<List<ArtCandidate>> DeezerSongs(string artist, string title, int limit, bool user = false, CancellationToken ct = default)
    {
        var list = new List<ArtCandidate>();
        try
        {
            string q = string.IsNullOrWhiteSpace(artist) ? title : $"artist:\"{artist}\" track:\"{title}\"";
            using var doc = await SearchJson($"https://api.deezer.com/search?limit={limit}&q=" + Uri.EscapeDataString(q), null, user, ct);
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

    async Task<List<ArtCandidate>> MusicBrainz(string artist, string title, bool user = false, CancellationToken ct = default)
    {
        var list = new List<ArtCandidate>();
        try
        {
            string q = $"releasegroup:\"{title.Replace("\"", "")}\"" + (string.IsNullOrWhiteSpace(artist) ? "" : $" AND artist:\"{artist.Replace("\"", "")}\"");
            using var doc = await SearchJson("https://musicbrainz.org/ws/2/release-group/?fmt=json&limit=8&query=" + Uri.EscapeDataString(q), RateGate.MusicBrainz, user, ct);
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

    static string ArtistId(string name) => Text.Hash("artist|" + Text.Norm(name));
    static string ArtistOverridePath(string id) => Path.Combine(AppPaths.Art, "Override", "r_" + id + ".jpg");

    public Task<byte[]> ArtistAsync(string name, int size)
    {
        string id = ArtistId(name);
        return Cached("r_" + id, size, () =>
        {
            string ov = ArtistOverridePath(id);
            if (File.Exists(ov)) { try { return File.ReadAllBytes(ov); } catch { } }
            string file = Path.Combine(AppPaths.OnlineArt, "r_" + id + ".jpg");
            if (File.Exists(file)) return File.ReadAllBytes(file);
            if (_s.ArtistImages && _s.OnlineArt) _ = FetchArtist(name, id, file);
            return null;
        });
    }

    /// <summary>Where the artist picture comes from: override | online | none.</summary>
    public string ArtistSourceOf(string name)
    {
        string id = ArtistId(name);
        if (File.Exists(ArtistOverridePath(id))) return "override";
        if (File.Exists(Path.Combine(AppPaths.OnlineArt, "r_" + id + ".jpg"))) return "online";
        return "none";
    }

    /// <summary>
    /// Candidate pictures for the artist picker: Deezer artist photos (the source of the automatic picture), then
    /// album covers by the artist (Apple Music / Deezer), e.g. for artists Deezer has no photo of.
    /// </summary>
    public async Task<List<ArtCandidate>> ArtistCandidates(string name, string query,
        Action<List<ArtCandidate>> onResults = null, CancellationToken ct = default)
    {
        string q = string.IsNullOrWhiteSpace(query) ? CleanArtist(name) : query.Trim();
        if (q == "") return new();
        async Task<List<ArtCandidate>> Photos()
        {
            var list = new List<ArtCandidate>();
            try
            {
                using var doc = await SearchJson("https://api.deezer.com/search/artist?limit=25&q=" + Uri.EscapeDataString(q), null, true, ct);
                if (doc != null && doc.RootElement.TryGetProperty("data", out var data))
                    foreach (var e in data.EnumerateArray())
                    {
                        string pic = Str(e, "picture_xl");
                        if (pic == null || pic.Contains("/artist//")) continue;
                        int fans = e.TryGetProperty("nb_fan", out var f) && f.TryGetInt32(out var n) ? n : 0;
                        list.Add(new ArtCandidate { Url = pic, Thumb = Str(e, "picture_medium") ?? pic, Title = Str(e, "name"), Artist = fans > 0 ? $"{fans:N0} 位粉絲" : "", Source = "Deezer", Size = "1000×1000" });
                    }
            }
            catch { }
            if (list.Count > 0) onResults?.Invoke(list);
            return list;
        }
        var list = (await Task.WhenAll(Photos(), AlbumCandidates("", q, 20, true, onResults, ct))).SelectMany(l => l);
        return list.Where(c => c.Url != null).GroupBy(c => c.Url).Select(g => g.First()).Take(60).ToList();
    }

    public async Task<bool> SetArtistOverrideFromUrl(string name, string url) => SetArtistOverride(name, await Net.Http.GetByteArrayAsync(url));

    public bool SetArtistOverride(string name, byte[] bytes)
    {
        byte[] data = UserPicture(bytes);
        string id = ArtistId(name), path = ArtistOverridePath(id);
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        File.WriteAllBytes(path, data);
        ForgetThumbs("r_" + id);
        Updated?.Invoke("artist", name);
        return true;
    }

    /// <summary>Back to the automatic picture: drop the user's one, and search online again if there was none.</summary>
    public void ClearArtistOverride(string name)
    {
        string id = ArtistId(name);
        try { File.Delete(ArtistOverridePath(id)); } catch { }
        try { File.Delete(Path.Combine(AppPaths.OnlineArt, "r_" + id + ".jpg" + MissExt)); } catch { }
        ForgetThumbs("r_" + id);
        Updated?.Invoke("artist", name);
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
