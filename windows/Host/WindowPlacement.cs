using System;
using System.Collections.Generic;
using System.Drawing;

namespace Miku.Host;

/// <summary>Window sizes are specified at 96 DPI; WinForms bounds and work areas are physical pixels.</summary>
internal static class WindowPlacement
{
    public static Rectangle ReadSaved(int[] bounds)
    {
        if (bounds is not { Length: 4 } || bounds[2] <= 0 || bounds[3] <= 0
            || (long)bounds[0] + bounds[2] > int.MaxValue || (long)bounds[1] + bounds[3] > int.MaxValue)
            return Rectangle.Empty;
        return new Rectangle(bounds[0], bounds[1], bounds[2], bounds[3]);
    }

    // Prefer the monitor containing most of the saved window, including monitors at negative coordinates.
    public static int DisplayIndex(Rectangle saved, IReadOnlyList<Rectangle> workAreas, int primary)
    {
        int best = primary;
        long largest = 0;
        for (int i = 0; i < workAreas.Count; i++)
        {
            var overlap = Rectangle.Intersect(saved, workAreas[i]);
            long area = (long)Math.Max(0, overlap.Width) * Math.Max(0, overlap.Height);
            if (area > largest) { largest = area; best = i; }
        }
        return best;
    }

    static int Scale(int value, double factor) => (int)Math.Clamp(Math.Round(value * factor), 1, int.MaxValue);

    public static Size Minimum(Rectangle workArea, int dpi) => new(
        Math.Min(Scale(980, dpi / 96.0), workArea.Width),
        Math.Min(Scale(640, dpi / 96.0), workArea.Height));

    public static Rectangle Restore(Rectangle workArea, int dpi, Rectangle saved, int savedDpi)
    {
        double scale = dpi / 96.0;
        var min = Minimum(workArea, dpi);
        // Untagged bounds from older versions can be much too small on a scaled display.
        if (saved.IsEmpty || !saved.IntersectsWith(workArea)
            || (savedDpi <= 0 && (saved.Width < min.Width || saved.Height < min.Height)))
        {
            int width = Math.Clamp(Scale(1480, scale), min.Width, Math.Max(min.Width, workArea.Width - Scale(80, scale)));
            int height = Math.Clamp(Scale(940, scale), min.Height, Math.Max(min.Height, workArea.Height - Scale(60, scale)));
            return new Rectangle(workArea.X + (workArea.Width - width) / 2, workArea.Y + (workArea.Height - height) / 2, width, height);
        }

        if (savedDpi > 0)
            saved.Size = new Size(Scale(saved.Width, (double)dpi / savedDpi), Scale(saved.Height, (double)dpi / savedDpi));
        return Fit(saved, workArea, min);
    }

    public static Rectangle Fit(Rectangle bounds, Rectangle workArea, Size minimum)
    {
        int width = Math.Clamp(bounds.Width, minimum.Width, workArea.Width);
        int height = Math.Clamp(bounds.Height, minimum.Height, workArea.Height);
        return new Rectangle(
            Math.Clamp(bounds.X, workArea.Left, workArea.Right - width),
            Math.Clamp(bounds.Y, workArea.Top, workArea.Bottom - height), width, height);
    }
}
