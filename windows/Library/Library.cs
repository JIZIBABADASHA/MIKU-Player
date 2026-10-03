using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Miku.Audio;

namespace Miku.Library;

public sealed class LibraryCache
{
    public int Version { get; set; } = 1;
    public List<Track> Tracks { get; set; } = new();
    public Dictionary<string, string> FolderArt { get; set; } = new();
}

public sealed class ScanProgress
{
    public bool Scanning { get; set; }
    public int Found { get; set; }
    public int Done { get; set; }
    public int Failed { get; set; }
    public string Current { get; set; }
    [System.Text.Json.Serialization.JsonIgnore] public int FailedRef;
}

public sealed class MusicLibrary
{
    public static readonly HashSet<string> Extensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".flac", ".wav", ".mp3", ".m4a", ".aac", ".alac", ".aif", ".aiff", ".aifc", ".ogg", ".oga", ".opus",
        ".wma", ".ape", ".wv", ".dsf", ".dff", ".tak", ".tta", ".mka", ".mp2", ".caf",
    };
    static readonly string[] ArtNames = { "cover", "folder", "front", "albumart", "album", "artwork", "jacket", "albumartsmall" };
    static readonly Regex DiscFolder = new(@"^(cd|disc|disk|dvd)\s*[-_.]?\s*\d+\b.*$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    readonly Settings _settings;
    readonly object _lock = new();
    Dictionary<string, Track> _byId = new();
    Dictionary<string, Album> _albums = new();
    Dictionary<string, string> _folderArt = new(StringComparer.OrdinalIgnoreCase);
    CancellationTokenSource _scanCts;

    public ScanProgress Progress { get; private set; } = new();
    public event Action Changed;
    public event Action<ScanProgress> ProgressChanged;
    public int Revision { get; private set; }

    public MusicLibrary(Settings settings) { _settings = settings; }

    public Track GetTrack(string id) { lock (_lock) return id != null && _byId.TryGetValue(id, out var t) ? t : null; }
    public Album GetAlbum(string id) { lock (_lock) return id != null && _albums.TryGetValue(id, out var a) ? a : null; }
    public List<Album> Albums { get { lock (_lock) return _albums.Values.ToList(); } }
    public int Count { get { lock (_lock) return _byId.Count; } }
    public List<Track> AllTracks { get { lock (_lock) return _byId.Values.ToList(); } }

    public void Load()
    {
        var cache = Json.Load<LibraryCache>(AppPaths.Library);
        Build(cache.Tracks, cache.FolderArt);
    }

    void Save(List<Track> tracks)
    {
        try { Json.SaveAtomic(AppPaths.Library, new LibraryCache { Tracks = tracks, FolderArt = new Dictionary<string, string>(_folderArt) }); }
        catch (Exception ex) { Log.Error("Save library", ex); }
    }

    // ───────────────────────────── grouping ─────────────────────────────

    static string AlbumFolder(string path)
    {
        string dir = Path.GetDirectoryName(path) ?? "";
        string name = Path.GetFileName(dir);
        if (DiscFolder.IsMatch(name)) dir = Path.GetDirectoryName(dir) ?? dir;
        return dir;
    }

    void Build(List<Track> tracks, Dictionary<string, string> folderArt)
    {
        var albums = new Dictionary<string, Album>();
        var byId = new Dictionary<string, Track>();
        foreach (var t in tracks)
        {
            if (t?.Path == null) continue;
            t.Id ??= Text.Hash(t.Path.ToLowerInvariant());
            byId[t.Id] = t;
            string folder = AlbumFolder(t.Path);
            bool loose = string.IsNullOrWhiteSpace(t.Album);
            string title = loose ? Path.GetFileName(folder) : t.Album.Trim();
            string key = folder.ToLowerInvariant() + "|" + Text.Norm(title);
            string id = Text.Hash(key);
            if (!albums.TryGetValue(id, out var a))
            {
                a = new Album { Id = id, Title = string.IsNullOrWhiteSpace(title) ? "未知專輯" : title, Folder = folder, Loose = loose };
                albums[id] = a;
            }
            t.AlbumId = id;
            a.Tracks.Add(t);
        }
        // album level fields
        var albumsPerFolder = albums.Values.GroupBy(a => a.Folder, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.Count(), StringComparer.OrdinalIgnoreCase);
        foreach (var a in albums.Values)
        {
            a.Tracks.Sort((x, y) =>
            {
                int c = x.DiscNo.CompareTo(y.DiscNo);
                if (c != 0) return c;
                c = x.TrackNo.CompareTo(y.TrackNo);
                return c != 0 ? c : string.Compare(Path.GetFileName(x.Path), Path.GetFileName(y.Path), StringComparison.OrdinalIgnoreCase);
            });
            var albumArtists = a.Tracks.Select(t => t.AlbumArtist).Where(s => !string.IsNullOrWhiteSpace(s)).GroupBy(s => s).OrderByDescending(g => g.Count()).FirstOrDefault()?.Key;
            if (albumArtists == null)
            {
                var artists = a.Tracks.Select(t => t.Artist).Where(s => !string.IsNullOrWhiteSpace(s)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                albumArtists = artists.Count == 1 ? artists[0] : artists.Count == 0 ? "未知演出者" : (a.Loose ? artists.GroupBy(s => s).OrderByDescending(g => g.Count()).First().Key : "Various Artists");
            }
            a.Artist = albumArtists;
            a.Year = a.Tracks.Select(t => t.Year).Where(y => y > 0).DefaultIfEmpty(0).Min();
            a.Genre = a.Tracks.Select(t => t.Genre).FirstOrDefault(g => !string.IsNullOrWhiteSpace(g)) ?? "";
            a.Added = a.Tracks.Max(t => t.Mtime);
            // A folder image only belongs to the album if the folder holds just one album.
            if (albumsPerFolder.TryGetValue(a.Folder, out int n) && n == 1 && folderArt.TryGetValue(a.Folder, out var art)) a.ArtPath = art;
            else if (folderArt.TryGetValue(Path.GetDirectoryName(a.Tracks[0].Path) ?? "", out var art2) && albumsPerFolder.GetValueOrDefault(a.Folder) == 1) a.ArtPath = art2;
        }
        lock (_lock)
        {
            _byId = byId;
            _albums = albums;
            _folderArt = new Dictionary<string, string>(folderArt, StringComparer.OrdinalIgnoreCase);
            Revision++;
        }
    }

    // ───────────────────────────── scanning ─────────────────────────────

    public void StartScan(bool full = false)
    {
        _scanCts?.Cancel();
        var cts = _scanCts = new CancellationTokenSource();
        Task.Run(() => Scan(full, cts.Token));
    }

    void Report(ScanProgress p) { Progress = p; ProgressChanged?.Invoke(p); }

    void Scan(bool full, CancellationToken ct)
    {
        var p = new ScanProgress { Scanning = true };
        Report(p);
        try
        {
            Dictionary<string, Track> existing;
            lock (_lock) existing = _byId.Values.ToDictionary(t => t.Path, StringComparer.OrdinalIgnoreCase);
            var files = new List<FileInfo>();
            var folderArt = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var offlineRoots = new List<string>();
            foreach (var root in _settings.Folders.ToList())
            {
                if (!Directory.Exists(root)) { offlineRoots.Add(root); continue; }
                Walk(new DirectoryInfo(root), files, folderArt, ct, p);
            }
            p.Found = files.Count;
            Report(p);

            var result = new ConcurrentBag<Track>();
            var todo = new List<FileInfo>();
            foreach (var f in files)
            {
                if (!full && existing.TryGetValue(f.FullName, out var old) && old.Size == f.Length && old.Mtime == f.LastWriteTimeUtc.Ticks
                    && !TagReader.NeedsReread(old))
                    result.Add(old);
                else todo.Add(f);
            }
            // keep tracks from folders that are temporarily offline (e.g. unplugged drive)
            foreach (var t in existing.Values)
                if (offlineRoots.Any(r => t.Path.StartsWith(r, StringComparison.OrdinalIgnoreCase))) result.Add(t);

            p.Done = result.Count;
            Report(p);
            int done = 0, lastReport = Environment.TickCount;
            long lastPublish = Environment.TickCount64;
            object publishLock = new();
            Parallel.ForEach(todo, new ParallelOptions { MaxDegreeOfParallelism = Math.Clamp(Environment.ProcessorCount / 2, 2, 6), CancellationToken = ct }, f =>
            {
                var t = TagReader.Read(f);
                if (t != null) result.Add(t); else Interlocked.Increment(ref p.FailedRef);
                int d = Interlocked.Increment(ref done);
                // publish partial results so a huge first scan shows up progressively and survives a restart
                if (Environment.TickCount64 - lastPublish > 15000 && Monitor.TryEnter(publishLock))
                {
                    try
                    {
                        if (Environment.TickCount64 - lastPublish > 15000)
                        {
                            lastPublish = Environment.TickCount64;
                            var partial = result.ToList();
                            Build(partial, folderArt);
                            Save(partial);
                            Changed?.Invoke();
                        }
                    }
                    finally { Monitor.Exit(publishLock); }
                }
                if (Environment.TickCount - lastReport > 250)
                {
                    lastReport = Environment.TickCount;
                    p.Done = result.Count; p.Current = f.Name; p.Failed = p.FailedRef;
                    Report(p);
                }
            });
            var list = result.ToList();
            bool changed = todo.Count > 0 || list.Count != existing.Count;
            if (changed || full)
            {
                Build(list, folderArt);
                Save(list);
                Changed?.Invoke();
            }
            else if (!folderArt.SequenceEqual(_folderArt))
            {
                Build(list, folderArt);
                Save(list);
                Changed?.Invoke();
            }
            p.Done = list.Count; p.Failed = p.FailedRef;
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { Log.Error("Scan", ex); }
        finally
        {
            p.Scanning = false; p.Current = null;
            Report(p);
        }
    }

    static void Walk(DirectoryInfo dir, List<FileInfo> files, Dictionary<string, string> folderArt, CancellationToken ct, ScanProgress p)
    {
        ct.ThrowIfCancellationRequested();
        FileInfo[] entries;
        try { entries = dir.GetFiles(); } catch { return; }
        FileInfo bestArt = null; int bestRank = int.MaxValue;
        var images = new List<FileInfo>();
        foreach (var f in entries)
        {
            if ((f.Attributes & (FileAttributes.Hidden | FileAttributes.System)) != 0) continue;
            string ext = f.Extension;
            if (Extensions.Contains(ext)) { files.Add(f); continue; }
            if (ext.Equals(".jpg", StringComparison.OrdinalIgnoreCase) || ext.Equals(".jpeg", StringComparison.OrdinalIgnoreCase) || ext.Equals(".png", StringComparison.OrdinalIgnoreCase) || ext.Equals(".webp", StringComparison.OrdinalIgnoreCase))
            {
                images.Add(f);
                string stem = Path.GetFileNameWithoutExtension(f.Name).ToLowerInvariant();
                int rank = Array.FindIndex(ArtNames, n => stem == n || stem.StartsWith(n + " ") || stem.StartsWith(n + "_") || stem.StartsWith(n + "-") || stem.StartsWith(n + "."));
                if (rank < 0 && stem.Contains("cover")) rank = 20;
                if (rank >= 0 && (rank < bestRank || (rank == bestRank && f.Length > bestArt.Length))) { bestRank = rank; bestArt = f; }
            }
        }
        if (bestArt == null && images.Count == 1 && images[0].Length > 15_000) bestArt = images[0];
        if (bestArt != null) folderArt[dir.FullName] = bestArt.FullName;
        if (files.Count - p.Found > 500) { p.Found = files.Count; }
        DirectoryInfo[] subs;
        try { subs = dir.GetDirectories(); } catch { return; }
        foreach (var s in subs)
        {
            if ((s.Attributes & (FileAttributes.Hidden | FileAttributes.System | FileAttributes.ReparsePoint)) != 0) continue;
            Walk(s, files, folderArt, ct, p);
        }
    }

    // ───────────────────────────── export for the UI ─────────────────────────────

    /// <summary>Compact JSON payload: arrays instead of objects keep 30k+ tracks small and fast to parse.</summary>
    public byte[] ExportJson()
    {
        List<Album> albums;
        lock (_lock) albums = _albums.Values.ToList();
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms, new JsonWriterOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
        {
            w.WriteStartObject();
            w.WriteNumber("revision", Revision);
            w.WriteStartArray("albums");
            foreach (var a in albums)
            {
                // [id, title, artist, year, genre, added, hasLocalArt, loose]
                w.WriteStartArray();
                w.WriteStringValue(a.Id); w.WriteStringValue(a.Title); w.WriteStringValue(a.Artist);
                w.WriteNumberValue(a.Year); w.WriteStringValue(a.Genre); w.WriteNumberValue(a.Added / TimeSpan.TicksPerSecond);
                w.WriteNumberValue(a.ArtPath != null || a.Tracks.Any(t => t.HasPic) ? 1 : 0);
                w.WriteNumberValue(a.Loose ? 1 : 0);
                w.WriteEndArray();
            }
            w.WriteEndArray();
            w.WriteStartArray("tracks");
            foreach (var a in albums)
            {
                foreach (var t in a.Tracks)
                {
                    // [id, title, artist, albumId, disc, no, duration, codec, rate, bits, year, composer]
                    w.WriteStartArray();
                    w.WriteStringValue(t.Id); w.WriteStringValue(t.Title); w.WriteStringValue(t.Artist); w.WriteStringValue(a.Id);
                    w.WriteNumberValue(t.DiscNo); w.WriteNumberValue(t.TrackNo); w.WriteNumberValue(Math.Round(t.Duration, 2));
                    w.WriteStringValue(t.Codec); w.WriteNumberValue(t.SampleRate); w.WriteNumberValue(t.Bits); w.WriteNumberValue(t.Year);
                    w.WriteStringValue(t.Composer ?? "");
                    w.WriteEndArray();
                }
            }
            w.WriteEndArray();
            w.WriteEndObject();
        }
        return ms.ToArray();
    }
}

public static class TagReader
{
    static readonly Regex LeadingNumber = new(@"^\s*(\d{1,3})\s*[-_. ]\s*(.+)$", RegexOptions.Compiled);

    public static Track Read(FileInfo f)
    {
        var t = new Track
        {
            Path = f.FullName,
            Id = Text.Hash(f.FullName.ToLowerInvariant()),
            Size = f.Length,
            Mtime = f.LastWriteTimeUtc.Ticks,
            Codec = CodecFromExt(f.Extension),
        };
        string ext = f.Extension.ToLowerInvariant();
        bool ok = false;
        if (ext == ".dsf" || ext == ".dff") ok = ReadDsd(f, t);
        if (!ok)
        {
            try
            {
                using var file = TagLib.File.Create(f.FullName, TagLib.ReadStyle.Average);
                ApplyTag(t, file.Tag);
                if (file is TagLib.Riff.File riff) FixRiffInfo(t, riff);
                var props = file.Properties;
                if (props != null)
                {
                    t.Duration = props.Duration.TotalSeconds;
                    t.SampleRate = props.AudioSampleRate;
                    t.Bits = props.BitsPerSample;
                    t.Channels = props.AudioChannels > 0 ? props.AudioChannels : 2;
                    t.Bitrate = props.AudioBitrate;
                    if (ext == ".m4a" || ext == ".mp4")
                    {
                        string desc = string.Join(" ", props.Codecs.Where(c => c != null).Select(c => c.Description ?? ""));
                        t.Codec = desc.Contains("ALAC", StringComparison.OrdinalIgnoreCase) || desc.Contains("Lossless", StringComparison.OrdinalIgnoreCase) || t.Bits > 0 ? "ALAC" : "AAC";
                    }
                }
                ok = true;
            }
            catch (Exception ex)
            {
                if (ext != ".dsf" && ext != ".dff") Log.Info($"TagLib failed {f.FullName}: {ex.Message}");
            }
        }
        if (!ok || t.Duration <= 0) ProbeFallback(t);
        if (string.IsNullOrWhiteSpace(t.Title))
        {
            string stem = Path.GetFileNameWithoutExtension(f.Name);
            var m = LeadingNumber.Match(stem);
            if (m.Success) { t.Title = m.Groups[2].Value.Trim(); if (t.TrackNo == 0) t.TrackNo = int.Parse(m.Groups[1].Value); }
            else t.Title = stem;
        }
        if (t.TrackNo == 0)
        {
            var m = LeadingNumber.Match(Path.GetFileNameWithoutExtension(f.Name));
            if (m.Success) t.TrackNo = int.Parse(m.Groups[1].Value);
        }
        if (string.IsNullOrWhiteSpace(t.Artist)) t.Artist = string.IsNullOrWhiteSpace(t.AlbumArtist) ? "" : t.AlbumArtist;
        if (t.DiscNo == 0) t.DiscNo = 1;
        return t;
    }

    static void ApplyTag(Track t, TagLib.Tag tag)
    {
        if (tag == null) return;
        t.Title = Clean(tag.Title);
        t.Artist = Clean(tag.JoinedPerformers);
        t.AlbumArtist = Clean(tag.JoinedAlbumArtists);
        t.Album = Clean(tag.Album);
        t.Genre = Clean(tag.JoinedGenres);
        t.Composer = Clean(tag.JoinedComposers);
        t.Year = (int)tag.Year;
        t.TrackNo = (int)tag.Track;
        t.DiscNo = (int)tag.Disc;
        try { t.HasPic = tag.Pictures != null && tag.Pictures.Length > 0; } catch { }
        try
        {
            if (!double.IsNaN(tag.ReplayGainTrackGain) && tag.ReplayGainTrackGain != 0) t.RgTrack = tag.ReplayGainTrackGain;
            if (!double.IsNaN(tag.ReplayGainAlbumGain) && tag.ReplayGainAlbumGain != 0) t.RgAlbum = tag.ReplayGainAlbumGain;
        }
        catch { }
    }

    static string Clean(string s) => string.IsNullOrWhiteSpace(s) ? "" : s.Replace('\0', ' ').Trim();

    // ───────────────────────────── WAV (RIFF INFO) ─────────────────────────────

    static TagReader() { Encoding.RegisterProvider(CodePagesEncodingProvider.Instance); }

    /// <summary>
    /// WAV files read before the RIFF INFO fixes whose tags came out garbled (U+FFFD) or with '?' for lost characters:
    /// read them again on the next scan even though the file itself didn't change. (Not for a missing album: most WAVs
    /// without one simply have no tags, and they would be read again on every scan. A WAV whose tag really contains '?'
    /// is read again on each scan; there are few of them.)
    /// </summary>
    public static bool NeedsReread(Track t)
    {
        string all = $"{t.Title}{t.Artist}{t.AlbumArtist}{t.Album}{t.Genre}{t.Composer}";
        // any format: tags from the ffprobe fallback read before it was decoded as UTF-8 (UTF-8 read as Big5 etc.
        // gives private-use characters, "未来古代楽団" → "?芣?支誨璆賢"; real tags hardly ever have them)
        return (t.Codec == "WAV" && all.AsSpan().IndexOfAny('�', '?') >= 0) || all.Any(c => c >= '' && c <= '');
    }

    /// <summary>
    /// RIFF INFO text is usually written in the system ANSI code page (Big5, Shift-JIS, GBK…), but TagLib decodes it as
    /// UTF-8, so CJK text from INFO comes out as U+FFFD (e.g. album artist "vip店長" → "vip����"; TagLib maps INFO IART
    /// to the album artist). ID3 values are fine and are kept; a value that was filled from INFO and came out garbled is
    /// decoded again from the raw bytes. TagLib doesn't read the album from INFO at all (IPRD): use it when there is no
    /// other album.
    /// Tagging programs also write INFO in a code page that can't hold every character and store each missing one as
    /// '?' (Big5: "獅子神レオナ" → "獅子神???", "さユり" → "???"). Such a value from INFO is replaced by a correct value of
    /// the same file that fits it, one character per '?' (the ID3 artist, title…, or a folder / file name: Roon shows
    /// the ID3 text of these files); with nothing that fits, a value that is mostly '?' is dropped (the artist, album
    /// artist and title then fall back to each other / the file name), except the album, which groups the tracks.
    /// </summary>
    static void FixRiffInfo(Track t, TagLib.Riff.File riff)
    {
        if (riff.GetTag(TagLib.TagTypes.RiffInfo, false) is not TagLib.Riff.InfoTag info) return;
        string Info(string id)
        {
            foreach (TagLib.ByteVector v in info.GetValues(TagLib.ByteVector.FromString(id, TagLib.StringType.Latin1)))
            {
                string s = Clean(DecodeInfo(v.Data));
                if (s != "") return s;
            }
            return "";
        }
        static bool Garbled(string s) => s.Contains('�');
        if (Garbled(t.Title)) t.Title = Info("INAM");
        if (Garbled(t.Artist)) t.Artist = Info("ISTR");
        if (Garbled(t.AlbumArtist)) t.AlbumArtist = Info("IART");
        if (Garbled(t.Genre)) t.Genre = Info("IGNR");
        if (Garbled(t.Composer)) t.Composer = Info("IWRI");
        if (t.Album == "") t.Album = Info("IPRD");

        // '?' for characters the code page couldn't hold: only in values that came from INFO (ID3 is Unicode)
        var id3 = riff.GetTag(TagLib.TagTypes.Id3v2, false);
        static string Id3(TagLib.Tag tag, Func<TagLib.Tag, string> get) => tag == null ? "" : Clean(get(tag));
        var dirs = Path.GetDirectoryName(t.Path)?.Split(Path.DirectorySeparatorChar) ?? Array.Empty<string>();
        var known = new[] { t.Artist, t.AlbumArtist, t.Title, t.Album, t.Composer, Path.GetFileNameWithoutExtension(t.Path) }
            .Concat(dirs.Reverse().Take(4)).Where(s => s != "" && !s.Contains('?')).ToList();
        var knownParts = known.SelectMany(k => k.Split(new[] { ';', '/' }, StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)).ToList();
        static string Fit(string s, List<string> candidates)
        {
            var fit = new Regex("^" + string.Concat(s.Select(c => c == '?' ? "." : Regex.Escape(c.ToString()))) + "$");
            return candidates.FirstOrDefault(fit.IsMatch);
        }
        string Fix(string s, string fromId3, bool drop)
        {
            if (!s.Contains('?') || s == fromId3) return s;
            if (Fit(s, known) is string whole) return whole;
            // several names whose separators differ between INFO and ID3 ("和氣??未/高野麻里佳" vs "和氣あず未; 高野麻里佳")
            var parts = Regex.Split(s, @"(\s*[;/]\s*)");
            if (parts.Length > 1)
            {
                for (int i = 0; i < parts.Length; i += 2)
                    if (parts[i].Contains('?') && Fit(parts[i], knownParts) is string p) parts[i] = p;
                if (parts.Where((_, i) => i % 2 == 0).All(p => !p.Contains('?'))) return string.Concat(parts);
            }
            return drop && Lost(s) ? "" : s;
        }
        t.Title = Fix(t.Title, Id3(id3, g => g.Title), true);
        t.Artist = Fix(t.Artist, Id3(id3, g => g.JoinedPerformers), true);
        t.AlbumArtist = Fix(t.AlbumArtist, Id3(id3, g => g.JoinedAlbumArtists), true);
        t.Album = Fix(t.Album, Id3(id3, g => g.Album), false);
        t.Genre = Fix(t.Genre, Id3(id3, g => g.JoinedGenres), true);
        t.Composer = Fix(t.Composer, Id3(id3, g => g.JoinedComposers), true);
    }

    /// <summary>Mostly '?': two or more making up at least half of the text, or a run of three.</summary>
    static bool Lost(string s)
    {
        int q = s.Count(c => c == '?');
        return q >= 2 && (q * 2 >= s.Count(c => !char.IsWhiteSpace(c)) || s.Contains("???"));
    }

    /// <summary>Text from a RIFF INFO chunk: UTF-8 when it is valid UTF-8, otherwise the system ANSI code page.</summary>
    static string DecodeInfo(byte[] raw)
    {
        int n = Array.IndexOf(raw, (byte)0);
        if (n < 0) n = raw.Length;
        try { return new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(raw, 0, n); }
        catch (DecoderFallbackException) { }
        try { return Encoding.GetEncoding(System.Globalization.CultureInfo.CurrentCulture.TextInfo.ANSICodePage).GetString(raw, 0, n); }
        catch { return Encoding.Latin1.GetString(raw, 0, n); }
    }

    static bool ReadDsd(FileInfo f, Track t)
    {
        try
        {
            var info = DsdInfo.Read(f.FullName);
            t.SampleRate = info.Rate;
            t.Bits = 1;
            t.Channels = info.Channels;
            t.Duration = info.Duration;
            if (info.Id3Offset > 0 && info.Id3Length > 10)
            {
                using var fs = new FileStream(f.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                fs.Position = info.Id3Offset;
                var buf = new byte[Math.Min(info.Id3Length, 64 * 1024 * 1024)];
                int n = fs.Read(buf, 0, buf.Length);
                if (n > 10 && buf[0] == 'I' && buf[1] == 'D' && buf[2] == '3')
                {
                    var tag = new TagLib.Id3v2.Tag(new TagLib.ByteVector(buf, n));
                    ApplyTag(t, tag);
                }
            }
            return t.Duration > 0;
        }
        catch (Exception ex)
        {
            Log.Info($"DSD header failed {f.FullName}: {ex.Message}");
            return false;
        }
    }

    static void ProbeFallback(Track t)
    {
        try
        {
            using var p = Ffmpeg.Start(new[] { "-v", "error", "-show_entries", "format=duration:stream=sample_rate,channels,bits_per_raw_sample:format_tags=title,artist,album,album_artist,track,disc,date,genre",
                "-select_streams", "a:0", "-of", "json", t.Path }, Ffmpeg.ProbePath);
            string json = p.StandardOutput.ReadToEnd();
            p.WaitForExit(5000);
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.TryGetProperty("format", out var fmt))
            {
                if (fmt.TryGetProperty("duration", out var d) && double.TryParse(d.GetString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var dur)) t.Duration = dur;
                if (fmt.TryGetProperty("tags", out var tags))
                {
                    foreach (var prop in tags.EnumerateObject())
                    {
                        string v = prop.Value.GetString() ?? "";
                        switch (prop.Name.ToLowerInvariant())
                        {
                            case "title": if (t.Title == "" || t.Title.Contains('\uFFFD')) t.Title = v; break;
                            case "artist": if (t.Artist == "" || t.Artist.Contains('\uFFFD')) t.Artist = v; break;
                            case "album": if (t.Album == "" || t.Album.Contains('\uFFFD')) t.Album = v; break;
                            case "album_artist": if (t.AlbumArtist == "" || t.AlbumArtist.Contains('\uFFFD')) t.AlbumArtist = v; break;
                            case "genre": if (t.Genre == "" || t.Genre.Contains('\uFFFD')) t.Genre = v; break;
                            case "track": if (t.TrackNo == 0 && int.TryParse(v.Split('/')[0], out var tn)) t.TrackNo = tn; break;
                            case "disc": if (t.DiscNo == 0 && int.TryParse(v.Split('/')[0], out var dn)) t.DiscNo = dn; break;
                            case "date": if (t.Year == 0 && v.Length >= 4 && int.TryParse(v[..4], out var y)) t.Year = y; break;
                        }
                    }
                }
            }
            if (root.TryGetProperty("streams", out var streams) && streams.GetArrayLength() > 0)
            {
                var s = streams[0];
                if (t.SampleRate == 0 && s.TryGetProperty("sample_rate", out var sr) && int.TryParse(sr.GetString(), out var r)) t.SampleRate = r;
                if (s.TryGetProperty("channels", out var ch) && ch.TryGetInt32(out var c)) t.Channels = c;
                if (t.Bits == 0 && s.TryGetProperty("bits_per_raw_sample", out var b) && int.TryParse(b.GetString(), out var bits)) t.Bits = bits;
            }
        }
        catch (Exception ex) { Log.Info($"ffprobe failed {t.Path}: {ex.Message}"); }
    }

    public static string CodecFromExt(string ext) => ext.ToLowerInvariant() switch
    {
        ".flac" => "FLAC",
        ".wav" => "WAV",
        ".mp3" => "MP3",
        ".m4a" => "AAC",
        ".aac" => "AAC",
        ".alac" => "ALAC",
        ".aif" or ".aiff" or ".aifc" => "AIFF",
        ".ogg" or ".oga" => "OGG",
        ".opus" => "OPUS",
        ".wma" => "WMA",
        ".ape" => "APE",
        ".wv" => "WavPack",
        ".dsf" => "DSF",
        ".dff" => "DFF",
        ".tak" => "TAK",
        ".tta" => "TTA",
        _ => ext.TrimStart('.').ToUpperInvariant(),
    };

    /// <summary>Embedded front cover (or first picture) bytes.</summary>
    public static byte[] EmbeddedPicture(Track t)
    {
        try
        {
            if (t.IsDsd)
            {
                var info = DsdInfo.Read(t.Path);
                if (info.Id3Offset <= 0) return null;
                using var fs = new FileStream(t.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                fs.Position = info.Id3Offset;
                var buf = new byte[Math.Min(info.Id3Length, 64 * 1024 * 1024)];
                int n = fs.Read(buf, 0, buf.Length);
                var tag = new TagLib.Id3v2.Tag(new TagLib.ByteVector(buf, n));
                return Pick(tag.Pictures);
            }
            using var file = TagLib.File.Create(t.Path, TagLib.ReadStyle.None);
            return Pick(file.Tag.Pictures);
        }
        catch { return null; }
    }

    static byte[] Pick(TagLib.IPicture[] pics)
    {
        if (pics == null || pics.Length == 0) return null;
        var p = pics.FirstOrDefault(x => x.Type == TagLib.PictureType.FrontCover) ?? pics.OrderByDescending(x => x.Data.Count).First();
        return p.Data?.Data;
    }

    public static string EmbeddedLyrics(Track t)
    {
        try
        {
            if (t.IsDsd) return null;
            using var file = TagLib.File.Create(t.Path, TagLib.ReadStyle.None);
            return string.IsNullOrWhiteSpace(file.Tag.Lyrics) ? null : file.Tag.Lyrics;
        }
        catch { return null; }
    }
}
