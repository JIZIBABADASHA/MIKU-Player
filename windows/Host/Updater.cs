using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Miku.Host;

/// <summary>
/// 設定 → 其他 → 更新與擴充套件: MIKU's own updates and its extension modules, from the GitHub Releases. A Release
/// holds MIKU-Setup-&lt;tag&gt;.exe and, added by .github/workflows/extensions.yml, one zip per module built against it:
/// MIKU-ext-&lt;id&gt;-&lt;version&gt;-win-x64.zip with &lt;id&gt;\ inside. Every download is checked against the SHA-256 GitHub keeps.
///
/// A module is never changed while MIKU runs (its DLL is loaded): an install or removal is staged in ext\.pending\ and
/// <see cref="ApplyPending"/> carries it out at the next start, before the modules load. A staged module carries the
/// MIKU version it was built for (.miku-build) and waits for that version, so the modules of an update that is
/// installed with it go in only once MIKU is that version.
/// </summary>
sealed class Updater
{
    const string Repo = "JIZIBABADASHA/MIKU-Player";
    const string Platform = "win-x64";
    const string BuildFile = ".miku-build";
    static readonly TimeSpan Every = TimeSpan.FromHours(6);
    static readonly string Cache = Path.Combine(AppPaths.Root, "Updates");
    static string Pending => Path.Combine(ExtensionManager.Root, ".pending");
    static readonly HttpClient Http = CreateHttp();

    sealed record Asset(string Name, string Url, string Sha256, long Size);
    sealed record Release(string Tag, string Version, Dictionary<string, Asset> Assets)
    {
        public Asset Installer => Assets.GetValueOrDefault($"MIKU-Setup-{Tag}.exe");
        public Asset Module(string id) => Assets.GetValueOrDefault($"MIKU-ext-{id}-{Version}-{Platform}.zip");
        public IEnumerable<string> ModuleIds => Assets.Keys
            .Where(n => n.StartsWith("MIKU-ext-") && n.EndsWith($"-{Version}-{Platform}.zip"))
            .Select(n => n.Substring(9, n.Length - 9 - $"-{Version}-{Platform}.zip".Length))
            .Where(ValidId);
    }

    readonly string _version;
    readonly Func<bool> _auto;
    readonly Action _changed;
    readonly object _gate = new();
    readonly SemaphoreSlim _work = new(1, 1);
    Release _latest, _own;        // the newest Release, and the one for this MIKU (its modules)
    string _installer;            // the newest Release's installer, downloaded and checked
    string _busy, _error;
    double? _progress;
    DateTime? _checkedAt;
    System.Threading.Timer _timer;

    public Updater(string version, Func<bool> auto, Action changed)
    {
        _version = version.Split('+')[0];
        _auto = auto;
        _changed = changed;
    }

    /// <summary>Checks 30 seconds after the start and then every 6 hours while automatic updates are on.</summary>
    public void Start() => _timer = new System.Threading.Timer(_ => { if (_auto()) _ = Task.Run(() => Check(background: true)); }, null, TimeSpan.FromSeconds(30), Every);

    public void Stop() => _timer?.Dispose();

    /// <summary>What 設定 shows.</summary>
    public object Info()
    {
        lock (_gate)
        {
            bool newer = _latest != null && Compare(_latest.Version, _version) > 0;
            return new
            {
                version = _version,
                latest = _latest?.Version,
                newer,
                // the newest Release has no installer for Windows yet (still being uploaded, or Mac only)
                missing = newer && _latest.Installer == null,
                ready = newer && _installer != null,
                busy = _busy,
                progress = _progress,
                error = _error,
                checkedAt = _checkedAt,
                restart = PendingIds().Any(),
                extensions = Modules(),
            };
        }
    }

    object Modules()
    {
        var installed = InstalledIds().ToHashSet();
        var ids = new SortedSet<string>(installed);
        if (_own != null) ids.UnionWith(_own.ModuleIds);
        var pending = PendingIds().GroupBy(p => p.Id).ToDictionary(g => g.Key, g => g.Last().Op);
        ids.UnionWith(pending.Keys);
        return ids.Select(id => new
        {
            id,
            installed = installed.Contains(id),
            build = installed.Contains(id) ? ReadBuild(Path.Combine(ExtensionManager.Root, id)) : null,
            available = _own?.Module(id) != null,
            pending = pending.GetValueOrDefault(id),
        }).ToList();
    }

    // ───────────────────────────── checking and downloading ─────────────────────────────

    /// <summary>Asks GitHub for the newest Release and this version's; in the background also downloads a newer installer.</summary>
    public async Task<object> Check(bool background = false)
    {
        if (!await _work.WaitAsync(background ? 0 : Timeout.Infinite)) return Info();
        try
        {
            Set("checking");
            var latest = await GetRelease("latest");
            var own = latest.Version == _version ? latest : await FindOwn();
            lock (_gate) { _latest = latest; _own = own; _checkedAt = DateTime.UtcNow; _error = null; }
            if (background && Compare(latest.Version, _version) > 0 && latest.Installer != null) await DownloadInstaller(latest);
        }
        catch (Exception ex) { Log.Error("[update] check", ex); lock (_gate) _error = Message(ex); }
        finally { Set(null); _work.Release(); }
        return Info();
    }

    async Task<Release> FindOwn()
    {
        foreach (var tag in new[] { _version, "v" + _version })
        {
            try { return await GetRelease("tags/" + Uri.EscapeDataString(tag)); }
            catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound) { }
        }
        return null;   // a build of its own (no Release): no modules to offer
    }

    async Task<string> DownloadInstaller(Release r)
    {
        lock (_gate) if (_installer != null && File.Exists(_installer) && _latest == r) return _installer;
        Set("download");
        string file = await Fetch(r.Installer);
        // older installers in the cache are of no use any more
        foreach (var old in Directory.EnumerateFiles(Cache, "MIKU-Setup-*.exe").Where(f => !string.Equals(f, file, StringComparison.OrdinalIgnoreCase)))
            try { File.Delete(old); } catch { }
        lock (_gate) _installer = file;
        return file;
    }

    /// <summary>The newest Release's installer, then its modules for the ones installed; then the installer runs once MIKU has closed.</summary>
    public async Task<object> Install(string lang, Action quit)
    {
        await _work.WaitAsync();
        try
        {
            Release r;
            lock (_gate) r = _latest;
            if (r == null || Compare(r.Version, _version) <= 0) throw new InvalidOperationException("已經是最新版本");
            if (r.Installer == null) throw new InvalidOperationException("這個版本還沒有 Windows 安裝檔");
            string installer = await DownloadInstaller(r);
            // the modules in use, built for the new version, go in at its first start
            foreach (var id in InstalledIds().Where(id => r.Module(id) != null).ToList()) await Stage(r, id);
            Set("install");
            string args = $"/SILENT /SUPPRESSMSGBOXES /NORESTART /relaunch=1 /LANG={InstallerLang(lang)}";
            RunAfterExit($"Start-Process -FilePath '{installer.Replace("'", "''")}' -ArgumentList '{args}'");
            Log.Info($"[update] installing {r.Version} after this process ends");
            quit();
            return Info();
        }
        catch (Exception ex) { Log.Error("[update] install", ex); lock (_gate) _error = Message(ex); Set(null); throw new InvalidOperationException(Message(ex)); }
        finally { _work.Release(); }
    }

    /// <summary>Starts MIKU again once this process has ended (a second MIKU started now would only bring this one forward).</summary>
    public static void RelaunchAfterExit()
    {
        string exe = Environment.ProcessPath ?? Path.Combine(AppPaths.AppDir, "MIKU.exe");
        RunAfterExit($"Start-Process -FilePath '{exe.Replace("'", "''")}'");
    }

    static void RunAfterExit(string command) => Process.Start(new ProcessStartInfo("powershell.exe")
    {
        ArgumentList = { "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", $"Wait-Process -Id {Environment.ProcessId} -ErrorAction SilentlyContinue; {command}" },
        UseShellExecute = false,
        CreateNoWindow = true,
    });

    // the installer's language codes (installer.iss [Languages]) for the page's
    static string InstallerLang(string lang) => lang switch { "zh-Hans" => "zhs", "en" => "en", "ja" => "ja", _ => "zh" };

    // ───────────────────────────── extension modules ─────────────────────────────

    /// <summary>Downloads this version's module and stages it for the next start.</summary>
    public async Task<object> AddModule(string id)
    {
        if (!ValidId(id)) throw new InvalidOperationException("未知的擴充套件");
        await _work.WaitAsync();
        try
        {
            Release own;
            lock (_gate) own = _own;
            if (own == null) { own = await FindOwn(); lock (_gate) _own = own; }
            if (own?.Module(id) == null) throw new InvalidOperationException("這個版本沒有這個擴充套件的已編譯版本");
            await Stage(own, id);
            lock (_gate) _error = null;
        }
        catch (Exception ex) { Log.Error("[update] add " + id, ex); lock (_gate) _error = Message(ex); throw new InvalidOperationException(Message(ex)); }
        finally { Set(null); _work.Release(); }
        return Info();
    }

    /// <summary>Stages the removal of a module for the next start; one only staged is dropped at once.</summary>
    public object RemoveModule(string id)
    {
        if (!ValidId(id)) throw new InvalidOperationException("未知的擴充套件");
        string staged = Path.Combine(Pending, id);
        if (Directory.Exists(staged)) Directory.Delete(staged, true);
        if (Directory.Exists(Path.Combine(ExtensionManager.Root, id)))
        {
            Directory.CreateDirectory(Pending);
            File.WriteAllText(staged + ".remove", "");
        }
        _changed();
        return Info();
    }

    /// <summary>Takes back what is staged for a module (an install or a removal).</summary>
    public object Undo(string id)
    {
        if (!ValidId(id)) throw new InvalidOperationException("未知的擴充套件");
        string staged = Path.Combine(Pending, id);
        if (Directory.Exists(staged)) Directory.Delete(staged, true);
        File.Delete(staged + ".remove");
        _changed();
        return Info();
    }

    async Task Stage(Release r, string id)
    {
        Set("module");
        string zip = await Fetch(r.Module(id));
        Directory.CreateDirectory(Pending);
        string work = Path.Combine(Pending, ".unpack-" + Guid.NewGuid().ToString("N")[..8]);
        try
        {
            ZipFile.ExtractToDirectory(zip, work);
            var top = Directory.GetFileSystemEntries(work);
            string dir = Path.Combine(work, id);
            if (top.Length != 1 || !Directory.Exists(dir) || !Directory.EnumerateFiles(dir, "*.Extension.dll").Any())
                throw new InvalidOperationException($"{id} 的壓縮檔內容不正確");
            File.WriteAllText(Path.Combine(dir, BuildFile), r.Version);
            string staged = Path.Combine(Pending, id);
            if (Directory.Exists(staged)) Directory.Delete(staged, true);
            Directory.Move(dir, staged);
            File.Delete(staged + ".remove");
        }
        finally
        {
            try { Directory.Delete(work, true); } catch { }
            try { File.Delete(zip); } catch { }
        }
    }

    /// <summary>At the start, before the modules load: what was staged in ext\.pending\ for this version.</summary>
    public static void ApplyPending(string version)
    {
        version = version.Split('+')[0];
        if (!Directory.Exists(Pending)) return;
        foreach (var mark in Directory.EnumerateFiles(Pending, "*.remove").ToList())
        {
            string id = Path.GetFileNameWithoutExtension(mark), dir = Path.Combine(ExtensionManager.Root, id);
            try
            {
                if (ValidId(id) && Directory.Exists(dir)) Directory.Delete(dir, true);
                File.Delete(mark);
                Log.Info($"[ext] removed {id}");
            }
            catch (Exception ex) { Log.Error("[ext] remove " + id, ex); }
        }
        foreach (var staged in Directory.EnumerateDirectories(Pending).ToList())
        {
            string id = Path.GetFileName(staged), dir = Path.Combine(ExtensionManager.Root, id);
            try
            {
                if (!ValidId(id)) { Directory.Delete(staged, true); continue; }   // a leftover .unpack-…
                int cmp = Compare(ReadBuild(staged), version);
                if (cmp > 0) continue;                                             // waits for its MIKU update
                if (cmp == 0)
                {
                    if (Directory.Exists(dir)) Directory.Delete(dir, true);
                    Directory.Move(staged, dir);
                    Log.Info($"[ext] installed {id} {version}");
                }
                else Directory.Delete(staged, true);                               // built for an older MIKU
            }
            catch (Exception ex) { Log.Error("[ext] install " + id, ex); }
        }
        try { if (!Directory.EnumerateFileSystemEntries(Pending).Any()) Directory.Delete(Pending); } catch { }
    }

    static IEnumerable<string> InstalledIds() => Directory.Exists(ExtensionManager.Root)
        ? Directory.EnumerateDirectories(ExtensionManager.Root).Where(d => Directory.EnumerateFiles(d, "*.Extension.dll").Any())
            .Select(Path.GetFileName).Where(ValidId)
        : Enumerable.Empty<string>();

    IEnumerable<(string Id, string Op)> PendingIds()
    {
        if (!Directory.Exists(Pending)) yield break;
        foreach (var m in Directory.EnumerateFiles(Pending, "*.remove")) yield return (Path.GetFileNameWithoutExtension(m), "remove");
        foreach (var d in Directory.EnumerateDirectories(Pending))
        {
            string id = Path.GetFileName(d);
            // a module staged for an update waits for it: not this start's change
            if (ValidId(id) && Compare(ReadBuild(d), _version) == 0) yield return (id, "install");
        }
    }

    static string ReadBuild(string dir)
    {
        try { return File.ReadAllText(Path.Combine(dir, BuildFile)).Trim(); } catch { return null; }
    }

    static bool ValidId(string id) => !string.IsNullOrEmpty(id) && id.Length <= 64 && id.All(c => c is >= 'a' and <= 'z' or >= '0' and <= '9' or '-' or '_') && char.IsLetter(id[0]);

    // ───────────────────────────── GitHub ─────────────────────────────

    async Task<Release> GetRelease(string which)
    {
        using var res = await Http.GetAsync($"https://api.github.com/repos/{Repo}/releases/{which}");
        res.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        var root = doc.RootElement;
        string tag = root.GetProperty("tag_name").GetString();
        if (string.IsNullOrEmpty(tag) || root.GetProperty("draft").GetBoolean()) throw new InvalidOperationException("GitHub 的 Release 格式不正確");
        var assets = new Dictionary<string, Asset>();
        foreach (var a in root.GetProperty("assets").EnumerateArray())
        {
            string name = a.GetProperty("name").GetString(), url = a.GetProperty("browser_download_url").GetString();
            string digest = a.TryGetProperty("digest", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString() : null;
            // only files of this repository's Release, with the SHA-256 GitHub computed
            if (name == null || a.GetProperty("state").GetString() != "uploaded" || digest == null || !digest.StartsWith("sha256:") || digest.Length != 71 ||
                url != $"https://github.com/{Repo}/releases/download/{Uri.EscapeDataString(tag)}/{name}") continue;
            assets[name] = new Asset(name, url, digest.Substring(7).ToLowerInvariant(), a.GetProperty("size").GetInt64());
        }
        return new Release(tag, tag.TrimStart('v'), assets);
    }

    /// <summary>Downloads into the cache and checks its size and SHA-256; a file already there and correct is kept.</summary>
    async Task<string> Fetch(Asset a)
    {
        Directory.CreateDirectory(Cache);
        string file = Path.Combine(Cache, a.Name), part = file + ".partial";
        if (File.Exists(file) && new FileInfo(file).Length == a.Size && await Sha256(file) == a.Sha256) return file;
        using (var res = await Http.GetAsync(a.Url, HttpCompletionOption.ResponseHeadersRead))
        {
            res.EnsureSuccessStatusCode();
            await using var src = await res.Content.ReadAsStreamAsync();
            await using var dst = File.Create(part);
            var buf = new byte[1 << 16];
            long done = 0;
            int n, lastPct = -1;
            while ((n = await src.ReadAsync(buf)) > 0)
            {
                await dst.WriteAsync(buf.AsMemory(0, n));
                done += n;
                int pct = a.Size > 0 ? (int)(done * 100 / a.Size) : 0;
                if (pct != lastPct) { lastPct = pct; lock (_gate) _progress = pct / 100.0; _changed(); }
            }
        }
        if (new FileInfo(part).Length != a.Size || await Sha256(part) != a.Sha256)
        {
            File.Delete(part);
            throw new InvalidOperationException($"{a.Name} 的 SHA-256 驗證失敗");
        }
        File.Move(part, file, true);
        return file;
    }

    static async Task<string> Sha256(string file)
    {
        await using var s = File.OpenRead(file);
        return Convert.ToHexString(await SHA256.HashDataAsync(s)).ToLowerInvariant();
    }

    static HttpClient CreateHttp()
    {
        // no overall timeout: an installer is over 100 MB; a stalled connection still fails on its own
        var c = new HttpClient(new HttpClientHandler { AllowAutoRedirect = true }) { Timeout = TimeSpan.FromMinutes(30) };
        c.DefaultRequestHeaders.UserAgent.ParseAdd("MIKU-Updater");
        c.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return c;
    }

    // ───────────────────────────── helpers ─────────────────────────────

    void Set(string busy)
    {
        lock (_gate) { _busy = busy; if (busy != "download" && busy != "module") _progress = null; }
        _changed();
    }

    static string Message(Exception ex) => ex switch
    {
        HttpRequestException h when h.StatusCode == System.Net.HttpStatusCode.NotFound => "GitHub 上還沒有發布任何 Release",
        HttpRequestException h when h.StatusCode is System.Net.HttpStatusCode.Forbidden or System.Net.HttpStatusCode.TooManyRequests => "GitHub 暫時拒絕連線，請稍後再試",
        HttpRequestException or TaskCanceledException => "無法連線到 GitHub",
        IOException or UnauthorizedAccessException => "無法寫入 MIKU 的資料夾：" + ex.Message,
        _ => ex.Message,
    };

    /// <summary>Dotted versions compared number by number; null sorts first.</summary>
    public static int Compare(string a, string b)
    {
        if (a == null || b == null) return a == null ? (b == null ? 0 : -1) : 1;
        var x = a.TrimStart('v').Split('.', '-', '+');
        var y = b.TrimStart('v').Split('.', '-', '+');
        for (int i = 0; i < Math.Max(x.Length, y.Length); i++)
        {
            int p = i < x.Length && int.TryParse(x[i], out var u) ? u : 0, q = i < y.Length && int.TryParse(y[i], out var v) ? v : 0;
            if (p != q) return p.CompareTo(q);
        }
        return 0;
    }
}
