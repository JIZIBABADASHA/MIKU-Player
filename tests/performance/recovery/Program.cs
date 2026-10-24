using System.Reflection;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Miku;
using Miku.Host;

internal static class RecoveryCheck
{
    [STAThread]
    static void Main(string[] args)
    {
        bool testDaphne = args.Contains("--daphne");
        // A separate profile and no extension directory: never operate on the user's player.
        var profile = Path.Combine(AppContext.BaseDirectory, "test-profile-" + Guid.NewGuid().ToString("N"));
        Environment.SetEnvironmentVariable("MIKU_DATA_DIR", profile);
        AppPaths.Ensure();
        Json.SaveAtomic(AppPaths.Settings, new Settings { RemoteEnabled = false, AudioCore = testDaphne ? "daphne" : "miku" });
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using var form = new MainForm { ShowInTaskbar = false, Opacity = 0 };
        var ready = typeof(MainForm).GetField("_ready", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var engine = typeof(MainForm).GetField("_engine", BindingFlags.Instance | BindingFlags.NonPublic)!;
        form.Shown += async (_, _) =>
        {
            try
            {
                await Until(() => (bool)ready.GetValue(form)!, "initial interface ready");
                var web = form.Controls.OfType<WebView2>().Single();
                if (testDaphne) await Until(() => engine.GetValue(form)?.GetType().Name == "DaphneEngine", "Daphne extension loaded");
                var originalEngine = engine.GetValue(form);
                int failures = 0;
                web.CoreWebView2.ProcessFailed += (_, e) =>
                {
                    if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited) failures++;
                };
                // Invalid messages must not escape the async-void bridge handler.
                await web.CoreWebView2.ExecuteScriptAsync("for (const s of ['null', '[]', '{}', '{\"m\":4}', '{\"m\":\"state\",\"id\":{}}']) chrome.webview.postMessage(s)");
                _ = CrashRenderer(web.CoreWebView2);
                await Until(() => failures == 1, "renderer failure observed");
                await Until(() => (bool)ready.GetValue(form)!, "interface ready after recovery");
                if (!ReferenceEquals(originalEngine, engine.GetValue(form))) throw new Exception("Recovery replaced the audio engine");
                if (await web.CoreWebView2.ExecuteScriptAsync("typeof App") != "\"object\"") throw new Exception("Frontend did not reload");
                Console.WriteLine($"PASS: actual WebView2 renderer crash recovered; {originalEngine.GetType().Name} retained; malformed bridge messages tolerated.");
            }
            catch (Exception ex) { Console.Error.WriteLine(ex); Environment.ExitCode = 1; }
            finally { form.Close(); }
        };
        Application.Run(form);
        var log = File.ReadAllText(AppPaths.LogFile);
        if (!log.Contains("WebView2 process failed:") || !log.Contains("Window closing:")) Environment.ExitCode = 1;
        File.AppendAllText(AppPaths.LogFile, new string('x', 2_000_001));
        Log.Info("rotation check");
        if (!File.ReadAllText(AppPaths.LogFile + ".previous").StartsWith(log) || !File.ReadAllText(AppPaths.LogFile).Contains("rotation check"))
            Environment.ExitCode = 1;
        else Console.WriteLine("PASS: log rotation retains the previous diagnostic log.");
        Console.WriteLine("Profile/log: " + profile);
    }

    static async Task CrashRenderer(CoreWebView2 core)
    {
        try { await core.CallDevToolsProtocolMethodAsync("Page.crash", "{}"); }
        catch { /* the target renderer is deliberately gone */ }
    }

    static async Task Until(Func<bool> check, string description)
    {
        var end = DateTime.UtcNow.AddSeconds(30);
        while (!check())
        {
            if (DateTime.UtcNow > end) throw new TimeoutException(description);
            await Task.Delay(100);
        }
    }
}
