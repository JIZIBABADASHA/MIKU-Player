using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace Miku;

static class Program
{
    public const string AppName = "MIKU";

    [STAThread]
    static void Main(string[] args)
    {
        using var mutex = new Mutex(true, "MIKU.Player.SingleInstance", out bool created);
        if (!created)
        {
            IntPtr h = FindWindow(null, AppName);
            if (h != IntPtr.Zero) { ShowWindow(h, 9); SetForegroundWindow(h); }
            return;
        }
        AppPaths.Ensure();
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => Log.Error("UI", e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Error("Fatal", e.ExceptionObject as Exception);
        TaskSchedulerHook();
        Log.Info("Start " + Application.ProductVersion);
        Application.Run(new Host.MainForm());
    }

    static void TaskSchedulerHook()
    {
        System.Threading.Tasks.TaskScheduler.UnobservedTaskException += (_, e) => { Log.Error("Task", e.Exception); e.SetObserved(); };
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
}
