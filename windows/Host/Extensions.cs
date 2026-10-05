using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using System.Threading.Tasks;
using Miku.Extensibility;

namespace Miku.Host;

/// <summary>
/// Optional extension modules (../MIKU.Extensibility/README.md): each is deployed to ext\&lt;id&gt;\ next to MIKU,
/// loaded in its own AssemblyLoadContext, and reached from the page through ext.&lt;id&gt;.* calls and events.
/// A module that fails to load, start or answer is logged and left out; MIKU itself carries on.
/// </summary>
sealed class ExtensionManager
{
    public static readonly string Root = Path.Combine(AppPaths.AppDir, "ext");
    public const string WebHost = "ext.miku";

    sealed class Loaded
    {
        public IMikuExtension Ext;
        public string Dir;
        public string[] Scripts = Array.Empty<string>();
        public string[] Styles = Array.Empty<string>();
    }

    readonly List<Loaded> _loaded = new();

    public bool Any => _loaded.Count > 0;

    /// <summary>The playback cores the modules provide (Audio/AudioCores.cs).</summary>
    public IEnumerable<Miku.Audio.IAudioCoreProvider> Cores => _loaded.Select(l => l.Ext).OfType<Miku.Audio.IAudioCoreProvider>();

    /// <summary>Loads and starts every module found; <paramref name="hostFor"/> builds the host object for one.</summary>
    public void LoadAll(Func<string, string, IExtensionHost> hostFor)
    {
        if (!Directory.Exists(Root)) return;
        foreach (var dir in Directory.EnumerateDirectories(Root).OrderBy(d => d, StringComparer.OrdinalIgnoreCase))
        {
            foreach (var dll in Directory.EnumerateFiles(dir, "*.Extension.dll"))
            {
                try
                {
                    var asm = new ExtLoadContext(dll).LoadFromAssemblyPath(dll);
                    foreach (var type in asm.GetTypes().Where(t => typeof(IMikuExtension).IsAssignableFrom(t) && !t.IsAbstract && t.GetConstructor(Type.EmptyTypes) != null))
                    {
                        var ext = (IMikuExtension)Activator.CreateInstance(type);
                        if (string.IsNullOrWhiteSpace(ext.Id) || _loaded.Any(l => l.Ext.Id == ext.Id))
                        {
                            Log.Info($"[ext] skipped {type.FullName}: missing or duplicate id \"{ext.Id}\"");
                            continue;
                        }
                        var l = new Loaded { Ext = ext, Dir = dir };
                        ReadManifest(l);
                        ext.Start(hostFor(ext.Id, dir));
                        _loaded.Add(l);
                        Log.Info($"[ext] started {ext.Id} ({type.FullName}, {Path.GetFileName(dll)})");
                    }
                }
                catch (Exception ex) { Log.Error("[ext] " + Path.GetFileName(dll), ex); }
            }
        }
    }

    /// <summary>web\manifest.json: { "scripts": [...], "styles": [...] }, paths relative to web\.</summary>
    static void ReadManifest(Loaded l)
    {
        string web = Path.Combine(l.Dir, "web"), file = Path.Combine(web, "manifest.json");
        if (!File.Exists(file)) return;
        using var doc = JsonDocument.Parse(File.ReadAllText(file));
        string[] Urls(string key) => doc.RootElement.TryGetProperty(key, out var arr) && arr.ValueKind == JsonValueKind.Array
            ? arr.EnumerateArray().Select(x => x.GetString()).Where(x => !string.IsNullOrEmpty(x)).Select(x => Url(l, web, x)).ToArray()
            : Array.Empty<string>();
        l.Scripts = Urls("scripts");
        l.Styles = Urls("styles");
    }

    // a version stamp keeps WebView2 from serving an old copy after the module is updated
    static string Url(Loaded l, string web, string rel)
    {
        string full = Path.Combine(web, rel);
        long stamp = File.Exists(full) ? File.GetLastWriteTimeUtc(full).Ticks : 0;
        return $"https://{WebHost}/{Path.GetFileName(l.Dir)}/web/{rel.Replace('\\', '/')}?v={stamp:x}";
    }

    /// <summary>For the page: which modules are there and what it should load for them.</summary>
    public object List() => _loaded.Select(l => new { id = l.Ext.Id, scripts = l.Scripts, styles = l.Styles }).ToList();

    /// <summary>ext.&lt;id&gt;.&lt;method&gt; from the page.</summary>
    public async Task<object> Rpc(string m, JsonElement a)
    {
        string rest = m.Substring(4);
        int dot = rest.IndexOf('.');
        string id = dot < 0 ? rest : rest.Substring(0, dot), method = dot < 0 ? "" : rest.Substring(dot + 1);
        var l = _loaded.FirstOrDefault(x => x.Ext.Id == id) ?? throw new InvalidOperationException($"no extension \"{id}\"");
        return await l.Ext.HandleRpc(method, a);
    }

    public void StopAll()
    {
        foreach (var l in _loaded)
        {
            try { l.Ext.Stop(); }
            catch (Exception ex) { Log.Error("[ext] stop " + l.Ext.Id, ex); }
        }
    }

    /// <summary>
    /// A module's own dependencies come from its folder. What MIKU has itself (MIKU.Extensibility, MIKU, NAudio … any
    /// assembly next to MIKU) is MIKU's copy, so a module that works with MIKU's types (a playback core) shares them.
    /// </summary>
    sealed class ExtLoadContext : AssemblyLoadContext
    {
        readonly AssemblyDependencyResolver _resolver;

        public ExtLoadContext(string mainDll) : base(Path.GetFileNameWithoutExtension(mainDll)) => _resolver = new AssemblyDependencyResolver(mainDll);

        protected override Assembly Load(AssemblyName name)
        {
            if (name.Name == typeof(IMikuExtension).Assembly.GetName().Name) return null;
            if (File.Exists(Path.Combine(AppPaths.AppDir, name.Name + ".dll"))) return null;
            string path = _resolver.ResolveAssemblyToPath(name);
            return path != null ? LoadFromAssemblyPath(path) : null;
        }

        protected override IntPtr LoadUnmanagedDll(string name)
        {
            string path = _resolver.ResolveUnmanagedDllToPath(name);
            return path != null ? LoadUnmanagedDllFromPath(path) : IntPtr.Zero;
        }
    }
}

/// <summary>What one module gets from MIKU; the pieces it needs from MainForm come in as delegates.</summary>
sealed class ExtensionHost : IExtensionHost
{
    readonly string _id;
    readonly Func<IReadOnlyList<ExtTrack>> _tracks;
    readonly Func<bool> _playing;
    readonly Func<IReadOnlyList<string>, bool, int, Task> _play;
    readonly Action<string, object> _post;
    readonly Func<string, JsonElement?> _get;
    readonly Action<string, object> _set;

    public ExtensionHost(string id, string dir, Func<IReadOnlyList<ExtTrack>> tracks, Func<bool> playing,
        Func<IReadOnlyList<string>, bool, int, Task> play, Action<string, object> post,
        Func<string, JsonElement?> get, Action<string, object> set)
    {
        _id = id;
        ExtensionDir = dir;
        DataDir = Path.Combine(AppPaths.Root, "ext", id);
        Directory.CreateDirectory(DataDir);
        (_tracks, _playing, _play, _post, _get, _set) = (tracks, playing, play, post, get, set);
    }

    public string DataDir { get; }
    public string ExtensionDir { get; }
    public string FfmpegPath => Audio.Ffmpeg.Available ? Audio.Ffmpeg.Path : null;
    public IReadOnlyList<ExtTrack> Tracks => _tracks();
    public event Action LibraryChanged;
    public bool IsPlaying => _playing();
    public event Action PlaybackChanged;
    public Task Play(IReadOnlyList<string> trackIds, bool shuffle, int start = -1) => _play(trackIds, shuffle, start);
    public void Post(string ev, object data) => _post($"ext.{_id}.{ev}", data);
    public JsonElement? GetSetting(string key) => _get(key);
    public void SetSetting(string key, object value) => _set(key, value);
    public void Log(string message) => Miku.Log.Info($"[{_id}] {message}");

    // raised by MainForm; a module's handler that throws must not break MIKU's own event
    public void RaiseLibraryChanged() => Raise(LibraryChanged, "LibraryChanged");
    public void RaisePlaybackChanged() => Raise(PlaybackChanged, "PlaybackChanged");

    void Raise(Action ev, string name)
    {
        if (ev == null) return;
        foreach (Action h in ev.GetInvocationList())
        {
            try { h(); }
            catch (Exception ex) { Miku.Log.Error($"[ext] {_id} {name}", ex); }
        }
    }
}
