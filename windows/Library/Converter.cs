using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Miku.Audio;

namespace Miku.Library;

/// <summary>What 「轉換格式」 makes: the format and its settings (the page's convert dialog).</summary>
public sealed class ConvertOptions
{
    public string Format { get; set; } = "flac";      // flac | alac | wav | mp3 | aac | opus
    public int FlacLevel { get; set; } = 5;            // 0–8
    public string Mp3 { get; set; } = "v0";            // v0 | v2 | 320 | 256 | 192
    public int AacKbps { get; set; } = 256;
    public int OpusKbps { get; set; } = 160;
    public string Bits { get; set; } = "keep";         // keep | 16 | 24 (lossless formats)
    public string Rate { get; set; } = "keep";         // keep | 44100 | 48000 | 88200 | 96000
    public bool Cover { get; set; } = true;            // put the picture into the new file
    public bool AlbumFolder { get; set; } = true;      // a folder per album (choose-a-folder mode)

    public static ConvertOptions From(JsonElement a)
    {
        var o = new ConvertOptions();
        if (a.ValueKind != JsonValueKind.Object) return o;
        string S(string n, string d) => a.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : d;
        int I(string n, int d) => a.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : d;
        bool B(string n, bool d) => a.TryGetProperty(n, out var v) ? v.ValueKind == JsonValueKind.True : d;
        o.Format = S("format", o.Format); o.FlacLevel = Math.Clamp(I("flacLevel", 5), 0, 8); o.Mp3 = S("mp3", o.Mp3);
        o.AacKbps = Math.Clamp(I("aacKbps", 256), 64, 320); o.OpusKbps = Math.Clamp(I("opusKbps", 160), 32, 510);
        o.Bits = S("bits", o.Bits); o.Rate = S("rate", o.Rate); o.Cover = B("cover", true); o.AlbumFolder = B("albumFolder", true);
        return o;
    }
}

/// <summary>
/// Converts music files with FFmpeg (album / track menu 「轉換格式…」): WAV / ALAC / DSD… to FLAC, anything to MP3,
/// AAC, Opus, ALAC or WAV. Tags are carried over (-map_metadata) and the picture is put into the new file (FLAC,
/// MP3, M4A). A file is written under a temporary name and renamed only when FFmpeg finished, so a cancelled or
/// failed conversion never leaves half a file behind.
/// </summary>
public static class AudioConverter
{
    public static readonly string[] Lossless = { "flac", "alac", "wav" };

    public static string Ext(string format) => format switch
    {
        "flac" => ".flac", "alac" => ".m4a", "wav" => ".wav", "mp3" => ".mp3", "aac" => ".m4a", "opus" => ".opus",
        _ => throw new InvalidOperationException("不支援的格式：" + format),
    };

    static HashSet<string> _encoders;
    static readonly object Gate = new();

    /// <summary>The encoders the FFmpeg in use has (asked once).</summary>
    static HashSet<string> Encoders()
    {
        lock (Gate)
        {
            if (_encoders != null) return _encoders;
            var set = new HashSet<string>();
            try
            {
                using var p = Ffmpeg.Start(new[] { "-hide_banner", "-encoders" });
                string all = p.StandardOutput.ReadToEnd();
                p.WaitForExit(5000);
                foreach (var line in all.Split('\n'))
                {
                    var parts = line.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length >= 2 && parts[0].Length == 6 && parts[0][0] == 'A') set.Add(parts[1]);
                }
            }
            catch (Exception ex) { Log.Error("ffmpeg -encoders", ex); }
            return _encoders = set;
        }
    }

    /// <summary>The formats the page offers, and whether this FFmpeg can make each.</summary>
    public static object Info(string trash)
    {
        bool ff = Ffmpeg.Available;
        var e = ff ? Encoders() : new HashSet<string>();
        bool Has(params string[] names) => names.Any(e.Contains);
        return new
        {
            ffmpeg = ff,
            trash,
            formats = new[]
            {
                new { id = "flac", name = "FLAC", ok = Has("flac") },
                new { id = "alac", name = "ALAC", ok = Has("alac") },
                new { id = "wav", name = "WAV", ok = Has("pcm_s16le") },
                new { id = "mp3", name = "MP3", ok = Has("libmp3lame") },
                new { id = "aac", name = "AAC", ok = Has("aac", "aac_mf", "aac_at") },
                new { id = "opus", name = "Opus", ok = Has("libopus", "opus") },
            },
        };
    }

    /// <summary>
    /// Converts one track into <paramref name="target"/> (which must not exist). <paramref name="progress"/> gets 0–1.
    /// Throws with a message for the user when FFmpeg fails.
    /// </summary>
    /// <param name="start">A part of the file only (CUE tracks): from here, <paramref name="length"/> seconds.</param>
    /// <param name="meta">Tags to write instead of the file's own (CUE tracks).</param>
    public static async Task Convert(Track t, string target, ConvertOptions o, int dsdRate, byte[] picture, Action<double> progress, CancellationToken ct,
        double start = 0, double length = 0, IDictionary<string, string> meta = null)
    {
        string fmt = o.Format;
        bool lossless = Lossless.Contains(fmt);
        var args = new List<string> { "-hide_banner", "-nostdin", "-loglevel", "error", "-nostats", "-progress", "pipe:1" };
        if (length > 0) args.AddRange(new[] { "-ss", start.ToString("0.######", CultureInfo.InvariantCulture), "-t", length.ToString("0.######", CultureInfo.InvariantCulture) });
        args.AddRange(new[] { "-i", t.Path });
        double dur = length > 0 ? length : t.Duration;
        string picFile = null;
        bool coverOk = o.Cover && fmt is "flac" or "mp3" or "alac" or "aac";
        string picExt = picture == null ? null : PictureExt(picture);
        if (coverOk && picExt != null)
        {
            picFile = Path.Combine(Path.GetTempPath(), "miku-cover-" + Guid.NewGuid().ToString("N")[..10] + picExt);
            await File.WriteAllBytesAsync(picFile, picture, ct);
            args.AddRange(new[] { "-i", picFile });
        }
        args.AddRange(new[] { "-map", "0:a:0", "-map_metadata", meta == null ? "0" : "-1" });
        if (meta != null)
            foreach (var (k, v) in meta)
                if (!string.IsNullOrWhiteSpace(v)) args.AddRange(new[] { "-metadata", $"{k}={v}" });
        if (picFile != null)
            args.AddRange(new[] { "-map", "1:0", "-c:v", "copy", "-disposition:v:0", "attached_pic", "-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)" });
        else args.Add("-vn");

        // sample rate and bit depth (lossless): as the source unless chosen; DSD becomes PCM at the playback setting's rate
        int rate = 0;
        if (o.Rate != "keep" && int.TryParse(o.Rate, out int r) && r > 0) rate = r;
        else if (t.IsDsd) rate = dsdRate > 0 ? dsdRate : 176400;
        int bits = 0;
        if (lossless)
        {
            int src = t.IsDsd ? 24 : t.Bits <= 0 ? 16 : t.Bits;
            bits = o.Bits == "16" ? 16 : o.Bits == "24" ? 24 : src <= 16 ? 16 : 24;
        }
        var af = new List<string>();
        // fewer bits than the source has: TPDF dither instead of plain truncation
        bool fewerBits = lossless && bits == 16 && (t.IsDsd || t.Bits > 16 || (t.Bits <= 0 && !t.IsLossy));
        // DSD: low-passed and 1 dB of headroom, as MIKU decodes it for playback (DSD's ultrasonic noise, its +3 dB peaks)
        if (t.IsDsd) af.Add($"aresample={rate}:filter_size=64:cutoff=0.97" + (fewerBits ? ":dither_method=triangular" : "") + ",volume=-1dB");
        else if (rate > 0 || fewerBits) af.Add("aresample=" + (rate > 0 ? $"{rate}:" : "") + "dither_method=triangular");
        if (af.Count > 0) args.AddRange(new[] { "-af", string.Join(",", af) });
        if (rate > 0) args.AddRange(new[] { "-ar", rate.ToString(CultureInfo.InvariantCulture) });

        switch (fmt)
        {
            case "flac":
                args.AddRange(new[] { "-c:a", "flac", "-compression_level", o.FlacLevel.ToString(CultureInfo.InvariantCulture), "-sample_fmt", bits == 16 ? "s16" : "s32" });
                if (bits == 24) args.AddRange(new[] { "-bits_per_raw_sample", "24" });
                args.AddRange(new[] { "-f", "flac" });
                break;
            case "alac":
                args.AddRange(new[] { "-c:a", "alac", "-sample_fmt", bits == 16 ? "s16p" : "s32p" });
                if (bits == 24) args.AddRange(new[] { "-bits_per_raw_sample", "24" });
                args.AddRange(new[] { "-f", "ipod" });
                break;
            case "wav":
                args.AddRange(new[] { "-c:a", bits == 16 ? "pcm_s16le" : "pcm_s24le", "-f", "wav" });
                break;
            case "mp3":
                args.AddRange(new[] { "-c:a", "libmp3lame" });
                args.AddRange(o.Mp3 switch
                {
                    "v2" => new[] { "-q:a", "2" },
                    "320" => new[] { "-b:a", "320k" },
                    "256" => new[] { "-b:a", "256k" },
                    "192" => new[] { "-b:a", "192k" },
                    _ => new[] { "-q:a", "0" },
                });
                args.AddRange(new[] { "-id3v2_version", "3", "-write_id3v1", "0", "-f", "mp3" });
                break;
            case "aac":
            {
                var e = Encoders();
                string enc = e.Contains("aac_at") ? "aac_at" : "aac";
                args.AddRange(new[] { "-c:a", enc, "-b:a", o.AacKbps + "k", "-f", "ipod" });
                break;
            }
            case "opus":
            {
                var e = Encoders();
                if (e.Contains("libopus")) args.AddRange(new[] { "-c:a", "libopus" });
                else args.AddRange(new[] { "-c:a", "opus", "-strict", "-2" });
                args.AddRange(new[] { "-b:a", o.OpusKbps + "k", "-f", "opus" });
                break;
            }
            default: throw new InvalidOperationException("不支援的格式：" + fmt);
        }
        string part = target + ".miku-part";
        args.AddRange(new[] { "-y", part });

        try
        {
            using var p = Ffmpeg.Start(args);
            var err = p.StandardError.ReadToEndAsync();
            using (ct.Register(() => { try { if (!p.HasExited) p.Kill(true); } catch { } }))
            {
                string line;
                while ((line = await p.StandardOutput.ReadLineAsync()) != null)
                {
                    if (line.StartsWith("out_time_us=") && long.TryParse(line[12..], out long us) && dur > 0)
                        progress?.Invoke(Math.Clamp(us / 1e6 / dur, 0, 1));
                }
                await p.WaitForExitAsync();
            }
            ct.ThrowIfCancellationRequested();
            string msg = (await err).Trim();
            if (p.ExitCode != 0 || !File.Exists(part) || new FileInfo(part).Length == 0)
                throw new InvalidOperationException(msg.Length > 0 ? msg.Split('\n').Last().Trim() : "FFmpeg 結束代碼 " + p.ExitCode);
            File.Move(part, target);
            progress?.Invoke(1);
        }
        finally
        {
            try { if (File.Exists(part)) File.Delete(part); } catch { }
            try { if (picFile != null) File.Delete(picFile); } catch { }
        }
    }

    /// <summary>.jpg / .png for a picture FFmpeg can put into a file as it is; null for other kinds (WebP…).</summary>
    static string PictureExt(byte[] b)
    {
        if (b.Length > 3 && b[0] == 0xFF && b[1] == 0xD8) return ".jpg";
        if (b.Length > 8 && b[0] == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return ".png";
        return null;
    }

    static readonly char[] Bad = Path.GetInvalidFileNameChars();

    /// <summary>A folder / file name made safe for the file system.</summary>
    public static string SafeName(string s)
    {
        s = new string((s ?? "").Select(c => Bad.Contains(c) || c < 32 ? '_' : c).ToArray()).Trim().TrimEnd('.', ' ');
        return s.Length == 0 ? "_" : s.Length > 120 ? s[..120].TrimEnd() : s;
    }

    /// <summary>
    /// Sends a file to the Recycle Bin (it can be restored), so 取代原本的檔案 never loses the original for good.
    /// </summary>
    public static void Recycle(string path)
    {
        var op = new SHFILEOPSTRUCT
        {
            wFunc = 3,                                // FO_DELETE
            pFrom = path + "\0\0",
            fFlags = 0x0040 | 0x0010 | 0x0400 | 0x0004, // FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT
        };
        int rc = SHFileOperation(ref op);
        if (rc != 0 || op.fAnyOperationsAborted || File.Exists(path)) throw new IOException("無法把原本的檔案移到資源回收筒（代碼 " + rc + "）");
    }

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    struct SHFILEOPSTRUCT
    {
        public IntPtr hwnd;
        public uint wFunc;
        public string pFrom;
        public string pTo;
        public ushort fFlags;
        [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)] public bool fAnyOperationsAborted;
        public IntPtr hNameMappings;
        public string lpszProgressTitle;
    }

    [System.Runtime.InteropServices.DllImport("shell32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
}
