using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Miku.Audio;

namespace Miku.Library;

/// <summary>
/// Writes tags into the music files (the album page's 「編輯標籤」): album / track fields and the embedded front cover.
/// Only the fields that were changed are written; everything else in the file is left as it was.
/// TagLib does FLAC, MP3, M4A/ALAC, OGG/Opus, APE, WavPack, AIFF, WAV, WMA…; DSF (ID3v2 at the end of the file) and
/// DFF (an "ID3 " chunk in the FRM8 form, as foobar2000 / JRiver / TagLib write it) are written here.
/// </summary>
public static class TagWriter
{
    /// <summary>The fields the editor can change (JSON names).</summary>
    public static readonly string[] Fields = { "title", "artist", "albumArtist", "album", "genre", "composer", "year", "track", "trackTotal", "disc", "discTotal" };

    public static bool CanWrite(string path)
    {
        string ext = Path.GetExtension(path).ToLowerInvariant();
        return MusicLibrary.Extensions.Contains(ext) && ext is not (".tak" or ".tta" or ".mka" or ".mp2" or ".caf");
    }

    /// <summary>
    /// The cover to embed: anything GDI+ reads, as JPEG at most 1600 px (a 3 MB PNG in every one of 20 files adds up);
    /// a JPEG / PNG that is already small enough is kept as it is.
    /// </summary>
    public static (byte[] Data, string Mime) PrepareCover(byte[] bytes)
    {
        if (bytes == null || bytes.Length < 500) throw new InvalidOperationException("圖片太小或無效");
        bool jpeg = bytes[0] == 0xFF && bytes[1] == 0xD8, png = bytes[0] == 0x89 && bytes[1] == 0x50;
        int w = 0, h = 0;
        try
        {
            using var ms = new MemoryStream(bytes);
            using var img = System.Drawing.Image.FromStream(ms, false, false);
            w = img.Width; h = img.Height;
        }
        catch (Exception) { throw new InvalidOperationException("無法讀取這張圖片（請用 JPEG 或 PNG）"); }
        if (w < 50 || h < 50) throw new InvalidOperationException("圖片太小");
        if ((jpeg || png) && Math.Max(w, h) <= 1600 && bytes.Length <= 2_500_000) return (bytes, jpeg ? "image/jpeg" : "image/png");
        var resized = ArtworkService.Resize(bytes, Math.Min(1600, Math.Max(w, h)));
        if (resized == null || resized.Length < 2 || resized[0] != 0xFF || resized[1] != 0xD8) throw new InvalidOperationException("無法轉換這張圖片");
        return (resized, "image/jpeg");
    }

    /// <summary>
    /// Writes one file. <paramref name="set"/>: field → new value ("" clears it). <paramref name="cover"/>: the new
    /// front cover, or null to keep it; <paramref name="removeCover"/> removes the front cover.
    /// </summary>
    public static void Write(string path, IReadOnlyDictionary<string, string> set, (byte[] Data, string Mime)? cover, bool removeCover)
    {
        if (!CanWrite(path)) throw new InvalidOperationException("不支援寫入這種格式（" + Path.GetExtension(path) + "）");
        var fi = new FileInfo(path);
        if (fi.IsReadOnly) fi.IsReadOnly = false;
        if (Path.GetExtension(path).Equals(".dsf", StringComparison.OrdinalIgnoreCase)) { WriteDsf(path, set, cover, removeCover); return; }
        if (Path.GetExtension(path).Equals(".dff", StringComparison.OrdinalIgnoreCase)) { WriteDff(path, set, cover, removeCover); return; }
        using var file = TagLib.File.Create(path);
        // make sure there is a tag that holds Unicode text (an MP3 with only ID3v1 would get '?' for CJK)
        switch (file)
        {
            case TagLib.Mpeg.AudioFile:
            case TagLib.Riff.File:
            case TagLib.Aiff.File:
                file.GetTag(TagLib.TagTypes.Id3v2, true);
                break;
            case TagLib.Flac.File:
                file.GetTag(TagLib.TagTypes.Xiph, true);
                break;
            case TagLib.Ape.File:
            case TagLib.WavPack.File:
                file.GetTag(TagLib.TagTypes.Ape, true);
                break;
        }
        Apply(file.Tag, set);
        if (cover != null || removeCover) SetCover(file.Tag, cover, removeCover);
        file.Save();
    }

    static string[] Split(string v) => (v ?? "").Split(';', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).Distinct().ToArray();
    static uint Num(string v) => uint.TryParse((v ?? "").Trim(), out var n) ? n : 0;

    static void Apply(TagLib.Tag tag, IReadOnlyDictionary<string, string> set)
    {
        foreach (var (k, raw) in set)
        {
            string v = (raw ?? "").Replace('\0', ' ').Trim();
            switch (k)
            {
                case "title": tag.Title = v == "" ? null : v; break;
                case "artist": tag.Performers = Split(v); break;
                case "albumArtist": tag.AlbumArtists = Split(v); break;
                case "album": tag.Album = v == "" ? null : v; break;
                case "genre": tag.Genres = Split(v); break;
                case "composer": tag.Composers = Split(v); break;
                case "year": tag.Year = Num(v); break;
                case "track": tag.Track = Num(v); break;
                case "trackTotal": tag.TrackCount = Num(v); break;
                case "disc": tag.Disc = Num(v); break;
                case "discTotal": tag.DiscCount = Num(v); break;
            }
        }
    }

    /// <summary>Replaces the front cover (and pictures of type "other", which taggers often use for it); other pictures stay.</summary>
    static void SetCover(TagLib.Tag tag, (byte[] Data, string Mime)? cover, bool remove)
    {
        var keep = (tag.Pictures ?? Array.Empty<TagLib.IPicture>())
            .Where(p => p.Type != TagLib.PictureType.FrontCover && p.Type != TagLib.PictureType.Other).ToList();
        var list = new List<TagLib.IPicture>();
        if (!remove && cover is { } c)
            list.Add(new TagLib.Picture(new TagLib.ByteVector(c.Data)) { Type = TagLib.PictureType.FrontCover, MimeType = c.Mime, Description = "" });
        list.AddRange(keep);
        tag.Pictures = list.ToArray();
    }

    /// <summary>
    /// DSF: the ID3v2 tag sits after the audio data, the header points at it (offset 20) and holds the file size
    /// (offset 12). The old tag is cut off and the new one appended; the audio data is not touched.
    /// </summary>
    static void WriteDsf(string path, IReadOnlyDictionary<string, string> set, (byte[] Data, string Mime)? cover, bool removeCover)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.Read);
        var head = new byte[28];
        if (fs.Read(head, 0, 28) != 28 || Encoding.ASCII.GetString(head, 0, 4) != "DSD ") throw new InvalidDataException("不是 DSF 檔案");
        long meta = BinaryPrimitives.ReadInt64LittleEndian(head.AsSpan(20));
        // end of the data chunk: DSD chunk (28) + fmt chunk + data chunk (its size includes its 12-byte header)
        var buf = new byte[12];
        fs.Position = 28 + 4;
        fs.ReadExactly(buf, 0, 8);
        long fmtSize = BinaryPrimitives.ReadInt64LittleEndian(buf);
        fs.Position = 28 + fmtSize;
        fs.ReadExactly(buf, 0, 12);
        if (Encoding.ASCII.GetString(buf, 0, 4) != "data") throw new InvalidDataException("DSF data chunk 缺失");
        long dataEnd = 28 + fmtSize + BinaryPrimitives.ReadInt64LittleEndian(buf.AsSpan(4));
        if (dataEnd > fs.Length) throw new InvalidDataException("DSF 檔案不完整");

        TagLib.Id3v2.Tag tag = null;
        if (meta > 0 && meta < fs.Length)
        {
            fs.Position = meta;
            var old = new byte[fs.Length - meta];
            fs.ReadExactly(old, 0, old.Length);
            if (old.Length > 10 && old[0] == 'I' && old[1] == 'D' && old[2] == '3')
                try { tag = new TagLib.Id3v2.Tag(new TagLib.ByteVector(old)); } catch { tag = null; }
        }
        tag ??= new TagLib.Id3v2.Tag();
        Apply(tag, set);
        if (cover != null || removeCover) SetCover(tag, cover, removeCover);
        byte[] rendered = tag.Render().Data;

        long at = meta > 0 && meta >= dataEnd && meta <= fs.Length ? meta : dataEnd;
        fs.SetLength(at);
        fs.Position = at;
        fs.Write(rendered, 0, rendered.Length);
        var num = new byte[8];
        BinaryPrimitives.WriteInt64LittleEndian(num, fs.Length);
        fs.Position = 12; fs.Write(num, 0, 8);
        BinaryPrimitives.WriteInt64LittleEndian(num, at);
        fs.Position = 20; fs.Write(num, 0, 8);
    }

    /// <summary>
    /// DFF (DSDIFF): big-endian chunks inside "FRM8" (8-byte size) of form type "DSD ". The tag is an "ID3 " chunk
    /// holding an ID3v2 tag. When the old tag chunk is the last thing in the file (as taggers leave it) the file is cut
    /// there and the new chunk appended; when it sits before the audio, the file is rebuilt into a temporary file
    /// without it and moved over the original. The audio data is copied byte for byte, never changed.
    /// </summary>
    static void WriteDff(string path, IReadOnlyDictionary<string, string> set, (byte[] Data, string Mime)? cover, bool removeCover)
    {
        var chunks = new List<(string Id, long Pos, long Size)>();   // Pos: the chunk header; Size: its data
        byte[] rendered;
        long keepEnd = 16, newSize;
        bool inPlace;
        using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            var head = new byte[16];
            if (fs.Read(head, 0, 16) != 16 || Encoding.ASCII.GetString(head, 0, 4) != "FRM8" || Encoding.ASCII.GetString(head, 12, 4) != "DSD ")
                throw new InvalidDataException("不是 DFF 檔案");
            long end = Math.Min(fs.Length, 12 + BinaryPrimitives.ReadInt64BigEndian(head.AsSpan(4)));
            var ch = new byte[12];
            for (long pos = 16; pos + 12 <= end;)
            {
                fs.Position = pos;
                fs.ReadExactly(ch, 0, 12);
                string id = Encoding.ASCII.GetString(ch, 0, 4);
                long size = BinaryPrimitives.ReadInt64BigEndian(ch.AsSpan(4));
                if (size < 0 || pos + 12 + size > fs.Length) size = fs.Length - pos - 12;   // a truncated last chunk
                chunks.Add((id, pos, size));
                pos += 12 + size + (size & 1);
            }
            if (!chunks.Any(c => c.Id is "DSD " or "DST ")) throw new InvalidDataException("DFF 沒有音訊資料");

            TagLib.Id3v2.Tag tag = null;
            var old = chunks.FirstOrDefault(c => c.Id == "ID3 ");
            if (old.Id != null && old.Size > 10)
            {
                var buf = new byte[Math.Min(old.Size, 64 * 1024 * 1024)];
                fs.Position = old.Pos + 12;
                int n = fs.Read(buf, 0, buf.Length);
                if (n > 10 && buf[0] == 'I' && buf[1] == 'D' && buf[2] == '3')
                    try { tag = new TagLib.Id3v2.Tag(new TagLib.ByteVector(buf, n)); } catch { tag = null; }
            }
            tag ??= new TagLib.Id3v2.Tag();
            Apply(tag, set);
            if (cover != null || removeCover) SetCover(tag, cover, removeCover);
            rendered = tag.Render().Data;

            foreach (var c in chunks.Where(c => c.Id != "ID3 ")) keepEnd = Math.Max(keepEnd, c.Pos + 12 + c.Size + (c.Size & 1));
            inPlace = chunks.Where(c => c.Id == "ID3 ").All(c => c.Pos >= keepEnd);
            newSize = (inPlace ? keepEnd : 16 + chunks.Where(c => c.Id != "ID3 ").Sum(c => 12 + c.Size + (c.Size & 1))) + 12 + rendered.Length + (rendered.Length & 1);
        }

        var tagChunk = new byte[12 + rendered.Length + (rendered.Length & 1)];
        Encoding.ASCII.GetBytes("ID3 ").CopyTo(tagChunk, 0);
        BinaryPrimitives.WriteInt64BigEndian(tagChunk.AsSpan(4), rendered.Length);
        rendered.CopyTo(tagChunk, 12);
        var frm = new byte[8];
        BinaryPrimitives.WriteInt64BigEndian(frm, newSize - 12);

        if (inPlace)
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.Read);
            fs.SetLength(keepEnd);
            fs.Position = keepEnd;
            fs.Write(tagChunk, 0, tagChunk.Length);
            fs.Position = 4; fs.Write(frm, 0, 8);
            return;
        }
        string tmp = Path.Combine(Path.GetDirectoryName(path)!, "." + Path.GetFileName(path) + ".miku-" + Guid.NewGuid().ToString("N")[..8]);
        try
        {
            using (var src = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var dst = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write))
            {
                var head = new byte[16];
                src.ReadExactly(head, 0, 16);
                frm.CopyTo(head, 4);
                dst.Write(head, 0, 16);
                var buf = new byte[1 << 20];
                foreach (var c in chunks.Where(c => c.Id != "ID3 "))
                {
                    src.Position = c.Pos;
                    for (long left = 12 + c.Size + (c.Size & 1); left > 0;)
                    {
                        int n = src.Read(buf, 0, (int)Math.Min(buf.Length, left));
                        if (n <= 0) { dst.Write(new byte[left], 0, (int)left); break; }   // the pad byte of a last chunk without one
                        dst.Write(buf, 0, n); left -= n;
                    }
                }
                dst.Write(tagChunk, 0, tagChunk.Length);
            }
            File.Move(tmp, path, true);
        }
        catch { try { File.Delete(tmp); } catch { } throw; }
    }
}

/// <summary>
/// Album information from MusicBrainz and Apple Music (iTunes Search API) for the tag editor: search releases, then
/// one release's details with its track list.
/// </summary>
public sealed class MetadataService
{

    public sealed class Hit
    {
        public string Source { get; set; }     // musicbrainz | apple
        public string Id { get; set; }
        public string Country { get; set; }    // apple storefront (jp / tw / us), MusicBrainz release country
        public string Title { get; set; }
        public string Artist { get; set; }
        public string Date { get; set; }
        public int Tracks { get; set; }
        public int Discs { get; set; }
        public string Format { get; set; }
        public string Label { get; set; }
        public string Thumb { get; set; }
        public double Score { get; set; }
    }

    public sealed class ReleaseTrack
    {
        public int Disc { get; set; }
        public int No { get; set; }
        public string Title { get; set; }
        public string Artist { get; set; }
        public double Dur { get; set; }
    }

    public sealed class Release
    {
        public string Source { get; set; }
        public string Id { get; set; }
        public string Title { get; set; }
        public string Artist { get; set; }
        public string Date { get; set; }
        public int Year { get; set; }
        public string Genre { get; set; }
        public string Label { get; set; }
        public string Cover { get; set; }
        public string CoverThumb { get; set; }
        public List<ReleaseTrack> Tracks { get; set; } = new();
    }

    static string Str(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    static int Int(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : 0;
    static double Dbl(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : 0;
    static JsonElement Arr(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array ? v : default;
    static IEnumerable<JsonElement> Each(JsonElement arr) => arr.ValueKind == JsonValueKind.Array ? arr.EnumerateArray() : Enumerable.Empty<JsonElement>();

    static async Task<JsonDocument> Fetch(string url, RateGate gate, CancellationToken ct = default)
    {
        await gate.WaitAsync(true, ct);
        {
            using var req = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Get, url);
            using var res = await Net.Http.SendAsync(req, ct);
            if ((int)res.StatusCode == 503 || (int)res.StatusCode == 429) throw new InvalidOperationException("服務忙碌中，請稍後再試");
            if (!res.IsSuccessStatusCode) return null;
            return await JsonDocument.ParseAsync(await res.Content.ReadAsStreamAsync(ct), default, ct);
        }
    }

    // MusicBrainz asks for at most one request a second and a User-Agent naming the program (Net.Http has one)
    static Task<JsonDocument> Mb(string pathAndQuery) => Fetch("https://musicbrainz.org/ws/2/" + pathAndQuery, RateGate.MusicBrainz);
    static Task<JsonDocument> Apple(string pathAndQuery) => Fetch("https://itunes.apple.com/" + pathAndQuery, RateGate.Apple);

    static string Credit(JsonElement e)
    {
        var sb = new StringBuilder();
        foreach (var c in Each(Arr(e, "artist-credit"))) sb.Append(Str(c, "name")).Append(Str(c, "joinphrase"));
        return sb.ToString().Trim();
    }

    static int YearOf(string date) => date != null && date.Length >= 4 && int.TryParse(date[..4], out var y) ? y : 0;

    static string Lucene(string s) => System.Text.RegularExpressions.Regex.Replace(s ?? "", @"([+\-!(){}\[\]^""~*?:\\/]|&&|\|\|)", " ").Trim();

    /// <summary>
    /// Releases matching an album: <paramref name="album"/> and <paramref name="artist"/> (either may be empty).
    /// <paramref name="local"/> (the album being edited) ranks them: similar title / artist and the same number of tracks first.
    /// </summary>
    public async Task<List<Hit>> Search(string album, string artist, Album local, IEnumerable<string> sources)
    {
        album = (album ?? "").Trim(); artist = (artist ?? "").Trim();
        if (album == "" && artist == "") return new List<Hit>();
        var want = new HashSet<string>(sources ?? new[] { "musicbrainz", "apple" }, StringComparer.OrdinalIgnoreCase);
        var tasks = new List<Task<List<Hit>>>();
        if (want.Contains("musicbrainz")) tasks.Add(SearchMb(album, artist));
        if (want.Contains("apple"))
        {
            tasks.Add(SearchApple(album, artist, "jp"));
            tasks.Add(SearchApple(album, artist, "tw"));
        }
        var lists = await Task.WhenAll(tasks);
        var all = lists.SelectMany(x => x).ToList();
        int localTracks = local?.Tracks.Count ?? 0;
        foreach (var h in all)
        {
            double ts = album == "" ? 0.5 : Text.Similarity(album, h.Title);
            double ars = artist == "" ? 0.5 : Math.Max(Text.Similarity(artist, h.Artist), Text.Similarity(artist, h.Artist, false));
            double tc = localTracks == 0 || h.Tracks == 0 ? 0.5 : h.Tracks == localTracks ? 1 : Math.Max(0, 1 - Math.Abs(h.Tracks - localTracks) / (double)localTracks);
            h.Score = Math.Round(ts * 0.5 + ars * 0.25 + tc * 0.25, 3);
        }
        return all.OrderByDescending(h => h.Score).Take(60).ToList();
    }

    async Task<List<Hit>> SearchMb(string album, string artist)
    {
        var list = new List<Hit>();
        try
        {
            string q = album == "" ? $"artist:\"{Lucene(artist)}\""
                : artist == "" ? $"release:\"{Lucene(album)}\""
                : $"release:\"{Lucene(album)}\" AND artist:\"{Lucene(artist)}\"";
            using var doc = await Mb("release/?fmt=json&limit=25&query=" + Uri.EscapeDataString(q));
            if (doc == null) return list;
            foreach (var e in Each(Arr(doc.RootElement, "releases")))
            {
                var media = Each(Arr(e, "media")).ToList();
                var formats = media.Select(m => Str(m, "format")).Where(f => f != null).GroupBy(f => f).Select(g => g.Count() > 1 ? $"{g.Count()}×{g.Key}" : g.Key);
                string id = Str(e, "id");
                list.Add(new Hit
                {
                    Source = "musicbrainz", Id = id, Country = Str(e, "country"),
                    Title = Str(e, "title"), Artist = Credit(e), Date = Str(e, "date"),
                    Tracks = Int(e, "track-count"), Discs = Math.Max(1, media.Count),
                    Format = string.Join(" + ", formats),
                    Label = Each(Arr(e, "label-info")).Select(l => l.TryGetProperty("label", out var lb) ? Str(lb, "name") : null).FirstOrDefault(n => n != null),
                    Thumb = $"https://coverartarchive.org/release/{id}/front-250",
                });
            }
        }
        catch (Exception ex) { Log.Info("MusicBrainz search failed: " + ex.Message); }
        return list;
    }

    async Task<List<Hit>> SearchApple(string album, string artist, string country)
    {
        var list = new List<Hit>();
        try
        {
            string term = Uri.EscapeDataString((artist + " " + album).Trim());
            using var doc = await Apple($"search?term={term}&entity=album&limit=20&country={country}");
            if (doc == null) return list;
            foreach (var e in Each(Arr(doc.RootElement, "results")))
            {
                long id = e.TryGetProperty("collectionId", out var ci) && ci.TryGetInt64(out var n) ? n : 0;
                if (id == 0) continue;
                string art = Str(e, "artworkUrl100");
                list.Add(new Hit
                {
                    Source = "apple", Id = id.ToString(), Country = country,
                    Title = Str(e, "collectionName"), Artist = Str(e, "artistName"), Date = Str(e, "releaseDate")?.Split('T')[0],
                    Tracks = Int(e, "trackCount"), Discs = 0, Format = "Digital", Label = Str(e, "copyright"),
                    Thumb = art?.Replace("100x100bb", "300x300bb"),
                });
            }
        }
        catch (Exception ex) { Log.Info("Apple search failed: " + ex.Message); }
        return list;
    }

    /// <summary>One release with its track list.</summary>
    public Task<Release> Get(string source, string id, string country) =>
        source == "apple" ? GetApple(id, country) : GetMb(id);

    async Task<Release> GetMb(string id)
    {
        using var doc = await Mb($"release/{Uri.EscapeDataString(id)}?fmt=json&inc=recordings+artist-credits+labels+release-groups+genres");
        if (doc == null) throw new InvalidOperationException("MusicBrainz 找不到這張專輯");
        var e = doc.RootElement;
        var r = new Release
        {
            Source = "musicbrainz", Id = id, Title = Str(e, "title"), Artist = Credit(e), Date = Str(e, "date"),
            Label = Each(Arr(e, "label-info")).Select(l => l.TryGetProperty("label", out var lb) ? Str(lb, "name") : null).FirstOrDefault(n => n != null),
        };
        r.Year = YearOf(r.Date);
        var rg = e.TryGetProperty("release-group", out var g) ? g : default;
        // the year of the first release of this album is what people usually want, the date of this edition otherwise
        int first = YearOf(Str(rg, "first-release-date"));
        if (first > 0 && (r.Year == 0 || first < r.Year)) r.Year = first;
        r.Genre = Each(Arr(e, "genres")).Concat(Each(Arr(rg, "genres")))
            .OrderByDescending(x => Int(x, "count")).Select(x => Str(x, "name")).FirstOrDefault(n => !string.IsNullOrEmpty(n));
        if (r.Genre != null && r.Genre.Length > 0) r.Genre = char.ToUpperInvariant(r.Genre[0]) + r.Genre[1..];
        bool front = e.TryGetProperty("cover-art-archive", out var caa) && caa.TryGetProperty("front", out var f) && f.ValueKind == JsonValueKind.True;
        if (front) { r.Cover = $"https://coverartarchive.org/release/{id}/front-1200"; r.CoverThumb = $"https://coverartarchive.org/release/{id}/front-250"; }
        else if (Str(rg, "id") is string rgid) { r.Cover = $"https://coverartarchive.org/release-group/{rgid}/front-1200"; r.CoverThumb = $"https://coverartarchive.org/release-group/{rgid}/front-250"; }
        int disc = 0;
        foreach (var m in Each(Arr(e, "media")))
        {
            disc = Int(m, "position") > 0 ? Int(m, "position") : disc + 1;
            foreach (var t in Each(Arr(m, "tracks")))
            {
                int no = Int(t, "position");
                if (no == 0) int.TryParse(Str(t, "number"), out no);
                string artist = Credit(t);
                if (string.IsNullOrEmpty(artist) && t.TryGetProperty("recording", out var rec)) artist = Credit(rec);
                r.Tracks.Add(new ReleaseTrack { Disc = disc, No = no, Title = Str(t, "title"), Artist = string.IsNullOrEmpty(artist) ? r.Artist : artist, Dur = Dbl(t, "length") / 1000 });
            }
        }
        return r;
    }

    async Task<Release> GetApple(string id, string country)
    {
        country = country is "jp" or "tw" or "us" ? country : "jp";
        using var doc = await Apple($"lookup?id={Uri.EscapeDataString(id)}&entity=song&limit=300&country={country}");
        var results = doc == null ? new List<JsonElement>() : Each(Arr(doc.RootElement, "results")).ToList();
        var c = results.FirstOrDefault(x => Str(x, "wrapperType") == "collection");
        if (c.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("Apple Music 找不到這張專輯");
        string art = Str(c, "artworkUrl100");
        var r = new Release
        {
            Source = "apple", Id = id, Title = Str(c, "collectionName"), Artist = Str(c, "artistName"),
            Date = Str(c, "releaseDate")?.Split('T')[0], Genre = Str(c, "primaryGenreName"), Label = Str(c, "copyright"),
            Cover = art?.Replace("100x100bb", "1600x1600bb"), CoverThumb = art?.Replace("100x100bb", "300x300bb"),
        };
        r.Year = YearOf(r.Date);
        foreach (var t in results.Where(x => Str(x, "wrapperType") == "track" && Str(x, "kind") == "song")
                     .OrderBy(x => Int(x, "discNumber")).ThenBy(x => Int(x, "trackNumber")))
            r.Tracks.Add(new ReleaseTrack { Disc = Math.Max(1, Int(t, "discNumber")), No = Int(t, "trackNumber"), Title = Str(t, "trackName"), Artist = Str(t, "artistName"), Dur = Dbl(t, "trackTimeMillis") / 1000 });
        return r;
    }
}
