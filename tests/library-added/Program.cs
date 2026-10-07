using Miku;
using Miku.Library;
using System.Text.Json;

// Uses real WAV files and the production library in an isolated profile.
string root = Path.Combine(Path.GetTempPath(), "miku-library-added-" + Guid.NewGuid().ToString("N"));
Environment.SetEnvironmentVariable("MIKU_DATA_DIR", Path.Combine(root, "profile"));
AppPaths.Ensure();
string music = Path.Combine(root, "music"), offline = Path.Combine(root, "offline");
Directory.CreateDirectory(music);
int checks = 0;
void Check(bool ok, string message) { if (!ok) throw new Exception(message); checks++; }
string Id(string path) => Miku.Text.Hash(path.ToLowerInvariant());
Track Find(MusicLibrary lib, string path) => lib.GetTrack(Id(path)) ?? throw new Exception("Missing " + path);
void Wav(string path, DateTime modified)
{
    using (var w = new BinaryWriter(File.Create(path)))
    {
        w.Write(System.Text.Encoding.ASCII.GetBytes("RIFF")); w.Write(36 + 9600);
        w.Write(System.Text.Encoding.ASCII.GetBytes("WAVEfmt ")); w.Write(16);
        w.Write((short)1); w.Write((short)1); w.Write(48000); w.Write(96000);
        w.Write((short)2); w.Write((short)16);
        w.Write(System.Text.Encoding.ASCII.GetBytes("data")); w.Write(9600); w.Write(new byte[9600]);
    }
    File.SetLastWriteTimeUtc(path, modified);
}
async Task Scan(MusicLibrary lib, bool full = false)
{
    var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    void Progress(ScanProgress p) { if (!p.Scanning) done.TrySetResult(); }
    lib.ProgressChanged += Progress;
    try { lib.StartScan(full); await done.Task.WaitAsync(TimeSpan.FromSeconds(30)); }
    finally { lib.ProgressChanged -= Progress; }
}
try
{
    string oldPath = Path.Combine(music, "01 old.wav"), freshPath = Path.Combine(music, "02 newly imported.wav");
    Wav(oldPath, new DateTime(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc));
    var old = TagReader.Read(new FileInfo(oldPath));
    string offlinePath = Path.Combine(offline, "future.wav");
    var future = new Track { Id = Id(offlinePath), Path = offlinePath, Mtime = DateTime.UtcNow.AddYears(10).Ticks };
    Json.SaveAtomic(AppPaths.Library, new LibraryCache { Tracks = new() { old, future } });
    var settings = new Settings { Folders = new() { music, offline } };
    var lib = new MusicLibrary(settings);
    lib.Load();
    long originalAdded = Find(lib, oldPath).Added, offlineAdded = Find(lib, offlinePath).Added;
    Check(originalAdded == old.Mtime, "Legacy order should be migrated once");
    Check(offlineAdded <= DateTime.UtcNow.Ticks, "Future file timestamps must not outrank future imports");
    Check(Json.Load<LibraryCache>(AppPaths.Library).Tracks.All(t => t.Added > 0), "Migration must be persisted without a scan");

    Wav(freshPath, new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc));
    long beforeScan = DateTime.UtcNow.Ticks;
    await Scan(lib);
    long freshAdded = Find(lib, freshPath).Added;
    Check(freshAdded >= beforeScan && freshAdded > originalAdded && freshAdded > offlineAdded, "A newly imported old file must be newest");
    Check(Find(lib, oldPath).Added == originalAdded, "Unchanged files must keep their import time");
    Check(lib.Albums.OrderByDescending(a => a.Added).First().Id == Find(lib, freshPath).AlbumId, "Adding a song should bring its album forward");
    using (var payload = JsonDocument.Parse(lib.ExportJson()))
    {
        var rows = payload.RootElement.GetProperty("tracks").EnumerateArray().ToList();
        Check(rows.Single(r => r[0].GetString() == Id(freshPath))[12].GetDouble() > rows.Single(r => r[0].GetString() == Id(oldPath))[12].GetDouble(), "Export must carry individual track import times");
    }

    File.SetLastWriteTimeUtc(oldPath, DateTime.UtcNow.AddYears(5));
    await Scan(lib);
    Check(Find(lib, oldPath).Added == originalAdded, "File changes must not reset import time");
    await Scan(lib, true);
    Check(Find(lib, oldPath).Added == originalAdded && Find(lib, freshPath).Added == freshAdded, "Full rescans must preserve import times");
    lib.RereadAlbum(Find(lib, oldPath).AlbumId);
    Check(Find(lib, oldPath).Added == originalAdded && Find(lib, freshPath).Added == freshAdded, "Tag rereads must preserve import times");

    string renamed = Path.Combine(music, "03 renamed.wav");
    string albumId = Find(lib, oldPath).AlbumId;
    File.Move(oldPath, renamed);
    lib.RereadAlbum(albumId, new Dictionary<string, string> { [oldPath] = renamed });
    Check(Find(lib, renamed).Added == originalAdded, "Renames must preserve the original import time");

    string lastPath = Path.Combine(music, "04 new during reread.wav");
    Wav(lastPath, new DateTime(1990, 1, 1, 0, 0, 0, DateTimeKind.Utc));
    lib.RereadAlbum(Find(lib, renamed).AlbumId);
    Check(Find(lib, lastPath).Added > freshAdded, "A new song discovered by reread must be newest");
    var restarted = new MusicLibrary(settings);
    restarted.Load();
    Check(Find(restarted, renamed).Added == originalAdded && Find(restarted, freshPath).Added == freshAdded, "Restart must preserve import times");
    Check(Find(restarted, offlinePath).Added == offlineAdded, "Offline entries must retain their import time");
    Console.WriteLine($"Windows library import dates: {checks} checks passed.");
}
finally { Directory.Delete(root, true); }
