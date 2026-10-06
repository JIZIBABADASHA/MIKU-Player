using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
using Miku.Audio;

namespace Miku.Library;

// ═════════════════════════════ audio CD: reading, playing, ripping ═════════════════════════════
//
// A disc in an optical drive shows up as an album (id "cd-<MusicBrainz disc id>") that is not part of the library:
// MusicLibrary asks CdService for ids it doesn't know. Playing a track extracts it from the disc into a WAV file in
// the cache (…\MIKU\CD\<disc>\NN.wav) as fast as the drive reads; playback starts once enough of it is there, so any
// playback core (MIKU's own, an extension's) just plays a file. Ripping is separate and careful: every part of the
// disc is read twice and compared, parts that differ are read again until two reads agree, the drive's read offset
// is corrected (found with AccurateRip when it isn't known yet) and every track is checked against AccurateRip.

/// <summary>One entry of the disc's table of contents.</summary>
public sealed class CdTocTrack
{
    public int No;
    public int Lba;       // first sector (index 01)
    public bool Audio;
}

/// <summary>The disc's table of contents and the identifiers made from it.</summary>
public sealed class CdToc
{
    public List<CdTocTrack> Tracks = new();
    public int Leadout;   // the lead-out's sector (end of the last session)

    public List<CdTocTrack> Audio => Tracks.Where(t => t.Audio).ToList();

    /// <summary>End of the audio: an Enhanced CD's data session starts 11400 sectors after the audio session ends.</summary>
    public int AudioLeadout
    {
        get
        {
            var a = Audio;
            if (a.Count == 0) return Leadout;
            var data = Tracks.FirstOrDefault(t => !t.Audio && t.No > a[^1].No);
            return data != null ? data.Lba - 11400 : Leadout;
        }
    }

    /// <summary>First sector after an audio track.</summary>
    public int EndOf(CdTocTrack t)
    {
        var a = Audio;
        int i = a.IndexOf(t);
        return i + 1 < a.Count ? a[i + 1].Lba : AudioLeadout;
    }

    public string Key => string.Join(",", Tracks.Select(t => t.Lba)) + "/" + Leadout;

    /// <summary>MusicBrainz disc id: SHA-1 of the audio session's TOC, base64 with . _ - .</summary>
    public string MusicBrainzId()
    {
        var a = Audio;
        var sb = new StringBuilder();
        sb.Append(a[0].No.ToString("X2")).Append(a[^1].No.ToString("X2")).Append((AudioLeadout + 150).ToString("X8"));
        for (int i = 1; i < 100; i++)
        {
            var t = a.FirstOrDefault(x => x.No == i);
            sb.Append((t != null ? t.Lba + 150 : 0).ToString("X8"));
        }
        var hash = SHA1.HashData(Encoding.ASCII.GetBytes(sb.ToString()));
        return Convert.ToBase64String(hash).Replace('+', '.').Replace('/', '_').Replace('=', '-');
    }

    /// <summary>The TOC as MusicBrainz takes it for a fuzzy lookup: first last leadout offsets… (+150).</summary>
    public string MusicBrainzToc()
    {
        var a = Audio;
        return string.Join("+", new[] { a[0].No, a[^1].No, AudioLeadout + 150 }.Concat(a.Select(t => t.Lba + 150)));
    }

    /// <summary>The freedb / CDDB id (all tracks, the real lead-out).</summary>
    public uint FreedbId()
    {
        static int DigitSum(int n) { int s = 0; while (n > 0) { s += n % 10; n /= 10; } return s; }
        int n = 0;
        foreach (var t in Tracks) n += DigitSum((t.Lba + 150) / 75);
        int len = (Leadout + 150) / 75 - (Tracks[0].Lba + 150) / 75;
        return (uint)((n % 255) << 24 | len << 8 | Tracks.Count);
    }

    /// <summary>AccurateRip's two disc ids (audio tracks and the audio lead-out).</summary>
    public (uint Id1, uint Id2) AccurateRipIds()
    {
        uint id1 = 0, id2 = 0;
        var a = Audio;
        for (int i = 0; i < a.Count; i++) { id1 += (uint)a[i].Lba; id2 += (uint)Math.Max(a[i].Lba, 1) * (uint)(i + 1); }
        id1 += (uint)AudioLeadout; id2 += (uint)Math.Max(AudioLeadout, 1) * (uint)(a.Count + 1);
        return (id1, id2);
    }
}

/// <summary>An optical drive opened for raw reading (Windows CD-ROM class driver IOCTLs).</summary>
public sealed class CdDrive : IDisposable
{
    public const int SectorBytes = 2352;
    public const int SamplesPerSector = 588;
    const uint IOCTL_CDROM_READ_TOC = 0x00024000;
    const uint IOCTL_CDROM_RAW_READ = 0x0002403E;
    const uint IOCTL_STORAGE_EJECT_MEDIA = 0x002D4808;
    const uint IOCTL_STORAGE_QUERY_PROPERTY = 0x002D1400;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle h, uint code, byte[] inBuf, int inSize, byte[] outBuf, int outSize, out int returned, IntPtr overlapped);

    readonly SafeFileHandle _h;
    public char Letter { get; }

    CdDrive(char letter, SafeFileHandle h) { Letter = letter; _h = h; }

    public static CdDrive Open(char letter)
    {
        var h = CreateFile($"\\\\.\\{letter}:", 0x80000000 /* GENERIC_READ */, 3 /* share read + write */, IntPtr.Zero, 3 /* OPEN_EXISTING */, 0, IntPtr.Zero);
        if (h.IsInvalid) throw new IOException($"無法開啟光碟機 {letter}:（錯誤 {Marshal.GetLastWin32Error()}）");
        return new CdDrive(letter, h);
    }

    public void Dispose() => _h.Dispose();

    public CdToc ReadToc()
    {
        var buf = new byte[804];
        if (!DeviceIoControl(_h, IOCTL_CDROM_READ_TOC, null, 0, buf, buf.Length, out _, IntPtr.Zero))
            throw new IOException("讀不到光碟的目錄（錯誤 " + Marshal.GetLastWin32Error() + "）");
        int first = buf[2], last = buf[3];
        var toc = new CdToc();
        for (int i = 0; i <= last - first + 1 && 4 + i * 8 + 8 <= buf.Length; i++)
        {
            int o = 4 + i * 8;
            int control = buf[o + 1] & 0x0F;
            int no = buf[o + 2];
            int lba = (buf[o + 5] * 60 + buf[o + 6]) * 75 + buf[o + 7] - 150;
            if (no == 0xAA) { toc.Leadout = lba; break; }
            toc.Tracks.Add(new CdTocTrack { No = no, Lba = lba, Audio = (control & 0x04) == 0 });
        }
        if (toc.Tracks.Count == 0 || toc.Leadout <= 0) throw new IOException("光碟目錄不完整");
        return toc;
    }

    /// <summary>Reads raw CD-DA sectors (2352 bytes each). Returns false when the drive refused.</summary>
    public bool ReadRaw(int lba, int count, byte[] dst, int dstOffset)
    {
        var info = new byte[16];
        BinaryPrimitives.WriteInt64LittleEndian(info, (long)lba * 2048);
        BinaryPrimitives.WriteInt32LittleEndian(info.AsSpan(8), count);
        BinaryPrimitives.WriteInt32LittleEndian(info.AsSpan(12), 2);   // CDDA
        byte[] outBuf = dstOffset == 0 && dst.Length == count * SectorBytes ? dst : new byte[count * SectorBytes];
        if (!DeviceIoControl(_h, IOCTL_CDROM_RAW_READ, info, info.Length, outBuf, count * SectorBytes, out int got, IntPtr.Zero) || got < count * SectorBytes)
            return false;
        if (!ReferenceEquals(outBuf, dst)) Buffer.BlockCopy(outBuf, 0, dst, dstOffset, count * SectorBytes);
        return true;
    }

    /// <summary>
    /// Reads sectors [lba, lba + count) into dst; a block the drive refuses is tried in smaller pieces and finally
    /// sector by sector (a sector that can't be read at all is left silent). Returns how many sectors failed.
    /// Sectors outside the disc (before 0, past the lead-out) are silence.
    /// </summary>
    public int Read(int lba, int count, int leadout, byte[] dst, int dstOffset)
    {
        int failed = 0;
        int pos = 0;
        while (pos < count)
        {
            int at = lba + pos;
            if (at < 0 || at >= leadout) { Array.Clear(dst, dstOffset + pos * SectorBytes, SectorBytes); pos++; continue; }
            int n = Math.Min(Math.Min(count - pos, 24), leadout - at);
            if (at < 0) n = 1;
            if (ReadRaw(at, n, dst, dstOffset + pos * SectorBytes)) { pos += n; continue; }
            // refused: one sector at a time, a few tries each
            for (int k = 0; k < n; k++)
            {
                bool ok = false;
                for (int tries = 0; tries < 3 && !ok; tries++) ok = ReadRaw(at + k, 1, dst, dstOffset + (pos + k) * SectorBytes);
                if (!ok) { Array.Clear(dst, dstOffset + (pos + k) * SectorBytes, SectorBytes); failed++; }
            }
            pos += n;
        }
        return failed;
    }

    public void Eject()
    {
        DeviceIoControl(_h, IOCTL_STORAGE_EJECT_MEDIA, null, 0, null, 0, out _, IntPtr.Zero);
    }

    /// <summary>The drive's vendor and product ("PIONEER BD-RW BDR-XD07"), for remembering its read offset.</summary>
    public string Model()
    {
        try
        {
            var q = new byte[12];   // StorageDeviceProperty, PropertyStandardQuery
            var buf = new byte[1024];
            if (!DeviceIoControl(_h, IOCTL_STORAGE_QUERY_PROPERTY, q, q.Length, buf, buf.Length, out int got, IntPtr.Zero) || got < 24) return "";
            string Str(int at)
            {
                int o = BinaryPrimitives.ReadInt32LittleEndian(buf.AsSpan(at));
                if (o <= 0 || o >= got) return "";
                int e = o; while (e < got && buf[e] != 0) e++;
                return Encoding.ASCII.GetString(buf, o, e - o).Trim();
            }
            return (Str(12) + " " + Str(16)).Trim();
        }
        catch { return ""; }
    }
}

/// <summary>AccurateRip: the database lookup and the track checksums.</summary>
public static class AccurateRip
{
    /// <summary>A track's entries: one per pressing, (confidence, CRC); CRCs may be v1 or v2.</summary>
    public sealed class Disc { public List<List<(int Conf, uint Crc)>> Tracks = new(); }

    public static async Task<Disc> FetchAsync(CdToc toc, CancellationToken ct)
    {
        var (id1, id2) = toc.AccurateRipIds();
        int n = toc.Audio.Count;
        string url = $"http://www.accuraterip.com/accuraterip/{id1 & 0xF:x}/{(id1 >> 4) & 0xF:x}/{(id1 >> 8) & 0xF:x}/dBAR-{n:000}-{id1:x8}-{id2:x8}-{toc.FreedbId():x8}.bin";
        try
        {
            using var r = await Net.Http.GetAsync(url, ct);
            if (!r.IsSuccessStatusCode) return null;
            var b = await r.Content.ReadAsByteArrayAsync(ct);
            var disc = new Disc();
            for (int i = 0; i < n; i++) disc.Tracks.Add(new());
            int o = 0;
            while (o + 13 <= b.Length)
            {
                int count = b[o]; o += 13;
                for (int i = 0; i < count && o + 9 <= b.Length; i++, o += 9)
                    if (i < n) disc.Tracks[i].Add((b[o], BinaryPrimitives.ReadUInt32LittleEndian(b.AsSpan(o + 1))));
            }
            return disc.Tracks.Any(t => t.Count > 0) ? disc : null;
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { Log.Info("AccurateRip lookup: " + ex.Message); return null; }
    }

    /// <summary>
    /// The v1 and v2 checksums of a track's samples (stereo 16-bit as one 32-bit word each). The first track skips its
    /// first 5 sectors but one sample, the last track its last 5 sectors, as AccurateRip does.
    /// </summary>
    public sealed class Summer
    {
        readonly long _total, _from, _to;
        long _i;
        uint _v1, _v2;
        public Summer(long totalSamples, bool first, bool last)
        {
            _total = totalSamples;
            _from = first ? 5 * CdDrive.SamplesPerSector - 1 : 0;
            _to = last ? totalSamples - 5 * CdDrive.SamplesPerSector : totalSamples;
        }
        public void Add(ReadOnlySpan<byte> pcm)
        {
            for (int k = 0; k + 4 <= pcm.Length; k += 4, _i++)
            {
                if (_i < _from || _i >= _to) continue;
                uint v = BinaryPrimitives.ReadUInt32LittleEndian(pcm.Slice(k));
                uint m = (uint)(_i + 1);
                unchecked
                {
                    _v1 += v * m;
                    ulong p = (ulong)v * m;
                    _v2 += (uint)(p >> 32) + (uint)p;
                }
            }
        }
        public uint V1 => _v1;
        public uint V2 => _v2;
    }

    /// <summary>
    /// The read offset that makes a (middle) track match the database: v1 checksums for every shift in ±range,
    /// updated as the window slides one sample at a time. raw: the samples read around the track; at: where the track
    /// starts in raw with no offset; n: the track's length. Returns null when no shift matches.
    /// </summary>
    public static int? FindOffset(uint[] raw, int at, int n, int range, List<(int Conf, uint Crc)> entries)
    {
        if (entries == null || entries.Count == 0) return null;
        var want = new Dictionary<uint, int>();
        foreach (var (conf, crc) in entries) want[crc] = Math.Max(want.GetValueOrDefault(crc), conf);
        uint S(long i) => i >= 0 && i < raw.Length ? raw[i] : 0u;
        int lo = -range;
        uint c = 0, s = 0;
        unchecked
        {
            for (int i = 0; i < n; i++) { uint v = S(at + lo + i); c += v * (uint)(i + 1); s += v; }
        }
        int? best = null; int bestConf = 0;
        for (int o = lo; o <= range; o++)
        {
            if (want.TryGetValue(c, out int conf) && (best == null || conf > bestConf || conf == bestConf && Math.Abs(o) < Math.Abs(best.Value))) { best = o; bestConf = conf; }
            unchecked
            {
                uint first = S(at + o), next = S(at + o + n);
                c = c - s + (uint)n * next;
                s = s - first + next;
            }
        }
        return best;
    }
}

/// <summary>The disc in the drive, as MIKU shows it.</summary>
public sealed class CdDisc
{
    public char Drive;
    public string DriveModel = "";
    public CdToc Toc;
    public string MbId;
    public Album Album;
    public List<Track> Tracks = new();
    public string Lookup = "pending";   // pending | found | none | error
    public List<CdRelease> Releases = new();
    public string ReleaseId;
    public byte[] Cover;
    public string CacheDir;
    public int CoverVersion;
}

public sealed class CdRelease
{
    public string Id, Title, Artist, Date, Country, Label;
    public List<(int No, string Title, string Artist)> Tracks = new();
}

public sealed class CdService : IDisposable
{
    public static CdService Instance { get; private set; }

    readonly Settings _s;
    readonly System.Threading.Timer _poll;
    readonly SemaphoreSlim _drive = new(1, 1);   // one reader at a time (play extraction and ripping take turns per block)
    readonly object _lock = new();
    readonly object _ripLock = new();
    CdDisc _disc;
    string _seenKey;
    int _polling;
    CancellationTokenSource _ripCts;

    /// <summary>The disc appeared, went, or its names / cover arrived.</summary>
    public event Action Changed;
    public event Action<object> RipProgress;

    public CdService(Settings s)
    {
        _s = s;
        Instance = this;
        _poll = new System.Threading.Timer(_ => Poll(), null, 1500, 2500);
    }

    public void Dispose() { _poll.Dispose(); CancelRip(); }

    public CdDisc Disc { get { lock (_lock) return _disc; } }
    public bool Ripping { get { lock (_ripLock) return _ripCts != null; } }

    // ───────────── disc detection ─────────────

    void Poll()
    {
        if (Interlocked.Exchange(ref _polling, 1) == 1) return;
        try
        {
            char found = '\0'; CdToc toc = null; string model = "";
            foreach (var d in DriveInfo.GetDrives())
            {
                if (d.DriveType != DriveType.CDRom) continue;
                bool ready;
                try { ready = d.IsReady; } catch { ready = false; }
                char letter = char.ToUpperInvariant(d.Name[0]);
                var cur = Disc;
                if (!ready) continue;
                if (cur != null && cur.Drive == letter) { found = letter; toc = cur.Toc; break; }
                try
                {
                    using var drv = CdDrive.Open(letter);
                    var t = drv.ReadToc();
                    if (t.Audio.Count == 0) continue;
                    found = letter; toc = t; model = drv.Model();
                    break;
                }
                catch { }
            }
            string key = found == '\0' ? null : found + ":" + toc.Key;
            if (key == _seenKey) return;
            _seenKey = key;
            if (key == null) { lock (_lock) _disc = null; Changed?.Invoke(); return; }
            var disc = Build(found, toc, model);
            lock (_lock) _disc = disc;
            Changed?.Invoke();
            _ = Task.Run(() => LookupAsync(disc));
        }
        catch (Exception ex) { Log.Error("CD poll", ex); }
        finally { Volatile.Write(ref _polling, 0); }
    }

    CdDisc Build(char drive, CdToc toc, string model)
    {
        string mbid = toc.MusicBrainzId();
        var d = new CdDisc { Drive = drive, Toc = toc, MbId = mbid, DriveModel = model, CacheDir = Path.Combine(AppPaths.Root, "CD", Safe(mbid)) };
        d.Album = new Album { Id = "cd-" + Safe(mbid), Title = "音樂 CD", Artist = "", Folder = d.CacheDir };
        foreach (var t in toc.Audio)
        {
            int sectors = toc.EndOf(t) - t.Lba;
            var tr = new Track
            {
                Id = d.Album.Id + "-" + t.No, Path = Path.Combine(d.CacheDir, $"{t.No:00}.wav"), Title = $"第 {t.No} 首",
                Album = d.Album.Title, TrackNo = t.No, DiscNo = 1, Duration = sectors / 75.0, SampleRate = 44100, Bits = 16, Channels = 2,
                Codec = "CD", AlbumId = d.Album.Id,
            };
            d.Tracks.Add(tr);
            d.Album.Tracks.Add(tr);
        }
        return d;
    }

    static string Safe(string id) => new string(id.Select(c => char.IsLetterOrDigit(c) ? c : '_').ToArray());

    public Track GetTrack(string id) { var d = Disc; return d?.Tracks.FirstOrDefault(t => t.Id == id); }
    public Album GetAlbum(string id) { var d = Disc; return d != null && d.Album.Id == id ? d.Album : null; }

    public void Eject()
    {
        var d = Disc;
        if (d == null) return;
        CancelRip();
        _ = Task.Run(async () =>
        {
            await _drive.WaitAsync();
            try { using var drv = CdDrive.Open(d.Drive); drv.Eject(); }
            catch (Exception ex) { Log.Error("CD eject", ex); }
            finally { _drive.Release(); }
            Poll();
        });
    }

    // ───────────── names: MusicBrainz ─────────────

    public async Task RefreshInfo(string discId = null)
    {
        var d = Disc ?? throw new InvalidOperationException("光碟已經退出");
        if (discId != null && d.Album.Id != discId) throw new InvalidOperationException("光碟已變更，請重新開啟 CD 資訊");
        if (d.Lookup == "pending") return;
        d.Lookup = "pending";
        Changed?.Invoke();
        await LookupAsync(d, chooseDefault: false);
    }

    async Task LookupAsync(CdDisc d, bool chooseDefault = true)
    {
        try
        {
            await RateGate.MusicBrainz.WaitAsync(true);
            string url = $"https://musicbrainz.org/ws/2/discid/{Uri.EscapeDataString(d.MbId)}?toc={d.Toc.MusicBrainzToc()}&inc=recordings+artist-credits+labels&cdstubs=no&fmt=json";
            using var r = await Net.Http.GetAsync(url);
            if (r.StatusCode == System.Net.HttpStatusCode.NotFound) { d.Releases = new(); d.Lookup = "none"; Changed?.Invoke(); return; }
            r.EnsureSuccessStatusCode();
            using var doc = JsonDocument.Parse(await r.Content.ReadAsStringAsync());
            var rels = new List<CdRelease>();
            if (doc.RootElement.TryGetProperty("releases", out var arr))
                foreach (var rel in arr.EnumerateArray())
                {
                    var cr = ParseRelease(rel, d);
                    if (cr != null) rels.Add(cr);
                }
            d.Releases = rels;
            d.Lookup = rels.Count > 0 ? "found" : "none";
            if (chooseDefault && rels.Count > 0) Apply(d, rels[0]);
            Changed?.Invoke();
            if (chooseDefault && rels.Count > 0) await CoverAsync(d, rels[0].Id);
        }
        catch (Exception ex) { Log.Info("CD lookup: " + ex.Message); d.Lookup = "error"; Changed?.Invoke(); }
    }

    static string Credit(JsonElement e)
    {
        if (!e.TryGetProperty("artist-credit", out var ac) || ac.ValueKind != JsonValueKind.Array) return "";
        var sb = new StringBuilder();
        foreach (var c in ac.EnumerateArray())
        {
            sb.Append(c.TryGetProperty("name", out var n) ? n.GetString() : "");
            if (c.TryGetProperty("joinphrase", out var j)) sb.Append(j.GetString());
        }
        return sb.ToString().Trim();
    }

    static string Str(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    static CdRelease ParseRelease(JsonElement rel, CdDisc d)
    {
        if (!rel.TryGetProperty("media", out var media)) return null;
        JsonElement? medium = null;
        foreach (var m in media.EnumerateArray())
            if (m.TryGetProperty("discs", out var discs) && discs.EnumerateArray().Any(x => Str(x, "id") == d.MbId)) { medium = m; break; }
        if (medium == null)
            foreach (var m in media.EnumerateArray())
                if (m.TryGetProperty("tracks", out var tr) && tr.GetArrayLength() == d.Tracks.Count) { medium = m; break; }
        if (medium == null) return null;
        var cr = new CdRelease { Id = Str(rel, "id"), Title = Str(rel, "title"), Artist = Credit(rel), Date = Str(rel, "date"), Country = Str(rel, "country") };
        if (rel.TryGetProperty("label-info", out var li) && li.ValueKind == JsonValueKind.Array)
            foreach (var l in li.EnumerateArray())
                if (l.TryGetProperty("label", out var lab) && lab.ValueKind == JsonValueKind.Object) { cr.Label = Str(lab, "name"); break; }
        int i = 0;
        foreach (var t in medium.Value.GetProperty("tracks").EnumerateArray())
        {
            i++;
            string artist = Credit(t);
            if (artist == "" && t.TryGetProperty("recording", out var rec)) artist = Credit(rec);
            cr.Tracks.Add((i, Str(t, "title"), artist == "" ? cr.Artist : artist));
        }
        return cr;
    }

    void Apply(CdDisc d, CdRelease r)
    {
        d.ReleaseId = r.Id;
        d.Album.Title = string.IsNullOrWhiteSpace(r.Title) ? "音樂 CD" : r.Title;
        d.Album.Artist = r.Artist;
        d.Album.Year = r.Date.Length >= 4 && int.TryParse(r.Date[..4], out int y) ? y : 0;
        for (int i = 0; i < d.Tracks.Count; i++)
        {
            var t = d.Tracks[i];
            t.Album = d.Album.Title; t.AlbumArtist = r.Artist; t.Year = d.Album.Year;
            var x = r.Tracks.FirstOrDefault(z => z.No == i + 1);
            if (x.Title != null) { t.Title = x.Title; t.Artist = x.Artist; }
        }
    }

    async Task CoverAsync(CdDisc d, string releaseId)
    {
        try
        {
            using var r = await Net.Http.GetAsync($"https://coverartarchive.org/release/{releaseId}/front-500");
            if (!r.IsSuccessStatusCode) return;
            var bytes = await r.Content.ReadAsByteArrayAsync();
            if (bytes.Length < 500 || d.ReleaseId != releaseId) return;
            d.Cover = bytes; d.CoverVersion++;
            Changed?.Invoke();
        }
        catch (Exception ex) { Log.Info("CD cover: " + ex.Message); }
    }

    /// <summary>Apply the release selected in the CD information comparison.</summary>
    public async Task ChooseRelease(string id, string discId = null)
    {
        var d = Disc ?? throw new InvalidOperationException("光碟已經退出");
        if (discId != null && d.Album.Id != discId) throw new InvalidOperationException("光碟已變更，請重新開啟 CD 資訊");
        var r = d.Releases.FirstOrDefault(x => x.Id == id) ?? throw new InvalidOperationException("找不到這個版本，請重新查找 CD 資訊");
        d.Cover = null;
        Apply(d, r);
        Changed?.Invoke();
        await CoverAsync(d, id);
    }

    public byte[] CoverImage(int size)
    {
        var c = Disc?.Cover;
        if (c == null) return null;
        try { return ArtworkService.Resize(c, size) ?? c; } catch { return c; }
    }

    public object Info()
    {
        var d = Disc;
        if (d == null) return new { disc = (object)null, ripping = Ripping };
        return new
        {
            disc = new
            {
                id = d.Album.Id, drive = d.Drive + ":", driveModel = d.DriveModel, mbid = d.MbId, lookup = d.Lookup, release = d.ReleaseId,
                title = d.Album.Title, artist = d.Album.Artist, year = d.Album.Year, cover = d.Cover != null, coverVer = d.CoverVersion,
                offset = KnownOffset(d),
                releases = d.Releases.Select(r => new { id = r.Id, title = r.Title, artist = r.Artist, date = r.Date, country = r.Country, label = r.Label,
                    tracks = r.Tracks.Select(t => new { no = t.No, title = t.Title, artist = t.Artist }) }),
                tracks = d.Tracks.Select(t => new { id = t.Id, no = t.TrackNo, title = t.Title, artist = t.Artist, dur = Math.Round(t.Duration, 2) }),
            },
            ripping = Ripping,
        };
    }

    string OffsetKey(CdDisc d) => "cdOffset:" + (string.IsNullOrWhiteSpace(d.DriveModel) ? d.Drive.ToString() : d.DriveModel);
    int? KnownOffset(CdDisc d) => _s.Ui != null && _s.Ui.TryGetValue(OffsetKey(d), out var v) && int.TryParse(v, out int o) ? o : null;

    // ───────────── playing: extract to a WAV in the cache ─────────────

    sealed class Extract { public long Frames, Total; public bool Done; public string Error; public Task Task; }
    readonly Dictionary<string, Extract> _extracts = new();

    static byte[] WavHeader(long dataBytes)
    {
        var h = new byte[44];
        Encoding.ASCII.GetBytes("RIFF").CopyTo(h, 0);
        BinaryPrimitives.WriteUInt32LittleEndian(h.AsSpan(4), (uint)(36 + dataBytes));
        Encoding.ASCII.GetBytes("WAVEfmt ").CopyTo(h, 8);
        BinaryPrimitives.WriteUInt32LittleEndian(h.AsSpan(16), 16);
        BinaryPrimitives.WriteUInt16LittleEndian(h.AsSpan(20), 1);
        BinaryPrimitives.WriteUInt16LittleEndian(h.AsSpan(22), 2);
        BinaryPrimitives.WriteUInt32LittleEndian(h.AsSpan(24), 44100);
        BinaryPrimitives.WriteUInt32LittleEndian(h.AsSpan(28), 44100 * 4);
        BinaryPrimitives.WriteUInt16LittleEndian(h.AsSpan(32), 4);
        BinaryPrimitives.WriteUInt16LittleEndian(h.AsSpan(34), 16);
        Encoding.ASCII.GetBytes("data").CopyTo(h, 36);
        BinaryPrimitives.WriteUInt32LittleEndian(h.AsSpan(40), (uint)dataBytes);
        return h;
    }

    /// <summary>The whole track is in the cache (playable without waiting, also for gapless).</summary>
    public bool IsReady(Track t)
    {
        lock (_extracts) if (_extracts.TryGetValue(t.Path, out var e)) return e.Done;
        var d = Disc; var toc = d?.Toc.Audio.FirstOrDefault(x => x.No == t.TrackNo);
        return toc != null && File.Exists(t.Path) && new FileInfo(t.Path).Length == 44 + (long)(d.Toc.EndOf(toc) - toc.Lba) * CdDrive.SectorBytes;
    }

    /// <summary>
    /// Before a CD track plays: makes sure it is being extracted and waits until enough of it is in the cache (20 s, or
    /// all of a shorter track) — the drive reads many times faster than playback, so it stays ahead. The tracks after
    /// it are extracted next, so the album keeps playing without waiting.
    /// </summary>
    public async Task Prepare(Track t, CancellationToken ct = default)
    {
        var d = Disc ?? throw new InvalidOperationException("光碟已經退出");
        if (!d.Tracks.Contains(t)) throw new InvalidOperationException("這張光碟不在光碟機裡");
        var e = Start(d, t);
        foreach (var next in d.Tracks.Where(x => x.TrackNo > t.TrackNo).Take(2)) Start(d, next);
        long need = Math.Min(e.Total, 44100L * 20);
        var until = DateTime.UtcNow.AddSeconds(90);
        while (!e.Done && Interlocked.Read(ref e.Frames) < need)
        {
            if (e.Error != null) throw new IOException("讀取光碟失敗：" + e.Error);
            if (DateTime.UtcNow > until) throw new TimeoutException("光碟讀取太慢");
            await Task.Delay(100, ct);
        }
        if (e.Error != null && !e.Done) throw new IOException("讀取光碟失敗：" + e.Error);
    }

    Extract Start(CdDisc d, Track t)
    {
        lock (_extracts)
        {
            if (_extracts.TryGetValue(t.Path, out var have) && have.Error == null) return have;
            var toc = d.Toc.Audio.First(x => x.No == t.TrackNo);
            int start = toc.Lba, end = d.Toc.EndOf(toc);
            var e = new Extract { Total = (long)(end - start) * CdDrive.SamplesPerSector };
            _extracts[t.Path] = e;
            if (IsComplete(t.Path, e.Total)) { e.Frames = e.Total; e.Done = true; return e; }
            e.Task = Task.Run(async () =>
            {
                try
                {
                    Directory.CreateDirectory(d.CacheDir);
                    long bytes = e.Total * 4;
                    using var fs = new FileStream(t.Path, FileMode.Create, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete, 1 << 16);
                    fs.Write(WavHeader(bytes));
                    fs.SetLength(44 + bytes);
                    fs.Position = 44;
                    const int chunk = 24;
                    var buf = new byte[chunk * CdDrive.SectorBytes];
                    for (int at = start; at < end; at += chunk)
                    {
                        if (Disc != d) throw new IOException("光碟已經退出");
                        int n = Math.Min(chunk, end - at);
                        await _drive.WaitAsync();
                        try
                        {
                            using var drv = CdDrive.Open(d.Drive);
                            drv.Read(at, n, d.Toc.Leadout, buf, 0);
                        }
                        finally { _drive.Release(); }
                        fs.Write(buf, 0, n * CdDrive.SectorBytes);
                        fs.Flush();
                        Interlocked.Add(ref e.Frames, n * CdDrive.SamplesPerSector);
                    }
                    e.Done = true;
                }
                catch (Exception ex) { e.Error = ex.Message; Log.Error("CD extract " + t.Path, ex); lock (_extracts) _extracts.Remove(t.Path); }
            });
            return e;
        }
    }

    static bool IsComplete(string path, long frames) => File.Exists(path) && new FileInfo(path).Length == 44 + frames * 4;

    // ───────────── ripping ─────────────

    public void CancelRip() { lock (_ripLock) _ripCts?.Cancel(); }

    /// <summary>
    /// Rips the chosen tracks: secure read (two passes compared, rereads until two reads agree), offset correction,
    /// AccurateRip, then FFmpeg to the chosen format with the tags. a: { opts, dir, tracks:[no], offset, meta }.
    /// </summary>
    public Task<object> Rip(JsonElement a, Func<string, string> safeName)
    {
        var d = Disc ?? throw new InvalidOperationException("光碟機裡沒有音樂 CD");
        var args = a.Clone();
        CancellationTokenSource cts;
        // Register cancellation before scheduling, so even an immediate Stop reaches the job.
        lock (_ripLock)
        {
            if (_ripCts != null) throw new InvalidOperationException("正在抓取光碟");
            cts = _ripCts = new CancellationTokenSource();
        }
        // Device reads and checksum work must not run on the WebView's UI thread.
        return Task.Run(async () =>
        {
            try { return await RipCore(d, args, safeName, cts.Token); }
            finally { lock (_ripLock) { _ripCts = null; cts.Dispose(); } }
        });
    }

    async Task<object> RipCore(CdDisc d, JsonElement a, Func<string, string> safeName, CancellationToken ct)
    {
        if (!Ffmpeg.Available) throw new InvalidOperationException("找不到 FFmpeg");
        var o = ConvertOptions.From(a.TryGetProperty("opts", out var oe) ? oe : default);
        string dir = a.TryGetProperty("dir", out var de) && de.ValueKind == JsonValueKind.String ? de.GetString() : null;
        if (string.IsNullOrWhiteSpace(dir) || !Directory.Exists(dir)) throw new InvalidOperationException("請先選擇要放檔案的資料夾");
        var want = a.TryGetProperty("tracks", out var te) && te.ValueKind == JsonValueKind.Array ? te.EnumerateArray().Select(x => x.GetInt32()).ToHashSet() : null;
        int? manual = a.TryGetProperty("offset", out var oo) && oo.ValueKind == JsonValueKind.Number ? oo.GetInt32() : null;

        // names: what the dialog sent (edited), else the disc's
        string album = d.Album.Title, albumArtist = d.Album.Artist, year = d.Album.Year > 0 ? d.Album.Year.ToString() : "", genre = "";
        var names = d.Tracks.ToDictionary(t => t.TrackNo, t => (t.Title, t.Artist));
        if (a.TryGetProperty("meta", out var me) && me.ValueKind == JsonValueKind.Object)
        {
            album = Str(me, "album") is { Length: > 0 } x1 ? x1 : album;
            albumArtist = me.TryGetProperty("artist", out _) ? Str(me, "artist") : albumArtist;
            year = me.TryGetProperty("year", out _) ? Str(me, "year") : year;
            genre = Str(me, "genre");
            if (me.TryGetProperty("tracks", out var mt) && mt.ValueKind == JsonValueKind.Array)
                foreach (var t in mt.EnumerateArray())
                    if (t.TryGetProperty("no", out var no) && no.TryGetInt32(out int n)) names[n] = (Str(t, "title"), Str(t, "artist"));
        }

        var audio = d.Toc.Audio;
        var jobs = d.Tracks.Where(t => want == null || want.Contains(t.TrackNo)).ToList();
        if (jobs.Count == 0) throw new InvalidOperationException("沒有選擇曲目");
        string folder = Path.Combine(dir, safeName(string.IsNullOrWhiteSpace(album) ? "音樂 CD" : album));
        Directory.CreateDirectory(folder);
        string ext = AudioConverter.Ext(o.Format);
        var log = new StringBuilder();
        void Report(object p) => RipProgress?.Invoke(p);
        int okCount = 0, arMatched = 0;
        var failed = new List<object>();
        string tmpDir = Path.Combine(Path.GetTempPath(), "miku-rip-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(tmpDir);
        try
        {
            log.AppendLine("MIKU 抓取紀錄  " + DateTime.Now.ToString("yyyy-MM-dd HH:mm"));
            log.AppendLine($"光碟機：{d.DriveModel} ({d.Drive}:)");
            log.AppendLine($"專輯：{albumArtist} / {album}");
            log.AppendLine($"MusicBrainz 光碟 ID：{d.MbId}");
            log.AppendLine("讀取方式：安全模式（每段讀兩次比對，不一致就重讀到兩次相同為止）");
            Report(new { state = "start", total = jobs.Count });

            var ar = await AccurateRip.FetchAsync(d.Toc, ct);
            log.AppendLine(ar == null ? "AccurateRip：這張光碟不在資料庫裡" : $"AccurateRip：資料庫裡有這張光碟（{ar.Tracks.Max(t => t.Count)} 種版本）");
            Report(new { state = "ar", found = ar != null });

            // the read offset: chosen in the dialog, known for this drive, or found now with AccurateRip on a middle track
            int? offset = manual ?? KnownOffset(d);
            const int Margin = 10;   // sectors read before and after a track (room for the offset)
            var raws = new Dictionary<int, (string File, int From, int Count, int Errors, int Rereads)>();
            if (offset == null && ar != null && audio.Count >= 3)
            {
                var probe = audio[audio.Count / 2];
                var job = jobs.FirstOrDefault(t => t.TrackNo == probe.No) ?? d.Tracks.First(t => t.TrackNo == probe.No);
                Report(new { state = "offset" });
                var raw = await SecureRead(d, probe, Margin, Path.Combine(tmpDir, $"{probe.No}.raw"), job.Id, Report, ct);
                raws[probe.No] = raw;
                int n = (d.Toc.EndOf(probe) - probe.Lba) * CdDrive.SamplesPerSector;
                if (new FileInfo(raw.File).Length < 400_000_000)
                {
                    var bytes = await File.ReadAllBytesAsync(raw.File, ct);
                    var samples = new uint[bytes.Length / 4];
                    Buffer.BlockCopy(bytes, 0, samples, 0, samples.Length * 4);
                    int at = (probe.Lba - raw.From) * CdDrive.SamplesPerSector;
                    int i = audio.IndexOf(probe);
                    offset = AccurateRip.FindOffset(samples, at, n, Margin * CdDrive.SamplesPerSector - 100, ar.Tracks[i]);
                }
                if (offset != null)
                {
                    (_s.Ui ??= new())[OffsetKey(d)] = offset.Value.ToString(CultureInfo.InvariantCulture);
                    log.AppendLine($"讀取偏移：{offset:+0;-0;0}（用 AccurateRip 找到，已記住這台光碟機）");
                }
            }
            if (offset == null) log.AppendLine("讀取偏移：未知，用 0（AccurateRip 比對可能不符）");
            else if (!log.ToString().Contains("讀取偏移")) log.AppendLine($"讀取偏移：{offset:+0;-0;0}");
            int off = offset ?? 0;
            Report(new { state = "offsetDone", offset = offset });
            log.AppendLine();

            byte[] picture = d.Cover;
            foreach (var t in jobs)
            {
                ct.ThrowIfCancellationRequested();
                var toc = audio.First(x => x.No == t.TrackNo);
                int idx = audio.IndexOf(toc);
                var (title, artist) = names.TryGetValue(t.TrackNo, out var nm) ? nm : (t.Title, t.Artist);
                try
                {
                    var raw = raws.TryGetValue(t.TrackNo, out var r0) ? r0 : await SecureRead(d, toc, Margin, Path.Combine(tmpDir, $"{t.TrackNo}.raw"), t.Id, Report, ct);
                    // the track's samples at the corrected offset → WAV, checksums on the way
                    long n = (long)(d.Toc.EndOf(toc) - toc.Lba) * CdDrive.SamplesPerSector;
                    long start = (long)(toc.Lba - raw.From) * CdDrive.SamplesPerSector + off;
                    string wav = Path.Combine(tmpDir, $"{t.TrackNo}.wav");
                    var sum = new AccurateRip.Summer(n, idx == 0, idx == audio.Count - 1);
                    await using (var src = new FileStream(raw.File, FileMode.Open, FileAccess.Read))
                    await using (var dst = new FileStream(wav, FileMode.Create, FileAccess.Write))
                    {
                        dst.Write(WavHeader(n * 4));
                        var buf = new byte[1 << 20];
                        long rawSamples = src.Length / 4;
                        for (long done = 0; done < n;)
                        {
                            int want4 = (int)Math.Min(buf.Length / 4, n - done);
                            long from = start + done;
                            Array.Clear(buf, 0, want4 * 4);
                            long a0 = Math.Max(from, 0), a1 = Math.Min(from + want4, rawSamples);
                            if (a1 > a0)
                            {
                                src.Position = a0 * 4;
                                int need = (int)(a1 - a0) * 4, got = 0, at = (int)(a0 - from) * 4;
                                while (got < need) { int k = src.Read(buf, at + got, need - got); if (k <= 0) break; got += k; }
                            }
                            sum.Add(buf.AsSpan(0, want4 * 4));
                            dst.Write(buf, 0, want4 * 4);
                            done += want4;
                        }
                    }
                    // AccurateRip
                    string arText; string arState; int conf = 0;
                    if (ar == null) { arState = "none"; arText = "不在資料庫"; }
                    else
                    {
                        var entries = ar.Tracks[idx];
                        var hits = entries.Where(e => e.Crc == sum.V1 || e.Crc == sum.V2).ToList();
                        if (hits.Count > 0) { arState = "match"; conf = hits.Max(e => e.Conf); arText = $"相符（信心 {conf}）"; arMatched++; }
                        else if (entries.Count == 0) { arState = "none"; arText = "這首不在資料庫"; }
                        else { arState = "mismatch"; arText = "不符"; }
                    }
                    Report(new { state = "encode", id = t.Id, pct = 0.0 });
                    // encode
                    var meta = new Dictionary<string, string>
                    {
                        ["title"] = string.IsNullOrWhiteSpace(title) ? $"Track {t.TrackNo}" : title,
                        ["artist"] = string.IsNullOrWhiteSpace(artist) ? albumArtist : artist,
                        ["album"] = album, ["album_artist"] = albumArtist, ["date"] = year, ["genre"] = genre,
                        ["track"] = $"{t.TrackNo}/{audio[^1].No}", ["disc"] = "1",
                    };
                    var src2 = new Track { Path = wav, Codec = "WAV", Bits = 16, SampleRate = 44100, Channels = 2, Duration = n / 44100.0, Title = meta["title"] };
                    string stem = safeName($"{t.TrackNo:00}. {meta["title"]}");
                    string target = Path.Combine(folder, stem + ext);
                    for (int k = 2; File.Exists(target); k++) target = Path.Combine(folder, $"{stem} ({k}){ext}");
                    double last = -1;
                    await AudioConverter.Convert(src2, target, o, 0, o.Cover ? picture : null, x =>
                    {
                        double p = Math.Round(x, 2);
                        if (p != last) { last = p; Report(new { state = "encode", id = t.Id, pct = p }); }
                    }, ct, 0, 0, meta);
                    okCount++;
                    log.AppendLine($"第 {t.TrackNo:00} 首  {meta["title"]}");
                    log.AppendLine($"    讀取錯誤 {raw.Errors} 個磁區，重讀 {raw.Rereads} 次");
                    log.AppendLine($"    AccurateRip v1 {sum.V1:X8}  v2 {sum.V2:X8}  {arText}");
                    log.AppendLine($"    → {Path.GetFileName(target)}");
                    Report(new { state = "done", id = t.Id, ar = arState, conf, errors = raw.Errors, rereads = raw.Rereads });
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex)
                {
                    Log.Error("CD rip track " + t.TrackNo, ex);
                    failed.Add(new { no = t.TrackNo, error = ex.Message });
                    log.AppendLine($"第 {t.TrackNo:00} 首  失敗：{ex.Message}");
                    Report(new { state = "fail", id = t.Id, error = ex.Message });
                }
                finally
                {
                    try { if (raws.TryGetValue(t.TrackNo, out var rr)) File.Delete(rr.File); } catch { }
                    try { File.Delete(Path.Combine(tmpDir, $"{t.TrackNo}.raw")); File.Delete(Path.Combine(tmpDir, $"{t.TrackNo}.wav")); } catch { }
                }
            }
            log.AppendLine();
            log.AppendLine($"完成 {okCount} / {jobs.Count} 首，AccurateRip 相符 {arMatched} 首");
            try { await File.WriteAllTextAsync(Path.Combine(folder, safeName(album) + ".log"), log.ToString(), new UTF8Encoding(true)); } catch { }
            return new { done = okCount, total = jobs.Count, arMatched, ar = ar != null, offset, failed, cancelled = false, dir = folder };
        }
        catch (OperationCanceledException)
        {
            return new { done = okCount, total = jobs.Count, arMatched, ar = false, offset = (int?)null, failed, cancelled = true, dir = folder };
        }
        finally
        {
            try { Directory.Delete(tmpDir, true); } catch { }
        }
    }

    /// <summary>
    /// Secure read of a track (plus <paramref name="margin"/> sectors each side) into a raw file of 16-bit stereo:
    /// pass 1 reads everything, pass 2 reads it again and compares block by block; a block that differs is read again
    /// (after reading somewhere else, so the drive's cache doesn't answer) until two reads agree.
    /// </summary>
    async Task<(string File, int From, int Count, int Errors, int Rereads)> SecureRead(CdDisc d, CdTocTrack toc, int margin, string file, string id,
        Action<object> report, CancellationToken ct)
    {
        int leadout = d.Toc.Leadout;
        int from = toc.Lba - margin, to = d.Toc.EndOf(toc) + margin;
        int count = to - from;
        const int Block = 24;
        int blocks = (count + Block - 1) / Block;
        int errors = 0, rereads = 0;
        var a = new byte[Block * CdDrive.SectorBytes];
        var b = new byte[Block * CdDrive.SectorBytes];
        var bust = new byte[Block * CdDrive.SectorBytes];
        int far = toc.Lba > leadout / 2 ? 0 : leadout - 3000;   // somewhere else on the disc, to empty the drive's cache

        async Task<int> ReadBlock(int at, int n, byte[] dst)
        {
            await _drive.WaitAsync(ct);
            try { using var drv = CdDrive.Open(d.Drive); return drv.Read(at, n, leadout, dst, 0); }
            finally { _drive.Release(); }
        }
        async Task Bust(int sectors)
        {
            for (int k = 0; k < sectors; k += Block) await ReadBlock(Math.Max(0, far + k), Block, bust);
        }

        await using var fs = new FileStream(file, FileMode.Create, FileAccess.ReadWrite, FileShare.Read);
        fs.SetLength((long)count * CdDrive.SectorBytes);
        // pass 1
        double lastPct = -1;
        void Pct(double p) { p = Math.Round(p, 3); if (p - lastPct >= 0.005 || p >= 1) { lastPct = p; report(new { state = "read", id, pct = p }); } }
        for (int i = 0; i < blocks; i++)
        {
            ct.ThrowIfCancellationRequested();
            int at = from + i * Block, n = Math.Min(Block, to - at);
            errors += await ReadBlock(at, n, a);
            fs.Position = (long)i * Block * CdDrive.SectorBytes;
            await fs.WriteAsync(a.AsMemory(0, n * CdDrive.SectorBytes), ct);
            Pct(i * 0.5 / blocks);
        }
        // a short track may still be in the drive's cache: read elsewhere first
        if ((long)count * CdDrive.SectorBytes < 16L << 20) await Bust(1600);
        // pass 2: compare
        for (int i = 0; i < blocks; i++)
        {
            ct.ThrowIfCancellationRequested();
            int at = from + i * Block, n = Math.Min(Block, to - at), len = n * CdDrive.SectorBytes;
            await ReadBlock(at, n, b);
            fs.Position = (long)i * Block * CdDrive.SectorBytes;
            int got = 0; while (got < len) { int k = await fs.ReadAsync(a.AsMemory(got, len - got), ct); if (k <= 0) break; got += k; }
            if (!a.AsSpan(0, len).SequenceEqual(b.AsSpan(0, len)))
            {
                // differ: read until some version has been read twice
                var seen = new List<(byte[] Data, int Count)> { (a.AsSpan(0, len).ToArray(), 1) };
                void Seen(byte[] x)
                {
                    for (int k = 0; k < seen.Count; k++) if (seen[k].Data.AsSpan().SequenceEqual(x)) { seen[k] = (seen[k].Data, seen[k].Count + 1); return; }
                    seen.Add((x, 1));
                }
                Seen(b.AsSpan(0, len).ToArray());
                for (int tries = 0; tries < 20 && seen.Max(s => s.Count) < 2; tries++)
                {
                    await Bust(48);
                    await ReadBlock(at, n, b);
                    rereads++;
                    Seen(b.AsSpan(0, len).ToArray());
                }
                var best = seen.OrderByDescending(s => s.Count).First();
                if (best.Count < 2) errors += n;   // never read the same twice: suspicious
                fs.Position = (long)i * Block * CdDrive.SectorBytes;
                await fs.WriteAsync(best.Data, ct);
            }
            Pct(0.5 + i * 0.5 / blocks);
        }
        Pct(1);
        return (file, from, count, errors, rereads);
    }
}
