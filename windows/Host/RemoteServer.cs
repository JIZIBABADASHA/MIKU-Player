using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

namespace Miku.Host;

/// <summary>
/// Small LAN web server for the phone remote: serves wwwroot/remote, the library / artwork, a JSON RPC endpoint
/// and a Server-Sent-Events stream with MIKU's state. Devices must pair once with a 4-digit code shown on the PC.
/// Plain TcpListener (no HttpListener) so it needs neither admin rights nor a URL reservation.
/// </summary>
public sealed class RemoteServer : IDisposable
{
    public sealed class Device
    {
        public string Token { get; set; }
        public string Name { get; set; }
        public DateTime Created { get; set; }
        public DateTime LastSeen { get; set; }
        public string LastIp { get; set; }
    }

    public sealed class Store { public List<Device> Devices { get; set; } = new(); }

    sealed class Request
    {
        public string Method, Path, Query;
        public NameValueCollection QueryArgs;
        public Dictionary<string, string> Headers = new(StringComparer.OrdinalIgnoreCase);
        public byte[] Body = Array.Empty<byte>();
        public string Ip;
        public string Header(string n) => Headers.TryGetValue(n, out var v) ? v : null;
    }

    sealed class SseClient
    {
        public readonly Channel<string> Queue = Channel.CreateBounded<string>(new BoundedChannelOptions(64) { FullMode = BoundedChannelFullMode.DropOldest });
    }

    static readonly string StorePath = Path.Combine(AppPaths.Root, "remote.json");

    readonly Func<string, JsonElement, Task<object>> _rpc;
    readonly Func<string, NameValueCollection, Task<(byte[] data, string type, string cache)>> _media;
    readonly Action<string, string> _pairRequested;
    readonly Action<string> _paired;
    readonly string _root;
    readonly object _lock = new();
    readonly Store _store;
    readonly List<SseClient> _clients = new();
    TcpListener _listener;
    CancellationTokenSource _cts;

    string _code; DateTime _codeUntil; int _codeFails; DateTime _lastCodeRequest;

    public int Port { get; private set; }
    public bool Running => _listener != null;
    public string LastError { get; private set; }
    public bool HasClients { get { lock (_clients) return _clients.Count > 0; } }
    public string PendingCode { get { lock (_lock) return _code != null && DateTime.UtcNow < _codeUntil ? _code : null; } }

    public RemoteServer(Func<string, JsonElement, Task<object>> rpc,
        Func<string, NameValueCollection, Task<(byte[], string, string)>> media,
        Action<string, string> pairRequested, Action<string> paired)
    {
        _rpc = rpc; _media = media; _pairRequested = pairRequested; _paired = paired;
        _root = Path.Combine(AppPaths.AppDir, "wwwroot", "remote");
        _store = Json.Load<Store>(StorePath);
    }

    // ───────────────────────────── lifecycle ─────────────────────────────

    public void Start(int port)
    {
        Stop();
        Port = port;
        try
        {
            var l = new TcpListener(IPAddress.Any, port);
            l.Start();
            _listener = l;
            _cts = new CancellationTokenSource();
            LastError = null;
            _ = AcceptLoop(l, _cts.Token);
            Log.Info($"Remote server listening on port {port}: {string.Join(", ", Urls())}");
        }
        catch (Exception ex)
        {
            _listener = null;
            LastError = ex is SocketException se && se.SocketErrorCode == SocketError.AddressAlreadyInUse
                ? $"連接埠 {port} 已被其他程式使用，請換一個連接埠。" : ex.Message;
            Log.Error("Remote server start", ex);
        }
    }

    public void Stop()
    {
        try { _cts?.Cancel(); } catch { }
        try { _listener?.Stop(); } catch { }
        _listener = null;
        lock (_clients) { foreach (var c in _clients) c.Queue.Writer.TryComplete(); _clients.Clear(); }
    }

    public void Dispose() => Stop();

    /// <summary>http://192.168.x.x:port addresses of this PC on the local networks.</summary>
    public List<string> Urls()
    {
        var list = new List<(string ip, bool gw)>();
        try
        {
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up) continue;
                if (ni.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel) continue;
                var props = ni.GetIPProperties();
                bool gw = props.GatewayAddresses.Any(g => g.Address.AddressFamily == AddressFamily.InterNetwork && !g.Address.Equals(IPAddress.Any));
                foreach (var ua in props.UnicastAddresses)
                {
                    if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                    string ip = ua.Address.ToString();
                    if (ip.StartsWith("169.254.")) continue;
                    list.Add((ip, gw));
                }
            }
        }
        catch (Exception ex) { Log.Error("Remote urls", ex); }
        return list.OrderByDescending(x => x.gw).Select(x => $"http://{x.ip}:{Port}").Distinct().ToList();
    }

    public List<object> DeviceList()
    {
        lock (_lock)
            return _store.Devices.OrderByDescending(d => d.LastSeen)
                .Select(d => (object)new { id = Miku.Text.Hash(d.Token), d.Name, d.Created, d.LastSeen, d.LastIp }).ToList();
    }

    public void Revoke(string id)
    {
        lock (_lock)
        {
            _store.Devices.RemoveAll(d => Miku.Text.Hash(d.Token) == id);
            SaveStore();
        }
    }

    void SaveStore()
    {
        try { Json.SaveAtomic(StorePath, _store); } catch (Exception ex) { Log.Error("Remote store", ex); }
    }

    // ───────────────────────────── events ─────────────────────────────

    /// <summary>Pushes an already serialised {ev, d} message to every connected phone.</summary>
    public void Broadcast(string json)
    {
        string frame = "data: " + json + "\n\n";
        lock (_clients) foreach (var c in _clients) c.Queue.Writer.TryWrite(frame);
    }

    // ───────────────────────────── http ─────────────────────────────

    async Task AcceptLoop(TcpListener l, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TcpClient c;
            try { c = await l.AcceptTcpClientAsync(ct); }
            catch { break; }
            _ = Task.Run(() => Serve(c, ct));
        }
    }

    async Task Serve(TcpClient client, CancellationToken ct)
    {
        using (client)
        {
            client.NoDelay = true;
            string ip = (client.Client.RemoteEndPoint as IPEndPoint)?.Address.ToString() ?? "?";
            var stream = client.GetStream();
            var buf = new ReadBuffer(stream);
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    idle.CancelAfter(TimeSpan.FromSeconds(60));
                    var req = await buf.ReadRequest(idle.Token);
                    if (req == null) return;
                    req.Ip = ip;
                    bool keep = !string.Equals(req.Header("Connection"), "close", StringComparison.OrdinalIgnoreCase);
                    if (req.Path == "/api/events")
                    {
                        if (!Authorized(req)) { await Send(stream, req, 401, "application/json", Utf8("{\"e\":\"unpaired\"}"), keep: false); return; }
                        await RunEvents(stream, ct);
                        return;
                    }
                    await Handle(stream, req, keep);
                    if (!keep) return;
                }
            }
            catch (OperationCanceledException) { }
            catch (IOException) { }
            catch (SocketException) { }
            catch (Exception ex) { Log.Error("Remote request", ex); }
        }
    }

    async Task Handle(NetworkStream s, Request req, bool keep)
    {
        string p = req.Path;
        if (req.Method == "OPTIONS") { await Send(s, req, 204, "text/plain", Array.Empty<byte>(), keep); return; }

        if (p == "/api/ping")
        {
            await SendJson(s, req, 200, new { app = "MIKU", paired = Authorized(req) }, keep);
            return;
        }
        if (p == "/api/pair/request" && req.Method == "POST")
        {
            string name = ReadName(req);
            string code;
            lock (_lock)
            {
                if ((DateTime.UtcNow - _lastCodeRequest).TotalSeconds < 2 && _code != null) code = _code;
                else
                {
                    if (_code == null || DateTime.UtcNow >= _codeUntil) { _code = RandomNumberGenerator.GetInt32(0, 10000).ToString("0000"); _codeFails = 0; }
                    _codeUntil = DateTime.UtcNow.AddMinutes(3);
                    code = _code;
                }
                _lastCodeRequest = DateTime.UtcNow;
            }
            _pairRequested?.Invoke(name, code);
            await SendJson(s, req, 200, new { ok = true }, keep);
            return;
        }
        if (p == "/api/pair/confirm" && req.Method == "POST")
        {
            string code = null, name = ReadName(req);
            try { using var d = JsonDocument.Parse(req.Body); if (d.RootElement.TryGetProperty("code", out var c)) code = c.GetString()?.Trim(); } catch { }
            Device dev = null;
            lock (_lock)
            {
                if (_code != null && DateTime.UtcNow < _codeUntil && code != null
                    && CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(code.PadRight(4)), Encoding.ASCII.GetBytes(_code)))
                {
                    dev = new Device { Token = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant(), Name = name, Created = DateTime.Now, LastSeen = DateTime.Now, LastIp = req.Ip };
                    _store.Devices.Add(dev);
                    SaveStore();
                    _code = null;
                }
                else if (_code != null && ++_codeFails >= 5) _code = null; // too many wrong guesses: a new code is needed
            }
            if (dev == null) { await SendJson(s, req, 403, new { e = "配對碼錯誤或已過期，請重新取得配對碼。" }, keep); return; }
            _paired?.Invoke(name);
            await SendJson(s, req, 200, new { token = dev.Token }, keep,
                $"Set-Cookie: miku_token={dev.Token}; Path=/; Max-Age=315360000; SameSite=Strict; HttpOnly\r\n");
            return;
        }

        if (p.StartsWith("/api/") || p.StartsWith("/media/"))
        {
            if (!Authorized(req)) { await SendJson(s, req, 401, new { e = "unpaired" }, keep); return; }
            if (p == "/api/rpc" && req.Method == "POST")
            {
                object result = null; string error = null;
                try
                {
                    using var doc = JsonDocument.Parse(req.Body);
                    var root = doc.RootElement;
                    string m = root.GetProperty("m").GetString();
                    JsonElement a = root.TryGetProperty("a", out var av) ? av.Clone() : default;
                    result = await _rpc(m, a);
                }
                catch (Exception ex) { error = ex.Message; }
                await SendJson(s, req, 200, new { r = result, e = error }, keep);
                return;
            }
            if (p.StartsWith("/media/"))
            {
                (byte[] data, string type, string cache) r = default;
                try { r = await _media(p[6..], req.QueryArgs); } catch (Exception ex) { Log.Error("Remote media " + p, ex); }
                if (r.data == null) await Send(s, req, 404, "text/plain", Utf8("not found"), keep, "Cache-Control: no-store\r\n");
                else await Send(s, req, 200, r.type, r.data, keep, $"Cache-Control: private, {r.cache}\r\n");
                return;
            }
            await SendJson(s, req, 404, new { e = "not found" }, keep);
            return;
        }

        await ServeStatic(s, req, keep);
    }

    async Task ServeStatic(NetworkStream s, Request req, bool keep)
    {
        string rel = Uri.UnescapeDataString(req.Path).TrimStart('/');
        if (rel == "") rel = "index.html";
        string file;
        if (rel == "icon.png") file = Path.Combine(AppPaths.AppDir, "wwwroot", "icon.png");
        else file = Path.GetFullPath(Path.Combine(_root, rel.Replace('/', Path.DirectorySeparatorChar)));
        if (!file.StartsWith(Path.GetFullPath(_root), StringComparison.OrdinalIgnoreCase) && rel != "icon.png") { await Send(s, req, 403, "text/plain", Utf8("forbidden"), keep); return; }
        if (!File.Exists(file)) { await Send(s, req, 404, "text/plain", Utf8("not found"), keep); return; }
        string type = Path.GetExtension(file).ToLowerInvariant() switch
        {
            ".html" => "text/html; charset=utf-8",
            ".js" => "text/javascript; charset=utf-8",
            ".css" => "text/css; charset=utf-8",
            ".json" or ".webmanifest" => "application/manifest+json; charset=utf-8",
            ".png" => "image/png",
            ".svg" => "image/svg+xml",
            _ => "application/octet-stream",
        };
        await Send(s, req, 200, type, await File.ReadAllBytesAsync(file), keep, "Cache-Control: no-cache\r\n");
    }

    async Task RunEvents(NetworkStream s, CancellationToken ct)
    {
        var client = new SseClient();
        lock (_clients) _clients.Add(client);
        try
        {
            await s.WriteAsync(Utf8("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-store\r\nConnection: keep-alive\r\nX-Accel-Buffering: no\r\n\r\nretry: 1500\n\n"), ct);
            await s.FlushAsync(ct);
            var reader = client.Queue.Reader;
            while (!ct.IsCancellationRequested)
            {
                using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct);
                wait.CancelAfter(15000);
                string frame;
                try { frame = await reader.ReadAsync(wait.Token); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested) { frame = ": ping\n\n"; } // keep-alive
                catch (ChannelClosedException) { return; }
                await s.WriteAsync(Utf8(frame), ct);
                await s.FlushAsync(ct);
            }
        }
        finally { lock (_clients) _clients.Remove(client); }
    }

    bool Authorized(Request req)
    {
        string token = req.Header("X-Miku-Token");
        if (string.IsNullOrEmpty(token))
        {
            string cookie = req.Header("Cookie");
            if (cookie != null)
                foreach (var part in cookie.Split(';'))
                {
                    var kv = part.Trim();
                    if (kv.StartsWith("miku_token=")) { token = kv[11..]; break; }
                }
        }
        if (string.IsNullOrEmpty(token)) token = req.QueryArgs?["t"];
        if (string.IsNullOrEmpty(token)) return false;
        lock (_lock)
        {
            var d = _store.Devices.FirstOrDefault(x => x.Token == token);
            if (d == null) return false;
            if ((DateTime.Now - d.LastSeen).TotalMinutes > 10 || d.LastIp != req.Ip) { d.LastSeen = DateTime.Now; d.LastIp = req.Ip; SaveStore(); }
            return true;
        }
    }

    static string ReadName(Request req)
    {
        try
        {
            using var d = JsonDocument.Parse(req.Body);
            if (d.RootElement.TryGetProperty("name", out var n))
            {
                string s = n.GetString()?.Trim();
                if (!string.IsNullOrEmpty(s)) return s.Length > 40 ? s[..40] : s;
            }
        }
        catch { }
        return "手機";
    }

    static byte[] Utf8(string s) => Encoding.UTF8.GetBytes(s);

    static Task SendJson(NetworkStream s, Request req, int status, object value, bool keep, string extra = null)
        => Send(s, req, status, "application/json; charset=utf-8", JsonSerializer.SerializeToUtf8Bytes(value, Json.Options), keep, (extra ?? "") + "Cache-Control: no-store\r\n");

    static async Task Send(NetworkStream s, Request req, int status, string type, byte[] body, bool keep, string extra = null)
    {
        bool gzip = body.Length > 1024 && (type.StartsWith("text/") || type.Contains("json") || type.Contains("javascript"))
                    && (req.Header("Accept-Encoding") ?? "").Contains("gzip");
        if (gzip)
        {
            using var ms = new MemoryStream();
            using (var gz = new GZipStream(ms, CompressionLevel.Fastest, true)) gz.Write(body);
            body = ms.ToArray();
        }
        string reason = status switch { 200 => "OK", 204 => "No Content", 401 => "Unauthorized", 403 => "Forbidden", 404 => "Not Found", _ => "Error" };
        var head = new StringBuilder();
        head.Append($"HTTP/1.1 {status} {reason}\r\n");
        head.Append($"Content-Type: {type}\r\n");
        head.Append($"Content-Length: {body.Length}\r\n");
        if (gzip) head.Append("Content-Encoding: gzip\r\nVary: Accept-Encoding\r\n");
        head.Append(keep ? "Connection: keep-alive\r\n" : "Connection: close\r\n");
        if (extra != null) head.Append(extra);
        head.Append("\r\n");
        await s.WriteAsync(Utf8(head.ToString()));
        if (req.Method != "HEAD" && body.Length > 0) await s.WriteAsync(body);
        await s.FlushAsync();
    }

    /// <summary>Minimal HTTP/1.1 request reader (keep-alive aware).</summary>
    sealed class ReadBuffer
    {
        readonly NetworkStream _s;
        byte[] _buf = new byte[16384];
        int _start, _end;
        public ReadBuffer(NetworkStream s) { _s = s; }

        async Task<bool> Fill(CancellationToken ct)
        {
            if (_start > 0) { Buffer.BlockCopy(_buf, _start, _buf, 0, _end - _start); _end -= _start; _start = 0; }
            if (_end == _buf.Length) { if (_buf.Length >= 2 << 20) throw new IOException("request too large"); Array.Resize(ref _buf, _buf.Length * 2); }
            int n = await _s.ReadAsync(_buf.AsMemory(_end), ct);
            if (n <= 0) return false;
            _end += n;
            return true;
        }

        int FindHeaderEnd()
        {
            for (int i = _start; i + 3 < _end; i++)
                if (_buf[i] == '\r' && _buf[i + 1] == '\n' && _buf[i + 2] == '\r' && _buf[i + 3] == '\n') return i;
            return -1;
        }

        public async Task<Request> ReadRequest(CancellationToken ct)
        {
            int end;
            while ((end = FindHeaderEnd()) < 0)
            {
                if (_end - _start > 32768) throw new IOException("headers too large");
                if (!await Fill(ct)) return null;
            }
            string head = Encoding.UTF8.GetString(_buf, _start, end - _start);
            _start = end + 4;
            var lines = head.Split("\r\n");
            var first = lines[0].Split(' ');
            if (first.Length < 2) throw new IOException("bad request line");
            var req = new Request { Method = first[0].ToUpperInvariant() };
            string target = first[1];
            int q = target.IndexOf('?');
            req.Path = q >= 0 ? target[..q] : target;
            req.Query = q >= 0 ? target[(q + 1)..] : "";
            req.QueryArgs = System.Web.HttpUtility.ParseQueryString(req.Query);
            for (int i = 1; i < lines.Length; i++)
            {
                int c = lines[i].IndexOf(':');
                if (c > 0) req.Headers[lines[i][..c].Trim()] = lines[i][(c + 1)..].Trim();
            }
            if (int.TryParse(req.Header("Content-Length"), out int len) && len > 0)
            {
                if (len > 1 << 20) throw new IOException("body too large");
                while (_end - _start < len) if (!await Fill(ct)) return null;
                req.Body = _buf.AsSpan(_start, len).ToArray();
                _start += len;
            }
            return req;
        }
    }
}
