# Performance and recovery checks

Run from the repository root with Node.js and the .NET 8 SDK. The repository's
`.tools/dotnet/dotnet.exe` can be used in place of `dotnet` on Windows.

```powershell
node --test tests/performance/frontend/frontend.test.cjs tests/performance/mac/library.test.cjs
dotnet build tests/performance/windows/WindowsPerformance.csproj -c Release -m:1 -p:ExtensionsDir=__no_extensions__ -p:NuGetAudit=false
dotnet tests/performance/windows/bin/Release/net8.0-windows/WindowsPerformance.dll
dotnet build tests/performance/recovery/Recovery.csproj -c Release -m:1 -p:ExtensionsDir=__no_extensions__ -p:NuGetAudit=false
dotnet tests/performance/recovery/bin/Release/net8.0-windows/Recovery.dll
```

The Windows checks use a temporary profile, a fake audio engine for queue checks,
and loopback TCP connections for real HTTP range/keep-alive tests. A restricted
environment must permit those local TCP connections. No audio output is started.

The recovery check creates an invisible test window with its own empty profile,
crashes **that window's** WebView2 renderer through the DevTools protocol, and
checks that the frontend becomes ready again with the same audio engine. It also
checks malformed bridge messages and preservation of the previous rotated log.
Its profiles are kept under its ignored `bin/` directory for inspection.

The Daphne lifetime check compiles the real C# native wrapper and engine sources
against a test C ABI. Build its **test-only** DLL with a Windows x64 C compiler:

```powershell
dotnet build tests/performance/daphne/NativeLifetime.csproj -c Release -m:1 -p:ExtensionsDir=__no_extensions__ -p:NuGetAudit=false
gcc -shared -O2 tests/performance/daphne/native-stub.c -o tests/performance/daphne/bin/Release/net8.0-windows/daphne_core.dll
dotnet tests/performance/daphne/bin/Release/net8.0-windows/NativeLifetime.dll
```

The existing portable compiler in this checkout is
`.tools/mac-packaging/compiler/w64devkit/bin/gcc.exe`. The stub belongs only in
that test's `bin/` folder. It provides a deliberately blocked native call and
records when destruction occurs; it never accesses an audio device.

With the actual `daphne_core.dll` and its FFmpeg DLL dependencies copied into that
test's `bin/` folder instead, `NativeLifetime.dll --real` runs real native
create/poll/dispose stress cycles without loading audio files.

## Evidence from 2026-10-23

- 25 Windows regression assertions passed. On 100,000 queue entries over ten
  iterations, random-key sorting took 141.2 ms / 24,003,080 allocated bytes;
  Fisher-Yates took 8.0 ms / 8,000,600 bytes (including the input copy).
- Ten frontend checks and six Mac library checks passed, including a 150,000-track
  loose folder, result ordering, artist/album grouping, virtual scrolling cleanup,
  and lyric alignment/manual scrolling.
- A common search over 100,000 matching entries visits 80 entries for an 80-result
  limit. Sparse/no-match searches still scan the collection.
- A 500-line instant lyric layout requires one geometry flush, previously 500.
- Full-resolution cover loading/decoding uses at most four concurrent jobs; jobs
  waiting for a slot do not read and retain their source images. Concurrent misses
  for the same image share one task.
- A synthetic 30,000-track Mac loose-folder rebuild had a five-run median of
  1,360.95 ms before and 92.99 ms after; exported JSON was byte-identical.
  This is a focused benchmark, not an estimate of overall application speed.
- Eighty production JavaScript files passed `node --check`.
- A real renderer crash recovered successfully, retained the audio engine, and
  wrote its failure kind/reason/exit code to the isolated log.
- The initial performance package and its existing extension binaries passed the same
  isolated renderer-crash check with `DaphneEngine` selected and retained. This
  loads the native core but does not start audio output.
- The subsequent Daphne managed-wrapper fix passed 16 lifetime/allocation
  assertions. The test ABI reproduced destruction during an active native call
  after the former 500 ms wait. SafeHandle disposal prevented that ordering,
  rejected new calls after closure, and skipped queued loads after disposal.
- Twenty-five concurrent polling/disposal stress rounds passed against the test
  ABI, followed by 25 real native create/poll/dispose cycles and a disposed-engine
  guard check. Empty polling now allocates 88,000 managed bytes per 1,000 calls;
  the former temporary byte arrays alone used 16,384,000 bytes.
- The stability2 package with the rebuilt Daphne managed wrapper also passed the
  renderer crash/recovery integration check. The packaged native DLL hash matches
  the original production native core; no test stub is included in the package.

The optional benchmark accepts a saved original `library.js`:

```powershell
node tests/performance/mac/benchmark-library.cjs path/to/original-library.js
```

The recovery harness also accepts `--daphne` when run from a test deployment that
contains the Daphne extension under `ext/`. Its default test output intentionally
has no extensions.

## Crash investigation limits

The existing user log contained repeated starts and a caught null-reference error
in `MainForm.OnResource` while loading artwork. The Windows events inspected did
not identify a fatal MIKU exception or faulting module. A separate MoodWave helper
memory-leak warning is insufficient to attribute the player's exits to it.

The resource handler now captures its environment before awaiting, guards shutdown,
and catches deferral-completion failures. Renderer exits trigger one automatic
reload per minute; browser exits display a restart prompt. Daphne's C# wrapper now
owns the native player through SafeHandle, so an active P/Invoke keeps it alive
through disposal, and closing cannot start another queued load. An unloaded engine
also avoids the native gapless command, which otherwise waits behind a load's
operation mutex. Native DSP/C++ code and playback settings were not changed.
Startup/normal-close/message-loop-exit
logs and a retained previous log improve the next incident's diagnosis.

The reported intermittent long-play exits/hangs have not been reproduced. The
recovery check proves renderer recovery, not recovery from a native audio crash.
macOS packaging, Core Audio playback and a long-running hardware playback test
must still be performed on their target systems.

The wrapper/engine changes are in the `Extensions/Daphne` Git submodule's working
tree. A repository commit must preserve those changes in that submodule as well
as the parent changes; no submodule commit or remote update was made here.
