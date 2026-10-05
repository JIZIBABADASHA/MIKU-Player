using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace Miku.Library;

/// <summary>A CUE sheet: one big file (or a few) with the track marks (INDEX 01) of the album in it.</summary>
public sealed class CueSheet
{
    public string Path { get; set; }
    public string Title { get; set; } = "";
    public string Performer { get; set; } = "";
    public string Songwriter { get; set; } = "";
    public string Date { get; set; } = "";
    public string Genre { get; set; } = "";
    public List<CueTrack> Tracks { get; } = new();
}

public sealed class CueTrack
{
    public int No { get; set; }
    /// <summary>The music file as the sheet names it (FILE "…").</summary>
    public string FileName { get; set; }
    /// <summary>The library's track for that file (matched by name; a sheet written for "x.wav" also finds "x.flac").</summary>
    public Track Source { get; set; }
    public string Title { get; set; } = "";
    public string Performer { get; set; } = "";
    public string Songwriter { get; set; } = "";
    public double Start { get; set; }
    /// <summary>Seconds; 0 until known (the next mark in the same file, or the file's end).</summary>
    public double Length { get; set; }
}

public static class Cue
{
    static string Arg(string rest)
    {
        rest = rest.Trim();
        if (rest.StartsWith('"')) { int e = rest.LastIndexOf('"'); return e > 0 ? rest[1..e] : rest[1..]; }
        return rest;
    }

    /// <summary>Reads a CUE sheet (UTF-8, UTF-16, Shift-JIS, Big5, GBK…).</summary>
    public static CueSheet Parse(string path)
    {
        var cue = new CueSheet { Path = path };
        string text = Text.DecodeUnknown(File.ReadAllBytes(path));
        string file = null;
        CueTrack cur = null;
        foreach (var raw in text.Split('\n'))
        {
            string line = raw.Trim().TrimStart('﻿');
            if (line.Length == 0) continue;
            int sp = line.IndexOf(' ');
            string key = (sp < 0 ? line : line[..sp]).ToUpperInvariant(), rest = sp < 0 ? "" : line[(sp + 1)..];
            switch (key)
            {
                case "FILE":
                {
                    rest = rest.Trim();
                    // FILE "name" WAVE: the type word after the closing quote is not part of the name
                    if (rest.StartsWith('"')) { int e = rest.LastIndexOf('"'); file = e > 0 ? rest[1..e] : rest[1..]; }
                    else { int e = rest.LastIndexOf(' '); file = e > 0 ? rest[..e] : rest; }
                    break;
                }
                case "TRACK":
                {
                    var parts = rest.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    cur = null;
                    if (parts.Length >= 2 && !parts[1].Equals("AUDIO", StringComparison.OrdinalIgnoreCase)) break;   // data tracks
                    cur = new CueTrack { No = parts.Length > 0 && int.TryParse(parts[0], out int n) ? n : cue.Tracks.Count + 1, FileName = file, Start = -1 };
                    cue.Tracks.Add(cur);
                    break;
                }
                case "TITLE": if (cur != null) cur.Title = Arg(rest); else cue.Title = Arg(rest); break;
                case "PERFORMER": if (cur != null) cur.Performer = Arg(rest); else cue.Performer = Arg(rest); break;
                case "SONGWRITER": if (cur != null) cur.Songwriter = Arg(rest); else cue.Songwriter = Arg(rest); break;
                case "REM":
                {
                    int s2 = rest.IndexOf(' ');
                    if (s2 < 0 || cur != null) break;
                    string k = rest[..s2].ToUpperInvariant(), v = Arg(rest[(s2 + 1)..]);
                    if (k == "DATE") cue.Date = v; else if (k == "GENRE") cue.Genre = v;
                    break;
                }
                case "INDEX":
                {
                    var parts = rest.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (cur == null || parts.Length < 2 || parts[0] != "01") break;
                    var t = parts[1].Split(':');
                    if (t.Length == 3 && int.TryParse(t[0], out int m) && int.TryParse(t[1], out int s) && int.TryParse(t[2], out int f))
                        cur.Start = m * 60 + s + f / 75.0;   // CD frames: 75 a second
                    break;
                }
            }
        }
        cue.Tracks.RemoveAll(t => t.Start < 0 || string.IsNullOrEmpty(t.FileName));
        return cue;
    }

    /// <summary>
    /// The CUE sheet in the album's folder whose marks cut one of its files into several tracks, with each mark's file
    /// and length filled in; null when there is none.
    /// </summary>
    public static CueSheet ForAlbum(Album al)
    {
        if (al == null || al.Tracks.Count == 0) return null;
        var dirs = al.Tracks.Select(t => System.IO.Path.GetDirectoryName(t.Path) ?? "").Distinct(StringComparer.OrdinalIgnoreCase);
        CueSheet best = null;
        foreach (var dir in dirs)
        {
            string[] cues;
            try { cues = Directory.GetFiles(dir, "*.cue"); } catch { continue; }
            foreach (var path in cues)
            {
                CueSheet cue;
                try { cue = Parse(path); } catch (Exception ex) { Log.Error("CUE " + path, ex); continue; }
                foreach (var ct in cue.Tracks) ct.Source = Match(al, dir, ct.FileName);
                cue.Tracks.RemoveAll(ct => ct.Source == null);
                // a file cut into at least two tracks (a sheet for files that are already one per track has nothing to cut)
                if (!cue.Tracks.GroupBy(ct => ct.Source).Any(g => g.Count() >= 2)) continue;
                foreach (var g in cue.Tracks.GroupBy(ct => ct.Source))
                {
                    var list = g.OrderBy(ct => ct.Start).ToList();
                    for (int i = 0; i < list.Count; i++)
                        list[i].Length = Math.Max(0, (i + 1 < list.Count ? list[i + 1].Start : g.Key.Duration) - list[i].Start);
                }
                cue.Tracks.RemoveAll(ct => ct.Length <= 0.05);
                if (best == null || cue.Tracks.Count > best.Tracks.Count) best = cue;
            }
        }
        return best;
    }

    static Track Match(Album al, string dir, string name)
    {
        if (string.IsNullOrEmpty(name)) return null;
        string file = System.IO.Path.GetFileName(name.Replace('/', '\\'));
        string stem = System.IO.Path.GetFileNameWithoutExtension(file);
        bool Here(Track t) => string.Equals(System.IO.Path.GetDirectoryName(t.Path), dir, StringComparison.OrdinalIgnoreCase);
        return al.Tracks.FirstOrDefault(t => Here(t) && string.Equals(System.IO.Path.GetFileName(t.Path), file, StringComparison.OrdinalIgnoreCase))
            ?? al.Tracks.FirstOrDefault(t => Here(t) && string.Equals(System.IO.Path.GetFileNameWithoutExtension(t.Path), stem, StringComparison.OrdinalIgnoreCase));
    }
}
