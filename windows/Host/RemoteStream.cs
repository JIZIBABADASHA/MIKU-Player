using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Miku.Audio;
using Miku.Library;

namespace Miku.Host;

/// <summary>
/// 「在手機上聽」: /stream/{trackId} sends a library track to a paired phone, which plays it itself. A file the phone's
/// browser can play (it lists them in c=) goes as it is, with Range support so the phone can seek in it; anything else
/// (DSD, APE, WMA…), or a lossless track when a lower quality (q=128…320) is asked for, is encoded by FFmpeg to MP3 as
/// it is sent. Such a stream has no length, so the phone seeks by asking again with ss= (seconds).
/// </summary>
public sealed partial class RemoteServer
{
    /// <summary>Finds a library track by id for /stream/ (set by the host).</summary>
    public Func<string, Track> TrackResolver { get; set; }

    static readonly Regex StreamRangeRx = new(@"^bytes=(\d*)-(\d*)$", RegexOptions.Compiled);
    static int _transcodes;
    const int MaxTranscodes = 6;

    /// <summary>
    /// Addresses a phone may pair from: the home network (10/8, 172.16/12, 192.168/16, link-local), this computer and
    /// Tailscale (100.64/10). A stranger on the internet (an opened router port) can't even ask for a pairing code.
    /// </summary>
    public static bool IsLocalNetwork(string ip)
    {
        if (!IPAddress.TryParse(ip, out var a)) return false;
        if (a.IsIPv4MappedToIPv6) a = a.MapToIPv4();
        if (IPAddress.IsLoopback(a)) return true;
        var b = a.GetAddressBytes();
        if (a.AddressFamily == AddressFamily.InterNetwork)
            return b[0] == 10 || (b[0] == 172 && (b[1] & 0xF0) == 16) || (b[0] == 192 && b[1] == 168)
                   || (b[0] == 169 && b[1] == 254) || IsTailscale(a);
        return a.IsIPv6LinkLocal || (b[0] & 0xFE) == 0xFC;
    }

    /// <summary>Tailscale gives each device an address in 100.64.0.0/10.</summary>
    public static bool IsTailscale(IPAddress a) => a.AddressFamily == AddressFamily.InterNetwork && a.GetAddressBytes() is var b && b[0] == 100 && (b[1] & 0xC0) == 64;

    /// <summary>The phone-side name (as the page's c= list spells it) and MIME type of a file that can go as it is.</summary>
    static (string cap, string mime)? DirectFormat(Track t) => t.Codec switch
    {
        "MP3" => ("mp3", "audio/mpeg"),
        "AAC" => ("aac", t.Ext == ".aac" ? "audio/aac" : "audio/mp4"),
        "ALAC" => ("alac", "audio/mp4"),
        "FLAC" => ("flac", "audio/flac"),
        "WAV" when t.Bits is > 0 and <= 24 => ("wav", "audio/wav"),
        "OGG" => ("ogg", "audio/ogg"),
        "OPUS" => ("opus", "audio/ogg"),
        _ => null,
    };

    /// <returns>Whether the connection can serve another request.</returns>
    async Task<bool> RunStream(NetworkStream s, Request req, bool keep, CancellationToken ct)
    {
        string id = Uri.UnescapeDataString(req.Path[8..]);
        Track t = null;
        try { t = TrackResolver?.Invoke(id); } catch (Exception ex) { Log.Error("Remote stream track", ex); }
        if (t == null || t.IsLive || string.IsNullOrEmpty(t.Path) || id.StartsWith("cd-") || !File.Exists(t.Path))
        {
            await Send(s, req, 404, "text/plain", Utf8("not found"), keep, "Cache-Control: no-store\r\n");
            return keep;
        }
        var q = req.QueryArgs;
        int kbps = q?["q"] switch { "128" => 128, "192" => 192, "256" => 256, "320" => 320, _ => 0 };   // 0: original
        var caps = new HashSet<string>((q?["c"] ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries), StringComparer.OrdinalIgnoreCase);
        double.TryParse(q?["ss"], NumberStyles.Float, CultureInfo.InvariantCulture, out double ss);
        // raw=1: another MIKU (the Mac's 遠端音樂庫) copies the file as it is, whatever its format, and plays it with its
        // own engine; X-Miku-Ext tells it what kind of file it is
        if (q?["raw"] == "1")
            return await SendFile(s, req, t.Path, "application/octet-stream", keep, ct, $"X-Miku-Ext: {Path.GetExtension(t.Path).ToLowerInvariant()}\r\n");
        var direct = DirectFormat(t);
        // a lossy file the phone can play always goes as it is (encoding it again only loses more); the page makes the
        // same choice from the codec alone (Local.direct in remote/app.js), so it knows whether it can seek in it
        bool asIs = direct != null && caps.Contains(direct.Value.cap) && (kbps == 0 || t.IsLossy);
        if (asIs) return await SendFile(s, req, t.Path, direct.Value.mime, keep, ct);
        await Transcode(s, req, t, kbps == 0 ? 320 : kbps, Math.Max(0, ss), ct);
        return false;
    }

    static async Task<bool> SendFile(NetworkStream s, Request req, string path, string mime, bool keep, CancellationToken ct, string extra = null)
    {
        FileStream fs;
        // FileShare.Delete: the file can still be moved or deleted in Explorer while the phone plays it
        try { fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16, true); }
        catch (Exception ex)
        {
            Log.Error("Remote stream open " + path, ex);
            await Send(s, req, 404, "text/plain", Utf8("not found"), keep, "Cache-Control: no-store\r\n");
            return keep;
        }
        await using (fs)
        {
            long size = fs.Length, start = 0, end = size - 1;
            bool partial = false;
            var m = StreamRangeRx.Match(req.Header("Range") ?? "");
            if (m.Success)
            {
                string a = m.Groups[1].Value, b = m.Groups[2].Value;
                if (a == "" && b != "") { if (long.TryParse(b, out long n)) start = Math.Max(0, size - n); }
                else
                {
                    if (a != "" && long.TryParse(a, out long st)) start = st;
                    if (b != "" && long.TryParse(b, out long en)) end = Math.Min(size - 1, en);
                }
                if (start >= size || end < start)
                {
                    await Send(s, req, 416, "text/plain", Array.Empty<byte>(), keep, $"Content-Range: bytes */{size}\r\n");
                    return keep;
                }
                partial = true;
            }
            long len = end - start + 1;
            var head = new StringBuilder();
            head.Append(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
            head.Append($"Content-Type: {mime}\r\nContent-Length: {len}\r\nAccept-Ranges: bytes\r\nCache-Control: private, no-store\r\n");
            if (partial) head.Append($"Content-Range: bytes {start}-{end}/{size}\r\n");
            if (extra != null) head.Append(extra);
            head.Append(keep ? "Connection: keep-alive\r\n" : "Connection: close\r\n").Append("\r\n");
            await s.WriteAsync(Utf8(head.ToString()), ct);
            if (req.Method != "HEAD")
            {
                fs.Position = start;
                var buf = new byte[1 << 16];
                long left = len;
                while (left > 0)
                {
                    int n = await fs.ReadAsync(buf.AsMemory(0, (int)Math.Min(buf.Length, left)), ct);
                    if (n <= 0) return false;   // the file got shorter: the length sent is wrong, so close
                    await s.WriteAsync(buf.AsMemory(0, n), ct);
                    left -= n;
                }
            }
            await s.FlushAsync(ct);
            return keep;
        }
    }

    static async Task Transcode(NetworkStream s, Request req, Track t, int kbps, double ss, CancellationToken ct)
    {
        if (!Ffmpeg.Available)
        {
            await Send(s, req, 415, "text/plain", Utf8("這首歌的格式需要 FFmpeg 轉換才能在手機上播放，但電腦上找不到 FFmpeg。"), false, "Cache-Control: no-store\r\n");
            return;
        }
        if (Interlocked.Increment(ref _transcodes) > MaxTranscodes)
        {
            Interlocked.Decrement(ref _transcodes);
            await Send(s, req, 503, "text/plain", Utf8("busy"), false, "Cache-Control: no-store\r\nRetry-After: 2\r\n");
            return;
        }
        System.Diagnostics.Process p = null;
        try
        {
            var enc = AudioConverter.Encoders();
            bool mp3 = enc.Contains("libmp3lame");
            string aac = new[] { "aac", "aac_mf" }.FirstOrDefault(enc.Contains);
            if (!mp3 && aac == null)
            {
                await Send(s, req, 415, "text/plain", Utf8("電腦上的 FFmpeg 沒有 MP3 / AAC 編碼器。"), false, "Cache-Control: no-store\r\n");
                return;
            }
            int rate = Formats.Family(t.SampleRate > 0 ? t.SampleRate : 44100);
            var args = new List<string> { "-nostdin", "-hide_banner", "-loglevel", "error" };
            if (ss > 0.01) { args.Add("-ss"); args.Add(ss.ToString("0.000", CultureInfo.InvariantCulture)); }
            // over 127.0.0.1 HTTP, not by path, like playback: the file stays deletable while it streams
            args.AddRange(new[] { "-i", FileServer.Url(t.Path), "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "2", "-ar", rate.ToString(CultureInfo.InvariantCulture) });
            if (mp3) args.AddRange(new[] { "-c:a", "libmp3lame", "-b:a", kbps + "k", "-write_xing", "0", "-id3v2_version", "0", "-f", "mp3", "pipe:1" });
            else args.AddRange(new[] { "-c:a", aac, "-b:a", kbps + "k", "-f", "adts", "pipe:1" });
            p = Ffmpeg.Start(args);
            if (p == null) throw new IOException("無法啟動 FFmpeg");
            _ = p.StandardError.ReadToEndAsync();
            // no Content-Length: the stream ends when FFmpeg is done and the connection closes
            await s.WriteAsync(Utf8($"HTTP/1.1 200 OK\r\nContent-Type: {(mp3 ? "audio/mpeg" : "audio/aac")}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"), ct);
            if (req.Method != "HEAD") await p.StandardOutput.BaseStream.CopyToAsync(s, 1 << 15, ct);
            await s.FlushAsync(ct);
        }
        finally
        {
            // the phone skipped, seeked or went away: stop encoding
            try { if (p != null && !p.HasExited) p.Kill(true); } catch { }
            p?.Dispose();
            Interlocked.Decrement(ref _transcodes);
        }
    }
}
