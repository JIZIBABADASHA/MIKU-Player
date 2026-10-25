using System;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Threading;

namespace Miku.Host;

// Keep update downloads out of the audio process. Builder compares the installed release,
// downloads the prebuilt installer for the selected modules, and asks the user to install it.
internal static class BuilderUpdater
{
    static Timer _timer;
    public static void Start() => _timer ??= new Timer(_ =>
    {
        try { Launch(true); }
        catch (Exception e) { Log.Error("Update check", e); }
    }, null, TimeSpan.FromSeconds(30), TimeSpan.FromHours(6));

    public static bool Launch(bool background = false)
    {
        var configPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "MIKU Builder", "updater.json");
        if (!File.Exists(configPath)) return false;
        using var doc = JsonDocument.Parse(File.ReadAllText(configPath));
        var config = doc.RootElement;
        if (background && (!config.TryGetProperty("enabled", out var enabled) || !enabled.GetBoolean())) return false;
        var exe = config.GetProperty("executable").GetString();
        if (!Path.IsPathFullyQualified(exe) || !File.Exists(exe)) return false;
        var info = new ProcessStartInfo(exe) { UseShellExecute = false, CreateNoWindow = true };
        if (config.TryGetProperty("args", out var args))
            foreach (var arg in args.EnumerateArray()) info.ArgumentList.Add(arg.GetString());
        if (background)
        {
            info.ArgumentList.Add("--background-update");
        }
        using var process = Process.Start(info);
        return process != null;
    }
}
