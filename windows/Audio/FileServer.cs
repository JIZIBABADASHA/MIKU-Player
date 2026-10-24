using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Miku.Audio;

/// <summary>
/// Hands audio files to FFmpeg over HTTP on 127.0.0.1 instead of by path, so a track that is playing can still be
/// deleted or moved in Explorer: FFmpeg opens files without FILE_SHARE_DELETE, this server opens them with it.
/// HTTP (not a pipe) because FFmpeg needs to seek: MP3 gapless trimming, Ogg / Opus / WMA / Matroska seeking and MP4
/// files with the index at the end only work on seekable input; through this server the decoded output is identical to
/// reading the file. Only files registered with <see cref="Url"/> are served, under a random name per file.
/// </summary>
public static class FileServer
{
    static readonly ConcurrentDictionary<string, string> _tokenToPath = new();
    static readonly ConcurrentDictionary<string, string> _pathToToken = new(StringComparer.OrdinalIgnoreCase);
    static readonly object _startLock = new();
    static TcpListener _listener;
    static int _port;
    static readonly Regex RangeRx = new(@"^bytes=(\d*)-(\d*)$", RegexOptions.Compiled);

    /// <summary>The URL FFmpeg reads <paramref name="path"/> from; the path itself when the server can't start.</summary>
    public static string Url(string path)
    {
        if (!EnsureStarted()) return path;
        string token = _pathToToken.GetOrAdd(path, p =>
        {
            string t = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
            _tokenToPath[t] = p;
            return t;
        });
        // keep the extension: some demuxers use it as a hint
        return $"http://127.0.0.1:{_port}/{token}/a{Path.GetExtension(path)}";
    }

    static bool EnsureStarted()
    {
        if (_listener != null) return true;
        lock (_startLock)
        {
            if (_listener != null) return true;
            try
            {
                var l = new TcpListener(IPAddress.Loopback, 0);
                l.Start();
                _port = ((IPEndPoint)l.LocalEndpoint).Port;
                _listener = l;
                _ = Task.Run(AcceptLoop);
                return true;
            }
            catch (Exception ex) { Log.Error("FileServer", ex); return false; }
        }
    }

    static async Task AcceptLoop()
    {
        while (true)
        {
            TcpClient c;
            try { c = await _listener.AcceptTcpClientAsync(); }
            catch { return; }
            _ = Task.Run(() => Serve(c));
        }
    }

    static async Task Serve(TcpClient client)
    {
        using (client)
        {
            try
            {
                client.NoDelay = true;
                var net = client.GetStream();
                var headers = new HeaderReader(net);
                var buf = new byte[1 << 16];
                // HTTP/1.1 keep-alive: FFmpeg may send several requests on one connection
                while (true)
                {
                    string head = await headers.Read();
                    if (head == null) return;
                    var lines = head.Split("\r\n");
                    var req = lines[0].Split(' ');
                    if (req.Length < 2) return;
                    string method = req[0], target = req[1], range = null;
                    bool close = false;
                    foreach (var h in lines)
                    {
                        if (h.StartsWith("Range:", StringComparison.OrdinalIgnoreCase)) range = h[6..].Trim();
                        else if (h.StartsWith("Connection:", StringComparison.OrdinalIgnoreCase) && h.Contains("close", StringComparison.OrdinalIgnoreCase)) close = true;
                    }
                    var parts = target.TrimStart('/').Split('/');
                    if (parts.Length < 1 || !_tokenToPath.TryGetValue(parts[0], out var path)) { await Reply(net, "404 Not Found", 0, null, true); return; }
                    FileStream fs;
                    try { fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16, FileOptions.Asynchronous | FileOptions.SequentialScan); }
                    catch { await Reply(net, "404 Not Found", 0, null, true); return; }
                    using (fs)
                    {
                        long size = fs.Length, start = 0, end = size - 1;
                        bool partial = false;
                        var m = range == null ? null : RangeRx.Match(range);
                        if (m != null && m.Success)
                        {
                            partial = true;
                            if (m.Groups[1].Value != "") start = long.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
                            else if (m.Groups[2].Value != "") start = Math.Max(0, size - long.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture));   // suffix range
                            if (m.Groups[1].Value != "" && m.Groups[2].Value != "") end = Math.Min(end, long.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture));
                            if (start >= size) { await Reply(net, "416 Range Not Satisfiable", 0, $"Content-Range: bytes */{size}\r\n", close); if (close) return; continue; }
                        }
                        long len = end - start + 1;
                        await Reply(net, partial ? "206 Partial Content" : "200 OK", len, partial ? $"Content-Range: bytes {start}-{end}/{size}\r\n" : null, close);
                        if (method == "HEAD") { if (close) return; continue; }
                        fs.Position = start;
                        while (len > 0)
                        {
                            int n = await fs.ReadAsync(buf.AsMemory(0, (int)Math.Min(buf.Length, len)));
                            if (n <= 0) return;   // file got shorter: the length sent is wrong now, end the connection
                            await net.WriteAsync(buf.AsMemory(0, n));
                            len -= n;
                        }
                    }
                    if (close) return;
                }
            }
            catch (IOException) { }            // FFmpeg closed the connection (seek, stop)
            catch (ObjectDisposedException) { }
            catch (Exception ex) { Log.Info("FileServer: " + ex.Message); }
        }
    }

    /// <summary>
    /// Response head. It says whether the connection stays open: some FFmpeg builds send "Connection: close" and still
    /// reuse the connection for the next request unless the response says it closes.
    /// </summary>
    static Task Reply(NetworkStream net, string status, long length, string extra, bool close)
    {
        string h = $"HTTP/1.1 {status}\r\nAccept-Ranges: bytes\r\nContent-Type: application/octet-stream\r\nContent-Length: {length}\r\n" +
            $"Connection: {(close ? "close" : "keep-alive")}\r\n{extra}\r\n";
        var b = Encoding.ASCII.GetBytes(h);
        return net.WriteAsync(b, 0, b.Length);
    }

    /// <summary>Buffered headers, retaining any pipelined request bytes for the next keep-alive request.</summary>
    sealed class HeaderReader
    {
        readonly NetworkStream _net;
        readonly byte[] _buffer = new byte[16384];
        int _start, _end;

        public HeaderReader(NetworkStream net) { _net = net; }

        public async Task<string> Read()
        {
            int scan = _start;
            while (true)
            {
                for (; scan + 3 < _end; scan++)
                    if (_buffer[scan] == '\r' && _buffer[scan + 1] == '\n' && _buffer[scan + 2] == '\r' && _buffer[scan + 3] == '\n')
                    {
                        string head = Encoding.Latin1.GetString(_buffer, _start, scan - _start);
                        _start = scan + 4;
                        return head;
                    }
                if (_start > 0)
                {
                    Buffer.BlockCopy(_buffer, _start, _buffer, 0, _end - _start);
                    _end -= _start;
                    scan -= _start;
                    _start = 0;
                }
                if (_end == _buffer.Length) return null; // preserve the 16 KiB per-header limit
                int n = await _net.ReadAsync(_buffer.AsMemory(_end));
                if (n <= 0) return null;
                _end += n;
            }
        }
    }
}
