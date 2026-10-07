using System.Drawing;
using Miku.Host;

// dotnet run --project tests/window-placement/WindowsPlacement.Tests.csproj
int checks = 0;
void Equal<T>(T actual, T expected, string label)
{
    if (!Equals(actual, expected)) throw new Exception($"{label}: expected {expected}, got {actual}");
    checks++;
}

var fullHd = new Rectangle(0, 0, 1920, 1040);
var fourK = new Rectangle(0, 0, 3840, 2080);
var cases = new[] {
    (fullHd, 96, new Size(1480, 940)),
    (fullHd, 144, new Size(1800, 960)),
    (fourK, 192, new Size(2960, 1880)),
    (fourK, 240, new Size(3640, 1930)),
    (fourK, 288, new Size(3600, 1920)),
    (new Rectangle(0, 0, 1366, 728), 144, new Size(1366, 728)),
    (new Rectangle(0, 0, 800, 560), 96, new Size(800, 560)),
};
foreach (var (wa, dpi, expected) in cases)
{
    var r = WindowPlacement.Restore(wa, dpi, Rectangle.Empty, 0);
    Equal(r.Size, expected, $"first launch at {dpi} DPI on {wa.Size}");
    Equal(wa.Contains(r), true, "first launch fits work area");
    Equal(r.Location, new Point(wa.X + (wa.Width - r.Width) / 2, wa.Y + (wa.Height - r.Height) / 2), "centered");
}

Equal(WindowPlacement.Minimum(fourK, 192), new Size(1960, 1280), "minimum is scaled once");
Equal(WindowPlacement.Minimum(new Rectangle(0, 0, 800, 560), 192), new Size(800, 560), "minimum fits small work area");
Equal(WindowPlacement.Restore(fourK, 192, new Rectangle(100, 80, 1480, 940), 0).Size,
    new Size(2960, 1880), "repair old high-DPI startup size");
var saved = new Rectangle(60, 40, 1200, 800);
Equal(WindowPlacement.Restore(fullHd, 96, saved, 96), saved, "same-DPI restart preserves user bounds");
Equal(WindowPlacement.Restore(fourK, 192, saved, 96), new Rectangle(60, 40, 2400, 1600), "DPI change preserves logical size");
Equal(WindowPlacement.Restore(fullHd, 96, new Rectangle(60, 40, 2400, 1600), 192), saved, "DPI change back avoids cumulative scaling");
Equal(WindowPlacement.Restore(fourK, 192, new Rectangle(100, 100, 2200, 1400), 0),
    new Rectangle(100, 100, 2200, 1400), "usable legacy size is preserved");
Equal(WindowPlacement.Restore(fullHd, 96, new Rectangle(1800, 1000, 1480, 940), 96),
    new Rectangle(440, 100, 1480, 940), "partial overlap brings all bounds on screen");
Equal(WindowPlacement.Restore(fullHd, 96, new Rectangle(0, 0, 3500, 2000), 96), fullHd, "large saved bounds fit smaller display");
Equal(WindowPlacement.Restore(fullHd, 96, new Rectangle(5000, 100, 1480, 940), 96),
    new Rectangle(220, 50, 1480, 940), "removed monitor returns to primary");
Equal(WindowPlacement.Restore(fullHd, 96, new Rectangle(50, 40, 400, 250), 96).Size,
    new Size(980, 640), "tagged undersized bounds respect minimum");

var left = new Rectangle(-1920, 30, 1920, 1010);
var displays = new[] { fullHd, left };
Equal(WindowPlacement.DisplayIndex(new Rectangle(-1800, 50, 1480, 940), displays, 0), 1, "negative-coordinate monitor");
Equal(WindowPlacement.DisplayIndex(new Rectangle(-200, 50, 1480, 940), displays, 1), 0, "largest overlap wins");
Equal(WindowPlacement.DisplayIndex(new Rectangle(5000, 50, 1480, 940), displays, 1), 1, "removed monitor uses specified primary");
Equal(WindowPlacement.Restore(left, 96, new Rectangle(-1800, 50, 1480, 940), 96),
    new Rectangle(-1800, 50, 1480, 940), "negative position is preserved");
foreach (var bad in new[] { null, Array.Empty<int>(), new[] { 1, 2, 3 }, new[] { 0, 0, 1480, -1 }, new[] { int.MaxValue, 0, 1480, 940 } })
    Equal(WindowPlacement.ReadSaved(bad), Rectangle.Empty, "invalid settings fall back safely");
Console.WriteLine($"Windows window placement: {checks} checks passed.");
