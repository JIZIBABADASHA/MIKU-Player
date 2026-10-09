// MIKU's native PCM output for macOS (protocol 3). JSON lines on stdin/stdout; FFmpeg is spawned without a shell.
//
// Decks and the output are separate:
//   Deck    One per track. FFmpeg decodes to signed 32-bit PCM at the output's rate into a lock-free ring. Decks belong
//           to the player, not to a device: switching the output keeps them, so when the new device runs at the same
//           rate playback continues at the very next sample; otherwise the deck is reopened at the same position.
//   Output  One Core Audio device, shared or exclusive (hog mode). The IOProc writes each stream's virtual format
//           (32-bit float on current macOS drivers). MIKU never changes the virtual format; in exclusive mode it sets
//           the device's nominal rate and gives the DAC's physical format enough integer bits.
//
// Bit-perfect: exclusive, device rate = source rate, a DAC format holding at least the source's bits, unity gain and
// no processing. 32-bit float holds every 16/24-bit integer sample exactly and the HAL's float → integer conversion of
// those values is exact, so the DAC receives the source's samples (the same path Audirvana and Roon use on macOS).
//
// A same-rate track change or seek swaps decks while the device keeps running (no DAC relock, no gap). Device events
// are handled here: the system output is followed when chosen, a returning DAC is moved back to, an unplugged device
// pauses at its place, an outside rate change is followed. The app is told with "output" / "lost" events.
//
// The HAL callback never allocates, blocks, calls Foundation, or writes to a pipe.
#import <Foundation/Foundation.h>
#include <CoreAudio/CoreAudio.h>
#include <algorithm>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstring>
#include <deque>
#include <functional>
#include <map>
#include <fcntl.h>
#include <libproc.h>
#include <memory>
#include <mutex>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdexcept>
#include <string>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <vector>

extern char **environ;
static volatile sig_atomic_t quitting = 0;
static void terminate(int) { quitting = 1; }
static void sleepMs(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }
using Clock = std::chrono::steady_clock;
static double since(Clock::time_point t) { return std::chrono::duration<double>(Clock::now() - t).count(); }

// ───────────── diagnostics: stderr lines end up in miku.log ("Core Audio: …") ─────────────
static const Clock::time_point bootTime = Clock::now();
static void trace(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void trace(const char *fmt, ...) {
    char line[1200]; va_list ap; va_start(ap, fmt); vsnprintf(line, sizeof(line), fmt, ap); va_end(ap);
    fprintf(stderr, "[%.3f] %s\n", since(bootTime), line); fflush(stderr);
}
// What the command thread is doing right now (string literals only), for the watchdog.
static std::atomic<const char *> phase{"idle"}, busyWith{""};
static std::atomic<double> busySince{0};
struct Phase {
    const char *prev;
    explicit Phase(const char *p) : prev(phase.exchange(p)) { }
    ~Phase() { phase.store(prev); }
};
struct Busy {   // nests: device events handled inside a command keep the command's start time
    const char *prevWhat; double prevAt;
    explicit Busy(const char *what) : prevWhat(busyWith.exchange(what)), prevAt(busySince.load()) { if (prevAt <= 0) busySince.store(since(bootTime)); }
    ~Busy() { busyWith.store(prevWhat); busySince.store(prevAt); }
};
// A Core Audio call that never returns would leave the output silent and every request unanswered. The watchdog says
// where it is stuck and, after 25 s, ends the process: the app restarts the helper and continues where playback was.
static void startWatchdog() {
    std::thread([] {
        double reported = 0;
        while (!quitting) {
            sleepMs(1000);
            double at = busySince.load();
            if (at <= 0) { reported = 0; continue; }
            double stuck = since(bootTime) - at;
            if (stuck >= 6 && stuck - reported >= 3) { trace("WATCHDOG: %s running for %.0f s, now in: %s", busyWith.load(), stuck, phase.load()); reported = stuck; }
            if (stuck >= 25) { trace("WATCHDOG: giving up in %s; restarting the audio engine", phase.load()); _exit(75); }
        }
    }).detach();
}

// ───────────── JSON input: every value is type-checked (a null or a string where a number belongs must not throw) ─────────────
static double num(id v, double fallback = 0) {
    if (![v isKindOfClass:[NSNumber class]]) return fallback;
    double d = [(NSNumber *)v doubleValue];
    return std::isfinite(d) ? d : fallback;
}
static bool flag(id v) { return [v isKindOfClass:[NSNumber class]] && [(NSNumber *)v boolValue]; }
static NSString *text(id v) { return [v isKindOfClass:[NSString class]] ? (NSString *)v : nil; }
static NSDictionary *dictOf(id v) { return [v isKindOfClass:[NSDictionary class]] ? (NSDictionary *)v : nil; }
static NSArray *listOf(id v) { return [v isKindOfClass:[NSArray class]] ? (NSArray *)v : nil; }
static std::string str(NSString *s) { const char *c = s ? s.UTF8String : nullptr; return c ? std::string(c) : std::string(); }
static NSString *ns(const std::string &s) { return [NSString stringWithUTF8String:s.c_str()] ?: @""; }
static bool is(NSString *a, NSString *b) { return a && [a isEqualToString:b]; }

// ───────────── JSON output: NaN / Inf are not JSON and would raise an Objective-C exception ─────────────
static id jsonSafe(id v) {
    if ([v isKindOfClass:[NSNumber class]]) return std::isfinite([(NSNumber *)v doubleValue]) ? v : @0;
    if ([v isKindOfClass:[NSDictionary class]]) {
        NSMutableDictionary *m = [NSMutableDictionary dictionary];
        for (id key in (NSDictionary *)v) m[key] = jsonSafe(((NSDictionary *)v)[key]);
        return m;
    }
    if ([v isKindOfClass:[NSArray class]]) {
        NSMutableArray *a = [NSMutableArray array];
        for (id item in (NSArray *)v) [a addObject:jsonSafe(item)];
        return a;
    }
    return v ?: [NSNull null];
}
static void emit(NSDictionary *m) {
    @try {
        NSData *data = [NSJSONSerialization dataWithJSONObject:jsonSafe(m) options:0 error:nil];
        if (data) { fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout); }
    } @catch (NSException *e) {
        fprintf(stderr, "emit: %s\n", e.reason.UTF8String ?: "?");
    }
}
static std::string khz(double rate) {
    char b[32]; double k = rate / 1000;
    if (std::abs(k - std::round(k)) < 0.01) snprintf(b, sizeof(b), "%.0f kHz", k); else snprintf(b, sizeof(b), "%.1f kHz", k);
    return b;
}

// ───────────── HAL helpers ─────────────
static AudioObjectPropertyAddress addr(AudioObjectPropertySelector p, AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal) {
    return {p, scope, kAudioObjectPropertyElementMain};
}
static void check(OSStatus s, const char *what) {
    if (s) throw std::runtime_error(std::string(what) + "（Core Audio " + std::to_string(int(s)) + "）");
}
template<class T> static T get(AudioObjectID id, AudioObjectPropertySelector p, AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal) {
    T v{}; UInt32 n = sizeof(v); auto a = addr(p, scope);
    check(AudioObjectGetPropertyData(id, &a, 0, nullptr, &n, &v), "無法讀取音訊裝置屬性"); return v;
}
template<class T> static std::vector<T> array(AudioObjectID id, AudioObjectPropertySelector p, AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal) {
    auto a = addr(p, scope); UInt32 n = 0;
    if (AudioObjectGetPropertyDataSize(id, &a, 0, nullptr, &n)) return {};
    std::vector<T> v(n / sizeof(T));
    if (n && AudioObjectGetPropertyData(id, &a, 0, nullptr, &n, v.data())) return {};
    v.resize(n / sizeof(T));
    return v;
}
template<class T> static void set(AudioObjectID id, AudioObjectPropertySelector p, const T &value) {
    auto a = addr(p); Boolean writable = false;
    check(AudioObjectIsPropertySettable(id, &a, &writable), "無法查詢裝置設定");
    if (!writable) throw std::runtime_error("音訊裝置不允許更改這個設定");
    check(AudioObjectSetPropertyData(id, &a, 0, nullptr, sizeof(T), &value), "無法更改音訊裝置設定");
}
static NSString *nameOf(AudioObjectID id, AudioObjectPropertySelector p) {
    if (!id) return @"";
    CFStringRef s = nullptr; UInt32 n = sizeof(s); auto a = addr(p);
    if (AudioObjectGetPropertyData(id, &a, 0, nullptr, &n, &s) || !s) return @"";
    return CFBridgingRelease(s);
}
static std::string uidOf(AudioDeviceID d) { return str(nameOf(d, kAudioDevicePropertyDeviceUID)); }
static bool alive(AudioDeviceID d) {
    if (!d) return false;
    UInt32 v = 0, n = sizeof(v); auto a = addr(kAudioDevicePropertyDeviceIsAlive);
    return !AudioObjectGetPropertyData(d, &a, 0, nullptr, &n, &v) && v;
}
static AudioDeviceID defaultOutput() {
    AudioDeviceID d = 0; UInt32 n = sizeof(d); auto a = addr(kAudioHardwarePropertyDefaultOutputDevice);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, nullptr, &n, &d)) return 0;
    return d;
}
static std::vector<AudioDeviceID> allDevices() { return array<AudioDeviceID>(kAudioObjectSystemObject, kAudioHardwarePropertyDevices); }
static std::vector<AudioStreamID> outputStreams(AudioDeviceID d) { return array<AudioStreamID>(d, kAudioDevicePropertyStreams, kAudioDevicePropertyScopeOutput); }
static bool listed(AudioDeviceID d) {
    for (auto x : allDevices()) if (x == d) return true;
    return false;
}
static AudioDeviceID deviceWithUID(const std::string &uid) {
    if (uid.empty()) return 0;
    for (auto d : allDevices()) if (uidOf(d) == uid && alive(d) && !outputStreams(d).empty()) return d;
    return 0;
}
static Float64 nominalRate(AudioDeviceID d) { return get<Float64>(d, kAudioDevicePropertyNominalSampleRate); }
static pid_t hogOwner(AudioDeviceID d) {
    auto a = addr(kAudioDevicePropertyHogMode);
    if (!d || !AudioObjectHasProperty(d, &a)) return -1;
    pid_t p = -1; UInt32 n = sizeof(p);
    return AudioObjectGetPropertyData(d, &a, 0, nullptr, &n, &p) ? -1 : p;
}
static bool hogSettable(AudioDeviceID d) {
    auto a = addr(kAudioDevicePropertyHogMode); Boolean writable = false;
    return AudioObjectHasProperty(d, &a) && !AudioObjectIsPropertySettable(d, &a, &writable) && writable;
}
static UInt32 transportOf(AudioDeviceID d) {
    UInt32 t = 0, n = sizeof(t); auto a = addr(kAudioDevicePropertyTransportType);
    return AudioObjectGetPropertyData(d, &a, 0, nullptr, &n, &t) ? 0 : t;
}
static AudioStreamBasicDescription virtualFormat(AudioStreamID s) { return get<AudioStreamBasicDescription>(s, kAudioStreamPropertyVirtualFormat); }
static AudioStreamBasicDescription physicalFormat(AudioStreamID s) { return get<AudioStreamBasicDescription>(s, kAudioStreamPropertyPhysicalFormat); }
static std::string processName(pid_t pid) {
    char name[256] = {0};
    if (proc_name(pid, name, sizeof(name)) > 0 && name[0]) return std::string(name) + "（PID " + std::to_string(pid) + "）";
    return "PID " + std::to_string(pid);
}

// ───────────── sample rates ─────────────
static bool sameRate(double a, double b) { return std::abs(a - b) < 0.5; }
static bool supportsRate(AudioDeviceID d, double rate) {
    for (auto r : array<AudioValueRange>(d, kAudioDevicePropertyAvailableNominalSampleRates))
        if (rate >= r.mMinimum - 0.5 && rate <= r.mMaximum + 0.5) return true;
    return false;
}
static const int StandardRates[] = {44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000};
static std::vector<double> availableRates(AudioDeviceID d) {
    std::vector<double> rates;
    for (int r : StandardRates) if (supportsRate(d, r)) rates.push_back(r);
    return rates;
}
static int family(double rate) { return std::fmod(rate, 11025.0) < 0.5 ? 44 : 48; }
// The rate used when the device can't run at the track's own rate (same rule as the Windows engine): the highest
// rate of the same family not above it, else the lowest rate above it, else the device's highest rate.
static double chooseRate(double desired, const std::vector<double> &rates) {
    if (rates.empty()) return 0;
    for (double r : rates) if (sameRate(r, desired)) return r;
    double best = 0;
    for (double r : rates) if (family(r) == family(desired) && r <= desired) best = std::max(best, r);
    if (best > 0) return best;
    for (double r : rates) if (r >= desired && (best == 0 || r < best)) best = r;
    if (best > 0) return best;
    return *std::max_element(rates.begin(), rates.end());
}

// ───────────── sample formats ─────────────
static bool isInteger(const AudioStreamBasicDescription &f) {
    return f.mFormatID == kAudioFormatLinearPCM && !(f.mFormatFlags & kAudioFormatFlagIsFloat) && (f.mFormatFlags & kAudioFormatFlagIsSignedInteger);
}
// Bits a format holds exactly: 32-bit float holds 24-bit integers exactly (24-bit significand).
static int precision(const AudioStreamBasicDescription &f) {
    if (f.mFormatID != kAudioFormatLinearPCM) return 0;
    if (f.mFormatFlags & kAudioFormatFlagIsFloat) return f.mBitsPerChannel == 64 ? 53 : f.mBitsPerChannel == 32 ? 24 : 0;
    return (f.mFormatFlags & kAudioFormatFlagIsSignedInteger) ? int(f.mBitsPerChannel) : 0;
}
static int sampleBytes(const AudioStreamBasicDescription &f) {
    return int(f.mBytesPerFrame / ((f.mFormatFlags & kAudioFormatFlagIsNonInterleaved) ? 1 : std::max(1u, f.mChannelsPerFrame)));
}
// A format the packer below can write.
static bool packable(const AudioStreamBasicDescription &f) {
    if (f.mFormatID != kAudioFormatLinearPCM || f.mChannelsPerFrame < 1 || !precision(f)) return false;
    int bytes = sampleBytes(f);
    if (f.mFormatFlags & kAudioFormatFlagIsFloat) return (bytes == 4 && f.mBitsPerChannel == 32) || (bytes == 8 && f.mBitsPerChannel == 64);
    return bytes >= 2 && bytes <= 4 && f.mBitsPerChannel >= 16 && f.mBitsPerChannel <= 32 && f.mBitsPerChannel <= UInt32(bytes * 8);
}
static bool sameFormat(const AudioStreamBasicDescription &a, const AudioStreamBasicDescription &b) {
    return sameRate(a.mSampleRate, b.mSampleRate) && a.mFormatID == b.mFormatID && a.mFormatFlags == b.mFormatFlags &&
        a.mBytesPerFrame == b.mBytesPerFrame && a.mChannelsPerFrame == b.mChannelsPerFrame && a.mBitsPerChannel == b.mBitsPerChannel;
}
static bool sameFormats(const std::vector<AudioStreamBasicDescription> &a, const std::vector<AudioStreamBasicDescription> &b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i) if (!sameFormat(a[i], b[i])) return false;
    return true;
}
static NSString *formatName(const AudioStreamBasicDescription &f) {
    if (f.mFormatID != kAudioFormatLinearPCM) return @"非 PCM";
    if (f.mFormatFlags & kAudioFormatFlagIsFloat) return [NSString stringWithFormat:@"%u-bit 浮點", (unsigned)f.mBitsPerChannel];
    int container = sampleBytes(f) * 8;
    return container == int(f.mBitsPerChannel) ? [NSString stringWithFormat:@"%u-bit PCM", (unsigned)f.mBitsPerChannel]
        : [NSString stringWithFormat:@"%u-bit PCM（%d-bit 容器）", (unsigned)f.mBitsPerChannel, container];
}
static NSDictionary *formatInfo(const AudioStreamBasicDescription &f) {
    return @{@"rate":@(f.mSampleRate),@"bits":@(f.mBitsPerChannel),@"flags":@(f.mFormatFlags),@"bytesPerFrame":@(f.mBytesPerFrame),@"channels":@(f.mChannelsPerFrame)};
}
static NSString *transportName(UInt32 t) {
    switch (t) {
        case kAudioDeviceTransportTypeBuiltIn: return @"builtin";
        case kAudioDeviceTransportTypeUSB: return @"usb";
        case kAudioDeviceTransportTypeBluetooth: case kAudioDeviceTransportTypeBluetoothLE: return @"bluetooth";
        case kAudioDeviceTransportTypeAirPlay: return @"airplay";
        case kAudioDeviceTransportTypeHDMI: case kAudioDeviceTransportTypeDisplayPort: return @"display";
        case kAudioDeviceTransportTypeThunderbolt: return @"thunderbolt";
        case kAudioDeviceTransportTypeAggregate: return @"aggregate";
        case kAudioDeviceTransportTypeVirtual: return @"virtual";
        default: return @"other";
    }
}

static NSDictionary *deviceInfo(AudioDeviceID d) {
    auto streams = outputStreams(d);
    if (streams.empty()) return nil;
    NSMutableArray *rates = [NSMutableArray array];
    for (double rate : availableRates(d)) [rates addObject:@(rate)];
    pid_t owner = hogOwner(d);
    auto f = physicalFormat(streams[0]);
    auto v = virtualFormat(streams[0]);
    NSMutableArray *physicalFormats = [NSMutableArray array], *virtualFormats = [NSMutableArray array];
    for (auto item : array<AudioStreamRangedDescription>(streams[0], kAudioStreamPropertyAvailablePhysicalFormats)) [physicalFormats addObject:formatInfo(item.mFormat)];
    for (auto item : array<AudioStreamRangedDescription>(streams[0], kAudioStreamPropertyAvailableVirtualFormats)) [virtualFormats addObject:formatInfo(item.mFormat)];
    return @{ @"id": nameOf(d, kAudioDevicePropertyDeviceUID), @"name": nameOf(d, kAudioObjectPropertyName),
        @"rate": @(nominalRate(d)), @"rates": rates, @"exclusiveSupported": @(hogSettable(d)), @"ownerPid": @(owner),
        @"ownerName": owner > 0 && owner != getpid() ? ns(processName(owner)) : @"", @"transport": transportName(transportOf(d)),
        @"physicalFormat": formatName(f), @"physicalBits": @(f.mBitsPerChannel), @"channels": @(f.mChannelsPerFrame),
        @"virtualFormat": formatName(v), @"physical": formatInfo(f), @"virtual": formatInfo(v),
        @"physicalFormats": physicalFormats, @"virtualFormats": virtualFormats };
}
// `def` is the device the "system output" entry stands for (see Engine::logicalDefault).
static NSArray *devices(AudioDeviceID def) {
    NSMutableArray *items = [NSMutableArray array];
    for (auto d : allDevices()) {
        try {
            NSDictionary *info = deviceInfo(d); if (!info) continue;
            NSMutableDictionary *m = [info mutableCopy]; m[@"isDefault"] = @NO; [items addObject:m];
            if (d == def) { NSMutableDictionary *m2 = [info mutableCopy]; m2[@"id"] = @"default"; m2[@"isDefault"] = @YES; [items insertObject:m2 atIndex:0]; }
        } catch (...) { }   // a device being removed while it is listed
    }
    return items;
}

// FFmpeg's signed 32-bit PCM is left justified. For 16/24-bit sources the low bits are zero, so 32-bit float and any
// integer format with enough bits hold the value exactly. No dither, gain, clipping, or rounding on the unity path.
static void pack(uint8_t *dst, int32_t value, const AudioStreamBasicDescription &f, int bytes) {
    uint64_t word = 0;
    if (f.mFormatFlags & kAudioFormatFlagIsFloat) {
        if (bytes == 4) { float v = float(double(value) / 2147483648.0); uint32_t u; memcpy(&u, &v, 4); word = u; }
        else { double v = double(value) / 2147483648.0; memcpy(&word, &v, 8); }
    } else {
        uint32_t u = uint32_t(value);
        if (f.mFormatFlags & kAudioFormatFlagIsAlignedHigh) word = u >> (32 - bytes * 8);
        else word = uint32_t(value >> (32 - f.mBitsPerChannel));
    }
    if (f.mFormatFlags & kAudioFormatFlagIsBigEndian) { for (int i = 0; i < bytes; ++i) dst[bytes - 1 - i] = uint8_t(word >> (i * 8)); }
    else if (bytes == 4) { uint32_t w = uint32_t(word); memcpy(dst, &w, 4); }
    else { for (int i = 0; i < bytes; ++i) dst[i] = uint8_t(word >> (i * 8)); }
}

// Single producer (decoder thread), single consumer (IO thread).
struct Ring {
    std::vector<int32_t> data;
    const size_t capacity; const int channels;
    std::atomic<uint64_t> read{0}, write{0};
    Ring(size_t frames, int ch) : data(frames * size_t(ch)), capacity(frames), channels(ch) {}
    size_t size() const { return size_t(write.load(std::memory_order_acquire) - read.load(std::memory_order_acquire)); }
    size_t push(const int32_t *src, size_t count) {
        uint64_t w = write.load(std::memory_order_relaxed), r = read.load(std::memory_order_acquire);
        size_t n = std::min(count, capacity - size_t(w - r));
        for (size_t i = 0; i < n; ++i) {
            size_t at = size_t((w + i) % capacity) * size_t(channels);
            for (int c = 0; c < channels; ++c) data[at + size_t(c)] = src[i * size_t(channels) + size_t(c)];
        }
        write.store(w + n, std::memory_order_release); return n;
    }
    // Up to `count` frames as interleaved stereo (a mono ring gives the same sample on both sides).
    size_t pop(int32_t *dst, size_t count) {
        uint64_t r = read.load(std::memory_order_relaxed), w = write.load(std::memory_order_acquire);
        size_t n = std::min(count, size_t(w - r));
        for (size_t i = 0; i < n; ++i) {
            size_t at = size_t((r + i) % capacity) * size_t(channels);
            dst[2 * i] = data[at]; dst[2 * i + 1] = channels == 1 ? data[at] : data[at + 1];
        }
        read.store(r + n, std::memory_order_release); return n;
    }
};

static double positive(double v, double fallback) { return v > 0 && std::isfinite(v) ? v : fallback; }
static int bitsNeeded(NSDictionary *m) { return flag(m[@"integerSource"]) ? std::clamp(int(num(m[@"bits"], 16)), 16, 32) : 16; }

// One track decoding at one output rate. `params` is the app's load command, kept so the deck can be reopened at
// another position or rate.
struct Deck {
    NSDictionary *params;
    const std::string id;
    const double rate, sourceRate, position, duration, rg;
    const int bits, sourceChannels, channels;
    Ring ring;
    std::atomic<bool> cancel{false}, eof{false};
    std::atomic<int> exitCode{-1};
    std::atomic<uint64_t> consumed{0};
    std::thread worker;
    pid_t pid = -1; int fd = -1;
    Deck(NSDictionary *m, double outputRate, double from) : params(m), id(str(text(m[@"id"]))), rate(outputRate), sourceRate(num(m[@"rate"])),
        position(std::max(0.0, from)), duration(std::max(0.0, num(m[@"duration"]))), rg(positive(num(m[@"rg"], 1), 1)), bits(bitsNeeded(m)),
        sourceChannels(std::max(1, int(num(m[@"channels"], 2)))), channels(sourceChannels == 1 ? 1 : 2),
        ring(size_t(std::max(8000.0, outputRate) * 2), sourceChannels == 1 ? 1 : 2) {
        if (!(rate > 0)) throw std::runtime_error("輸出取樣率無效");
        std::string ffmpeg = str(text(m[@"ffmpeg"])), path = str(text(m[@"path"]));
        if (ffmpeg.empty() || path.empty()) throw std::runtime_error("缺少 FFmpeg 或檔案路徑");
        std::vector<std::string> args = {ffmpeg, "-v", "error", "-nostdin"};
        if (position > 0) { args.push_back("-ss"); args.push_back(std::to_string(position)); }
        args.insert(args.end(), {"-i", path, "-map", "0:a:0", "-vn", "-sn", "-dn"});
        std::string out = std::to_string(int(std::lround(rate)));
        if (flag(m[@"dsd"])) args.insert(args.end(), {"-af", "aresample=" + out + ":filter_size=64:cutoff=0.97,volume=-1dB"});
        // Same headroom as the Windows engine: a resampler can overshoot full scale between samples.
        else if (!sameRate(sourceRate, rate)) args.insert(args.end(), {"-af", "volume=-1dB:precision=double,aresample=" + out + ":filter_size=64:phase_shift=10:cutoff=0.97"});
        if (sourceChannels > 2) args.insert(args.end(), {"-ac", "2"});
        args.insert(args.end(), {"-c:a", "pcm_s32le", "-f", "s32le", "pipe:1"});
        std::vector<char *> argv; for (auto &s : args) argv.push_back(s.data()); argv.push_back(nullptr);
        int pipes[2]; if (pipe(pipes)) throw std::runtime_error("無法建立 PCM 解碼管道");
        fcntl(pipes[0], F_SETFD, FD_CLOEXEC); fcntl(pipes[1], F_SETFD, FD_CLOEXEC);
        posix_spawn_file_actions_t actions; posix_spawn_file_actions_init(&actions);
        posix_spawn_file_actions_adddup2(&actions, pipes[1], STDOUT_FILENO);
        posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
        // FFmpeg diagnostics must not corrupt the JSON transport. A failed decoder is reported by exit status.
        posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0);
        posix_spawn_file_actions_addclose(&actions, pipes[0]); posix_spawn_file_actions_addclose(&actions, pipes[1]);
        // FFmpeg inherits only stdin/stdout/stderr: none of MIKU's pipes or Core Audio's own descriptors.
        posix_spawnattr_t attr; posix_spawnattr_init(&attr);
        posix_spawnattr_setflags(&attr, POSIX_SPAWN_CLOEXEC_DEFAULT);
        int error = posix_spawn(&pid, argv[0], &actions, &attr, argv.data(), environ);
        posix_spawnattr_destroy(&attr); posix_spawn_file_actions_destroy(&actions); close(pipes[1]);
        if (error) { close(pipes[0]); throw std::runtime_error("無法啟動 FFmpeg PCM 解碼器"); }
        fd = pipes[0];
        worker = std::thread([this] {
            pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED, 0);
            alignas(int32_t) uint8_t bytes[65536]; size_t carry = 0; const size_t frameBytes = size_t(channels) * 4;
            while (!cancel.load()) {
                pollfd p{fd, POLLIN, 0}; int polled = poll(&p, 1, 100);
                if (polled < 0) { if (errno == EINTR) continue; break; }
                if (!polled) continue;
                ssize_t n = ::read(fd, bytes + carry, sizeof(bytes) - carry);
                if (n < 0 && errno == EINTR) continue;
                if (n <= 0) break;
                size_t total = carry + size_t(n), frames = total / frameBytes, offset = 0;
                const int32_t *samples = reinterpret_cast<const int32_t *>(bytes);
                while (offset < frames && !cancel.load()) {
                    size_t done = ring.push(samples + offset * size_t(channels), frames - offset); offset += done;
                    if (!done) sleepMs(5);
                }
                carry = total % frameBytes; if (carry) memmove(bytes, bytes + total - carry, carry);
            }
            close(fd); fd = -1; int status = 0;
            if (cancel.load()) kill(pid, SIGTERM);
            while (waitpid(pid, &status, 0) < 0 && errno == EINTR) { }
            exitCode.store(cancel.load() ? 0 : WIFEXITED(status) ? WEXITSTATUS(status) : 128);
            eof.store(true, std::memory_order_release);
        });
    }
    ~Deck() { cancel.store(true); if (pid > 0 && !eof.load()) kill(pid, SIGTERM); if (worker.joinable()) worker.join(); }
    double now() const { return position + double(consumed.load(std::memory_order_relaxed)) / rate; }
    bool atEnd() const { return eof.load(std::memory_order_acquire) && !ring.size(); }
    // Waits for ~0.3 s of decoded audio (less at the end of a file). False when nothing is left to play.
    bool warm(double seconds = 0.3) {
        Phase ph("decoder warm-up"); auto t0 = Clock::now();
        const size_t want = size_t(rate * seconds);
        for (int i = 0; i < 800 && !quitting && ring.size() < want && !eof.load(); ++i) sleepMs(10);   // 8 s: slow disks, network shares
        if (since(t0) > 1) trace("decoder warm-up took %.1f s (%zu frames)", since(t0), ring.size());
        if (ring.size()) return true;
        if (!eof.load()) throw std::runtime_error("FFmpeg 解碼逾時；請確認檔案所在的磁碟可以讀取");
        if (exitCode.load() != 0) throw std::runtime_error("FFmpeg 無法解碼這首歌的 PCM 資料");
        return false;
    }
};

struct Biquad {
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, zl1 = 0, zl2 = 0, zr1 = 0, zr2 = 0;
    void run(double &l, double &r) {
        double yl = b0*l + zl1; zl1 = b1*l - a1*yl + zl2; zl2 = b2*l - a2*yl;
        double yr = b0*r + zr1; zr1 = b1*r - a1*yr + zr2; zr2 = b2*r - a2*yr; l = yl; r = yr;
    }
    double magnitude(double f, double rate) const {
        double w = 2*M_PI*f/rate, nr = b0+b1*cos(w)+b2*cos(2*w), ni = -(b1*sin(w)+b2*sin(2*w));
        double dr = 1+a1*cos(w)+a2*cos(2*w), di = -(a1*sin(w)+a2*sin(2*w)); return sqrt((nr*nr+ni*ni)/(dr*dr+di*di));
    }
};
static NSString *bandType(NSDictionary *b) { return [text(b[@"type"]) uppercaseString] ?: @"PK"; }
static Biquad biquad(NSDictionary *b, double rate) {
    double f = std::clamp(num(b[@"fc"], 1000), 5.0, rate*0.49), q = num(b[@"q"]);
    q = std::clamp(q <= 0 ? 0.707 : q, 0.05, 40.0);
    double A = pow(10, num(b[@"gain"])/40), w = 2*M_PI*f/rate, c = cos(w), s = sin(w), alpha = s/(2*q), sq = 2*sqrt(A)*alpha;
    double b0, b1, b2, a0, a1, a2; NSString *type = bandType(b);
    if ([type isEqualToString:@"LS"] || [type isEqualToString:@"LSC"]) {
        b0=A*((A+1)-(A-1)*c+sq); b1=2*A*((A-1)-(A+1)*c); b2=A*((A+1)-(A-1)*c-sq);
        a0=(A+1)+(A-1)*c+sq; a1=-2*((A-1)+(A+1)*c); a2=(A+1)+(A-1)*c-sq;
    } else if ([type isEqualToString:@"HS"] || [type isEqualToString:@"HSC"]) {
        b0=A*((A+1)+(A-1)*c+sq); b1=-2*A*((A-1)+(A+1)*c); b2=A*((A+1)+(A-1)*c-sq);
        a0=(A+1)-(A-1)*c+sq; a1=2*((A-1)-(A+1)*c); a2=(A+1)-(A-1)*c-sq;
    } else if ([type isEqualToString:@"LP"] || [type isEqualToString:@"LPQ"]) {
        b0=(1-c)/2; b1=1-c; b2=(1-c)/2; a0=1+alpha; a1=-2*c; a2=1-alpha;
    } else if ([type isEqualToString:@"HP"] || [type isEqualToString:@"HPQ"]) {
        b0=(1+c)/2; b1=-(1+c); b2=(1+c)/2; a0=1+alpha; a1=-2*c; a2=1-alpha;
    } else { b0=1+alpha*A; b1=-2*c; b2=1-alpha*A; a0=1+alpha/A; a1=-2*c; a2=1-alpha/A; }
    Biquad out; out.b0=b0/a0; out.b1=b1/a0; out.b2=b2/a0; out.a1=a1/a0; out.a2=a2/a0; return out;
}
struct Graph {
    std::vector<Biquad> filters; double pre = 1, limit = 1, gl = 1, gr = 1; bool invert = false, active = false, cf = false;
    double b1lo=0, a0lo=0, b1hi=0, a0hi=0, a1hi=0, cfgain=1, loL=0, loR=0, hiL=0, hiR=0, inL=0, inR=0;
    Graph(NSDictionary *cfg = nil, double rate = 48000) {
        if (!flag(cfg[@"enabled"]) || !(rate > 0)) return;
        bool eq = flag(cfg[@"eqOn"]);
        double preDb = eq ? num(cfg[@"preampDb"]) : 0;
        if (eq) for (id item in listOf(cfg[@"bands"])) {
            NSDictionary *b = dictOf(item); if (!b) continue;
            NSString *type = bandType(b);
            bool cut = [@[@"LP", @"LPQ", @"HP", @"HPQ"] containsObject:type];
            if (flag(b[@"on"]) && (cut || std::abs(num(b[@"gain"])) >= 1e-6)) filters.push_back(biquad(b, rate));
        }
        if (eq && flag(cfg[@"autoPreamp"])) {
            preDb = 0; double boost = 0;
            for (int i = 0; i <= 240; ++i) { double f = 20*pow(1000, i/240.0); if (f >= rate*0.49) break;
                double m = 1; for (const auto &b : filters) m *= b.magnitude(f, rate); boost = std::max(boost, 20*log10(m)); }
            if (boost > 0) limit = pow(10, -(boost+0.1)/20);
        }
        pre = pow(10, preDb/20); double bal = std::clamp(num(cfg[@"balance"]), -1.0, 1.0);
        gl = bal > 0 ? 1-bal : 1; gr = bal < 0 ? 1+bal : 1; invert = flag(cfg[@"invert"]);
        NSDictionary *cross = dictOf(cfg[@"crossfeed"]); cf = flag(cross[@"on"]);
        if (cf) {
            double fc = num(cross[@"fc"], 700), feed = num(cross[@"feed"], 4.5), gbLo = feed*-5/6-3, gbHi = feed/6-3;
            double gLo = pow(10, gbLo/20), gHi = 1-pow(10, gbHi/20), fcHi = fc*pow(2, (gbLo-20*log10(gHi))/12);
            b1lo = exp(-2*M_PI*fc/rate); a0lo = gLo*(1-b1lo); b1hi = exp(-2*M_PI*fcHi/rate);
            a0hi = 1-gHi*(1-b1hi); a1hi = -b1hi; cfgain = 1/(1-gHi+gLo);
        }
        active = !filters.empty() || cf || preDb != 0 || bal != 0 || invert;
    }
    void run(double &l, double &r) {
        l *= pre; r *= pre; for (auto &b : filters) b.run(l, r);
        if (cf) { loL=a0lo*l+b1lo*loL; loR=a0lo*r+b1lo*loR; hiL=a0hi*l+a1hi*inL+b1hi*hiL; hiR=a0hi*r+a1hi*inR+b1hi*hiR;
            inL=l; inR=r; l=(hiL+loR)*cfgain; r=(hiR+loL)*cfgain; }
        l *= gl; r *= gr; if (invert) { l=-l; r=-r; }
    }
};

// Where one output channel lives in the IOProc's buffer list.
struct Slot { UInt32 buffer = 0, offset = 0, stride = 0, stream = 0; int bytes = 4; AudioStreamBasicDescription format{}; };
// What MIKU changed on a device, so it can be put back when the device is released.
struct Restore {
    AudioDeviceID device = 0; bool exclusive = false, ownsHog = false, rateTouched = false;
    double originalRate = 0, appliedRate = 0;
    std::vector<std::pair<AudioStreamID, AudioStreamBasicDescription>> physical;   // original physical formats of streams MIKU changed
    // The device's IOProc, kept (playing silence if it runs) until the device is put back: see putBack.
    AudioDeviceIOProcID proc = nullptr; bool running = false;
};
static int64_t nowNs() { return std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now().time_since_epoch()).count(); }

static const char *literal(NSString *cmd);

class Engine {
    // ── what the app asked for ──
    std::string wantUID = "default"; bool follows = true, wantExclusive = false, wantAutoRate = true;
    // ── the open output; layout fields change only while device IO is stopped ──
    AudioDeviceID device = 0; AudioDeviceIOProcID proc = nullptr;
    std::string deviceUID; NSString *deviceName = @""; UInt32 transport = 0;
    std::vector<AudioStreamID> streams; std::vector<AudioStreamBasicDescription> virt, phys, openPhys;
    std::vector<UInt32> bufferChannels; Slot left, right; bool mono = false; int maxPhysBits = 0;
    bool openedExclusive = false, openedFollowing = false, exclusive = false, ownsHog = false, running = false, fellBack = false;
    double rate = 0, askedRate = 0;   // the device rate the decks decode for; the last rate MIKU asked the device for
    Restore state; std::string modeNote, rateNote;
    AudioDeviceID listenedDevice = 0; std::vector<AudioStreamID> listenedStreams; bool systemWatching = false;
    Clock::time_point hogChangedAt{}, defaultDue{}, endedAt{};
    bool defaultPending = false;
    // While MIKU hogs the device it took as the system output, macOS moves the system output elsewhere (nothing else
    // can play on a hogged device). inducedFrom → inducedTo records that move, so "the system output" keeps meaning
    // the device MIKU took, in the device list too.
    std::string inducedFrom, inducedTo;
    AudioDeviceID defaultAtHog = 0;   // the system output when MIKU last took hog mode
    id activity = nil;
    // ── decks: owned here, reached by the IO thread only through current / queued ──
    std::vector<std::unique_ptr<Deck>> decks; std::atomic<Deck *> current{nullptr}, queued{nullptr}; Deck *announced = nullptr;
    bool ended = false;
    // Pause keeps the device running and silent (instant resume, no relock); after 30 s it is really stopped.
    std::atomic<bool> softPaused{false}; Clock::time_point softPausedAt{};
    // When each device last changed rate (MIKU's own changes and restores): a start during the relock waits it out.
    std::map<AudioDeviceID, Clock::time_point> rateChangedAt;
    std::atomic<uint64_t> renderStarts{0}, renderEnds{0};
    // The device MIKU plays to; callbacks from any other device (one being put back) play silence.
    std::atomic<AudioDeviceID> ioDevice{0};
    std::atomic<uint64_t> ioCalls{0}; uint64_t ioCallsSeen = 0; int ticksWithoutIO = 0;
    // IO callbacks of devices being put back (they keep running until their rate is restored)
    struct Leaving { std::atomic<AudioDeviceID> device{0}; std::atomic<uint64_t> calls{0}; std::atomic<int64_t> lastNs{0}; };
    Leaving leaving[4];
    std::vector<Restore> later;   // devices to put back once the current command has answered
    bool quickPutBack = false;
    std::atomic<bool> ioReady{false}, drained{false}, shapeChanged{false}, deviceDirty{false}, defaultMoved{false}, listChanged{false};
    std::atomic<uint64_t> underruns{0}, clips{0}; std::atomic<double> peakL{0}, peakR{0};
    // ── processing: the graph is swapped atomically; gain and ramp belong to the IO thread while IO runs ──
    NSDictionary *dspCfg = nil; std::unique_ptr<Graph> graphOwned; std::atomic<Graph *> graph{nullptr};
    double gain = 1, ramp = 0;
    std::atomic<double> target{1}; std::atomic<bool> instantGain{false}, gainUnity{true};

    // HAL notifications only set flags; tick() on the command thread looks at them.
    static OSStatus onDevice(AudioObjectID, UInt32, const AudioObjectPropertyAddress *, void *ctx) {
        static_cast<Engine *>(ctx)->deviceDirty.store(true); return noErr;
    }
    static OSStatus onSystem(AudioObjectID, UInt32 count, const AudioObjectPropertyAddress *a, void *ctx) {
        auto *e = static_cast<Engine *>(ctx);
        for (UInt32 i = 0; i < count; ++i) {
            if (a[i].mSelector == kAudioHardwarePropertyDefaultOutputDevice) e->defaultMoved.store(true);
            else if (a[i].mSelector == kAudioHardwarePropertyDevices) e->listChanged.store(true);
        }
        return noErr;
    }
    void listen(bool on) {
        const AudioObjectPropertySelector deviceProps[] = {kAudioDevicePropertyNominalSampleRate, kAudioDevicePropertyDeviceIsAlive, kAudioDevicePropertyHogMode};
        const AudioObjectPropertySelector streamProps[] = {kAudioStreamPropertyVirtualFormat, kAudioStreamPropertyPhysicalFormat};
        auto streamList = addr(kAudioDevicePropertyStreams, kAudioDevicePropertyScopeOutput);
        if (listenedDevice) {
            for (auto p : deviceProps) { auto a = addr(p); AudioObjectRemovePropertyListener(listenedDevice, &a, onDevice, this); }
            AudioObjectRemovePropertyListener(listenedDevice, &streamList, onDevice, this);
            for (auto s : listenedStreams) for (auto p : streamProps) { auto a = addr(p); AudioObjectRemovePropertyListener(s, &a, onDevice, this); }
            listenedDevice = 0; listenedStreams.clear();
        }
        if (!on || !device) return;
        listenedDevice = device; listenedStreams = streams;
        for (auto p : deviceProps) { auto a = addr(p); AudioObjectAddPropertyListener(device, &a, onDevice, this); }
        AudioObjectAddPropertyListener(device, &streamList, onDevice, this);
        for (auto s : streams) for (auto p : streamProps) { auto a = addr(p); AudioObjectAddPropertyListener(s, &a, onDevice, this); }
    }
    void watchSystem(bool on) {
        if (on == systemWatching) return;
        for (auto p : {kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDevices}) {
            auto a = addr(p);
            if (on) AudioObjectAddPropertyListener(kAudioObjectSystemObject, &a, onSystem, this);
            else AudioObjectRemovePropertyListener(kAudioObjectSystemObject, &a, onSystem, this);
        }
        systemWatching = on;
    }

    // ───────────── the IO thread ─────────────
    static OSStatus callback(AudioDeviceID d, const AudioTimeStamp *, const AudioBufferList *, const AudioTimeStamp *, AudioBufferList *out,
                             const AudioTimeStamp *, void *ctx) {
        auto *engine = static_cast<Engine *>(ctx);
        RenderScope scope(engine->renderStarts, engine->renderEnds);
        if (d != engine->ioDevice.load(std::memory_order_acquire)) return engine->silence(d, out);
        engine->ioCalls.fetch_add(1, std::memory_order_relaxed);
        return engine->render(out);
    }
    OSStatus silence(AudioDeviceID d, AudioBufferList *out) {
        for (UInt32 b = 0; b < out->mNumberBuffers; ++b) if (out->mBuffers[b].mData) memset(out->mBuffers[b].mData, 0, out->mBuffers[b].mDataByteSize);
        for (auto &l : leaving) if (l.device.load(std::memory_order_relaxed) == d) { l.calls.fetch_add(1, std::memory_order_relaxed); l.lastNs.store(nowNs(), std::memory_order_relaxed); break; }
        return noErr;
    }
    struct RenderScope {
        std::atomic<uint64_t> &ends;
        RenderScope(std::atomic<uint64_t> &starts, std::atomic<uint64_t> &e) : ends(e) { starts.fetch_add(1); }
        ~RenderScope() { ends.fetch_add(1); }
    };
    static size_t framesIn(const AudioBufferList *out, const Slot &s) {
        const auto &buf = out->mBuffers[s.buffer];
        if (!buf.mData || !buf.mNumberChannels) return 0;
        return buf.mDataByteSize / (UInt32(s.bytes) * buf.mNumberChannels);
    }
    OSStatus render(AudioBufferList *out) {
        for (UInt32 b = 0; b < out->mNumberBuffers; ++b) if (out->mBuffers[b].mData) memset(out->mBuffers[b].mData, 0, out->mBuffers[b].mDataByteSize);
        if (!ioReady.load(std::memory_order_acquire) || softPaused.load(std::memory_order_relaxed)) return noErr;
        // The buffer list must be the one the layout was read for; otherwise stay silent until tick() reads it again.
        if (out->mNumberBuffers != bufferChannels.size()) { shapeChanged.store(true); return noErr; }
        for (UInt32 b = 0; b < out->mNumberBuffers; ++b)
            if (out->mBuffers[b].mData && out->mBuffers[b].mNumberChannels != bufferChannels[b]) { shapeChanged.store(true); return noErr; }
        const size_t frames = std::min(framesIn(out, left), framesIn(out, right));
        Deck *d = current.load(std::memory_order_acquire);
        if (!frames || !d) return noErr;
        Graph *g = graph.load(std::memory_order_acquire);
        uint8_t *ld = static_cast<uint8_t *>(out->mBuffers[left.buffer].mData) + left.offset;
        uint8_t *rd = static_cast<uint8_t *>(out->mBuffers[right.buffer].mData) + right.offset;
        if (instantGain.exchange(false)) gain = std::min(target.load(), g->limit);
        const double goal = std::min(target.load(), g->limit);
        double pl = 0, pr = 0; bool missed = false;
        int32_t chunk[512];
        auto write = [&](size_t at, size_t n, double rg) {
            const bool exact = !g->active && rg == 1 && gain == 1 && goal == 1;
            for (size_t i = 0; i < n; ++i) {
                int32_t l = chunk[2 * i], r = chunk[2 * i + 1];
                if (!exact) {
                    if (gain != goal) { gain += (goal - gain) * ramp; if (std::abs(gain - goal) < 1e-7) gain = goal; }
                    double dl = double(l) / 2147483648.0 * rg, dr = double(r) / 2147483648.0 * rg;
                    g->run(dl, dr); dl *= gain; dr *= gain;
                    if (!std::isfinite(dl)) dl = 0;
                    if (!std::isfinite(dr)) dr = 0;
                    if (dl >= 1 || dl < -1) clips.fetch_add(1, std::memory_order_relaxed);
                    if (dr >= 1 || dr < -1) clips.fetch_add(1, std::memory_order_relaxed);
                    l = int32_t(std::clamp(dl * 2147483648.0, -2147483648.0, 2147483647.0));
                    r = int32_t(std::clamp(dr * 2147483648.0, -2147483648.0, 2147483647.0));
                }
                pl = std::max(pl, std::abs(double(l)) / 2147483648.0); pr = std::max(pr, std::abs(double(r)) / 2147483648.0);
                const size_t frame = at + i;
                if (mono) pack(ld + frame * left.stride, int32_t((int64_t(l) + int64_t(r)) / 2), left.format, left.bytes);
                else { pack(ld + frame * left.stride, l, left.format, left.bytes); pack(rd + frame * right.stride, r, right.format, right.bytes); }
            }
        };
        size_t done = 0;
        while (done < frames) {
            const size_t want = std::min<size_t>(256, frames - done);
            const size_t got = d->ring.pop(chunk, want);
            if (got) { d->consumed.fetch_add(got, std::memory_order_relaxed); write(done, got, d->rg); done += got; }
            if (got == want) continue;
            if (!d->eof.load(std::memory_order_acquire)) { missed = true; break; }   // decoder behind: the rest stays silent
            if (d->ring.size()) continue;
            // Gapless: the preloaded deck takes over within this same buffer.
            Deck *n = queued.load(std::memory_order_acquire); bool took = false;
            while (n && n->ring.size()) if ((took = queued.compare_exchange_weak(n, nullptr))) break;   // a failed exchange reloads n
            if (took) { current.store(n, std::memory_order_release); d = n; continue; }
            drained.store(true); break;
        }
        gainUnity.store(gain == 1 && goal == 1);
        if (missed) underruns.fetch_add(1, std::memory_order_relaxed);
        if (pl > peakL.load(std::memory_order_relaxed)) peakL.store(pl);
        if (pr > peakR.load(std::memory_order_relaxed)) peakR.store(pr);
        return noErr;
    }
    // Returns once every IO callback that started before now has finished: whatever it read can be freed.
    void quiesce() {
        Phase ph("waiting for the IO callback");
        const uint64_t started = renderStarts.load(); auto t0 = Clock::now();
        while (renderEnds.load() < started && since(t0) < 1) std::this_thread::sleep_for(std::chrono::microseconds(50));
        if (renderEnds.load() < started) trace("IO callback still running after 1 s (started %llu, ended %llu)", (unsigned long long)started, (unsigned long long)renderEnds.load());
    }
    bool playingNow() const { return running && !softPaused.load() && !ended; }
    // Stops the device (configuration, closing, a long pause).
    void pauseIO() {
        if (running && proc && device) { Phase ph("AudioDeviceStop"); OSStatus e = AudioDeviceStop(device, proc); if (e) trace("AudioDeviceStop: %d", int(e)); }
        running = false; softPaused.store(false); quiesce();
        if (activity) { [[NSProcessInfo processInfo] endActivity:activity]; activity = nil; }
    }
    // Pause: the device keeps running and plays silence, so Play continues at once without a DAC relock.
    void pausePlayback() {
        if (running && !softPaused.load()) { softPaused.store(true); softPausedAt = Clock::now(); }
    }
    void resumeIO() {
        if (!proc || !device || !current.load()) return;
        if (running) { softPaused.store(false); return; }
        startIO();
    }
    void noteRateChange(AudioDeviceID d) { if (d) rateChangedAt[d] = Clock::now(); }
    // A start in the middle of a DAC relocking after a rate change stalls for seconds and fails on some systems (and
    // later starts then stall too), so a start that soon after a rate change waits until the relock is over.
    void waitForRelock() {
        auto it = rateChangedAt.find(device);
        if (it == rateChangedAt.end()) return;
        double left = 1.5 - since(it->second);
        if (left <= 0) return;
        Phase ph("waiting for the DAC to relock"); trace("start %.0f ms after a rate change: waiting %.0f ms for the relock", (1.5 - left) * 1000, left * 1000);
        std::this_thread::sleep_for(std::chrono::duration<double>(left));
    }
    // Starts the device; it plays silence until the IO is armed and a deck is current.
    void startIO() {
        if (running || !proc || !device) return;
        waitForRelock();
        if (!activity) activity = [[NSProcessInfo processInfo] beginActivityWithOptions:(NSActivityUserInitiatedAllowingIdleSystemSleep | NSActivityLatencyCritical)
                                                                                 reason:@"MIKU audio playback"];
        auto start = [&] {
            Phase ph("AudioDeviceStart"); auto t0 = Clock::now();
            OSStatus e = AudioDeviceStart(device, proc);
            if (e || since(t0) > 0.3) trace("AudioDeviceStart → %d after %.0f ms%s", int(e), since(t0) * 1000, ownsHog ? " (hog mode held)" : "");
            return e;
        };
        auto began = Clock::now();
        OSStatus e = start();
        // A start that hangs for seconds leaves this process unable to run IO at all (the retry reports success, but
        // no callback ever comes). A new helper process starts cleanly, so MIKU restarts it and continues there.
        if (e && since(began) > 2) restartHelper("the output start hung");
        if (e && ownsHog) {
            // A start in hog mode can be refused while macOS is still moving other apps' sound around. Start without
            // hog mode (never blocked by that) and take it again once the device runs.
            trace("retrying the start without hog mode");
            releaseHog(); e = start();
        }
        if (e) { sleepMs(150); e = start(); }
        check(e, "無法啟動輸出裝置");
        running = true; softPaused.store(false); ioCallsSeen = ioCalls.load(); ticksWithoutIO = 0;
        if (exclusive && !ownsHog) takeHog();
    }
    void armIO() { ioReady.store(true, std::memory_order_release); }
    // Puts the devices back (without waiting for relocks), tells the app, and exits: the app starts a new helper and
    // continues at the same place.
    [[noreturn]] void restartHelper(const char *why) {
        trace("%s: restarting the audio helper", why);
        emit(@{@"e":@"restarting", @"reason":ns(why)});
        quickPutBack = true;
        try { stop(); flushLater(); } catch (...) { }
        fflush(stdout); fflush(stderr); _exit(75);
    }
    // Exclusive mode takes hog mode only once the device is running: starting a device that MIKU has just hogged can
    // stall for seconds (and fail) while macOS moves the other apps' sound off it, especially right after MIKU let go
    // of the same device. Taking hog mode on a running device has no such wait, and the IO keeps running.
    void takeHog() {
        if (!device || ownsHog || !hogSettable(device)) return;
        Phase ph("taking hog mode"); auto t0 = Clock::now();
        pid_t owner = hogOwner(device), me = getpid();
        if (owner > 0 && owner != me) { modeNote = "裝置正被 " + processName(owner) + " 獨佔，目前以共享模式播放"; return; }
        try {
            if (owner != me) { defaultAtHog = defaultOutput(); set(device, kAudioDevicePropertyHogMode, me); hogChangedAt = Clock::now(); }
            while (!(ownsHog = hogOwner(device) == me) && since(t0) < 1) sleepMs(5);
        } catch (const std::exception &e) { trace("take hog mode: %s", e.what()); }
        state.ownsHog = ownsHog; if (ownsHog) state.exclusive = true;
        if (!ownsHog) modeNote = "無法取得 DAC 獨佔，目前以共享模式播放";
        else if (modeNote.rfind("無法取得", 0) == 0 || modeNote.rfind("裝置正被", 0) == 0) modeNote.clear();
        trace("hog mode %s after %.0f ms", ownsHog ? "taken" : "NOT taken", since(t0) * 1000);
    }
    void releaseHog() {
        if (!device || !ownsHog) return;
        Phase ph("releasing hog mode");
        try { if (hogOwner(device) == getpid()) { pid_t none = -1; set(device, kAudioDevicePropertyHogMode, none); } } catch (...) { }
        ownsHog = false; state.ownsHog = false; hogChangedAt = Clock::now();
    }

    // ───────────── decks ─────────────
    // Frees every deck the IO thread can no longer reach.
    void collect() {
        Phase ph("freeing decoders");
        quiesce();
        Deck *c = current.load(), *q = queued.load();
        if (announced && announced != c && announced != q) announced = nullptr;
        decks.erase(std::remove_if(decks.begin(), decks.end(), [&](const std::unique_ptr<Deck> &p) { return p.get() != c && p.get() != q; }), decks.end());
    }
    Deck *adopt(std::unique_ptr<Deck> d) { Deck *p = d.get(); decks.push_back(std::move(d)); return p; }
    void dropDecks() { current.store(nullptr); queued.store(nullptr); collect(); ended = false; drained.store(false); }
    void setGraph() {
        auto g = std::make_unique<Graph>(dspCfg, rate > 0 ? rate : 48000);
        graph.store(g.get()); quiesce(); graphOwned = std::move(g);
    }
    // The output rate changed: the current deck is reopened at its place at the new rate. The preloaded one is dropped
    // (the app preloads again). Called with the IO silent (not armed) or stopped.
    void rebuildDecks() {
        queued.store(nullptr);
        Deck *d = current.load();
        if (d && !sameRate(d->rate, rate) && !d->atEnd()) {
            auto fresh = std::make_unique<Deck>(d->params, rate, d->now());
            fresh->warm();
            Deck *p = adopt(std::move(fresh));
            if (announced == d) announced = p;   // the same track: no "started"
            current.store(p);
        }
        collect();
        setGraph(); ramp = 1 - exp(-1 / (0.025 * rate)); gain = std::min(target.load(), graph.load()->limit);
    }

    // ───────────── the output ─────────────
    // The device for the wanted output. A selected device that is missing falls back to the system output (labelled,
    // and moved back to when it returns). While MIKU follows the system output the open device is kept: the system
    // output may have moved only because MIKU hogged it.
    AudioDeviceID chooseDevice(bool &fb) {
        fb = false;
        if (!follows) {
            if (AudioDeviceID d = deviceWithUID(wantUID)) return d;
            fb = true;
        } else if (device && openedFollowing && alive(device)) return device;
        AudioDeviceID def = logicalDefault();
        if (!def || !alive(def) || outputStreams(def).empty()) throw std::runtime_error("找不到可用的輸出裝置；請連接 DAC 或在系統設定選擇輸出裝置");
        return def;
    }
    // The system output as the user chose it: macOS's current one, unless macOS only moved it because MIKU hogged the
    // device it was following.
    AudioDeviceID logicalDefault() {
        AudioDeviceID def = defaultOutput();
        if (!inducedFrom.empty() && uidOf(def) == inducedTo) if (AudioDeviceID d = deviceWithUID(inducedFrom)) return d;
        return def;
    }
    void openOutput(AudioDeviceID target, bool fb) {
        if (!alive(target)) throw std::runtime_error("輸出裝置已離線");
        auto list = outputStreams(target);
        if (list.empty()) throw std::runtime_error("這個裝置沒有輸出串流");
        pid_t owner = hogOwner(target);
        // Another app's hog mode shuts out every other client, shared ones included: nothing would be heard.
        if (owner > 0 && owner != getpid()) throw std::runtime_error("輸出裝置正被 " + processName(owner) + " 獨佔；請先停止該程式的播放");
        device = target; streams = list; deviceUID = uidOf(target); deviceName = nameOf(target, kAudioObjectPropertyName); transport = transportOf(target);
        trace("open \"%s\" (%s) exclusive=%d fallback=%d streams=%zu rate=%.0f", deviceName.UTF8String ?: "?", deviceUID.c_str(), int(wantExclusive), int(fb), list.size(), nominalRate(target));
        openedExclusive = wantExclusive; openedFollowing = follows && !fb; fellBack = fb;
        exclusive = ownsHog = false; modeNote.clear(); rateNote.clear(); rate = 0;
        state = Restore{}; state.device = target;
        const auto opened = Clock::now();
        try {
            state.originalRate = nominalRate(target);
            openPhys.clear(); for (auto s : streams) openPhys.push_back(physicalFormat(s));
            if (wantExclusive) {
                if (!hogSettable(target)) modeNote = "這個裝置不提供 Core Audio 獨佔，已改用共享模式";
                else {
                    // Hog mode is taken once the device runs (takeHog in resumeIO); a device MIKU already holds stays held.
                    exclusive = true; ownsHog = owner == getpid();
                }
            }
            state.exclusive = exclusive; state.ownsHog = ownsHog;
            trace("  hog %s after %.0f ms", ownsHog ? "held" : exclusive ? "taken once the device runs" : "not used", since(opened) * 1000);
            { Phase ph("AudioDeviceCreateIOProcID"); check(AudioDeviceCreateIOProcID(target, callback, this, &proc), "無法建立原生輸出"); }
            ioDevice.store(target, std::memory_order_release);
            { Phase ph("adding listeners"); listen(true); }
            trace("  output ready after %.0f ms", since(opened) * 1000);
        } catch (const std::exception &e) { trace("open failed: %s", e.what()); putBack(detach()); throw; }
    }
    // Disconnects the open device; returns what has to be put back on it. A device whose rate or format MIKU changed
    // keeps its IOProc (still running, silent) for putBack.
    Restore detach(bool restoring = true) {
        Phase ph("closing the output");
        if (device) trace("close \"%s\"", deviceName.UTF8String ?: "?");
        ioReady.store(false);
        const bool keep = restoring && proc && device && (state.rateTouched || !state.physical.empty()) && alive(device);
        Leaving *slot = nullptr;
        if (keep) for (auto &l : leaving) if (!l.device.load()) { slot = &l; break; }
        Restore r = state; r.ownsHog = ownsHog;
        if (keep && slot) {
            slot->calls.store(0); slot->lastNs.store(0); slot->device.store(device);
            r.proc = proc; r.running = running;
            running = false; softPaused.store(false);
            if (activity) { [[NSProcessInfo processInfo] endActivity:activity]; activity = nil; }
        } else pauseIO();
        ioDevice.store(0, std::memory_order_release); quiesce();   // from here on its callbacks play silence
        listen(false);
        if (proc && device && !r.proc) { Phase ph2("AudioDeviceDestroyIOProcID"); AudioDeviceDestroyIOProcID(device, proc); }
        proc = nullptr;
        state = Restore{}; device = 0; streams.clear(); virt.clear(); phys.clear(); openPhys.clear(); bufferChannels.clear();
        exclusive = ownsHog = false; fellBack = false; openedFollowing = false; rate = 0; maxPhysBits = 0; transport = 0;
        modeNote.clear(); rateNote.clear(); deviceUID.clear(); deviceName = @"";
        shapeChanged.store(false); deviceDirty.store(false);
        return r;
    }
    // Puts back what MIKU changed (rate, DAC format) and releases hog mode; never touches a device another app owns.
    // `hogOnly`: the same device is opened again in the other mode, so only hog mode is released (the rate and format
    // are put back when it closes).
    // A device MIKU holds in hog mode is changed only while it runs: a rate change on a stopped device in hog mode,
    // followed by releasing hog mode, leaves this process unable to start IO on it (AudioDeviceStart hangs ~7 s, and
    // after the retry no callback ever comes). So the rate goes back while the device still runs, MIKU waits until the
    // IO runs again at that rate, and only then stops it and lets go of hog mode.
    void putBack(Restore r, bool hogOnly = false) {
        Leaving *slot = nullptr;
        for (auto &l : leaving) if (r.proc && l.device.load() == r.device) { slot = &l; break; }
        auto stopIO = [&] {
            if (r.proc) {
                Phase ph("stopping the previous device");
                if (r.running) AudioDeviceStop(r.device, r.proc);
                AudioDeviceDestroyIOProcID(r.device, r.proc);
            }
            r.proc = nullptr; r.running = false;
            if (slot) { slot->device.store(0); slot = nullptr; }
        };
        if (!r.device || !alive(r.device)) { stopIO(); return; }
        Phase ph("putting the previous device back");
        bool hogged = false;
        try {
            pid_t owner = hogOwner(r.device);
            hogged = r.ownsHog && owner == getpid();
            // With hog mode MIKU's changes are its own; without it, only when nobody else has changed the device since.
            bool mine = r.ownsHog ? hogged : (owner == -1 || owner == getpid());
            const double now = nominalRate(r.device);
            const bool rateBack = !hogOnly && mine && r.rateTouched && r.originalRate > 0 && !sameRate(now, r.originalRate) &&
                (r.ownsHog || sameRate(now, r.appliedRate));
            bool formatsBack = false;
            if (!hogOnly && mine) for (const auto &item : r.physical) try { formatsBack = formatsBack || !sameFormat(physicalFormat(item.first), item.second); } catch (...) { }
            trace("put back device %u: rate %s, %zu format(s), hog %d, %s", (unsigned)r.device, rateBack ? "yes" : "no", formatsBack ? r.physical.size() : 0,
                  int(r.ownsHog), r.running ? "running" : "stopped");
            if ((rateBack || formatsBack) && hogged && !r.running) {
                if (quickPutBack) {
                    // the helper is about to exit (it can't run IO any more): let go of hog mode first, then change it
                    pid_t none = -1; set(r.device, kAudioDevicePropertyHogMode, none); hogChangedAt = Clock::now(); hogged = false;
                } else if (r.proc) {
                    Phase ph2("starting the previous device to put it back");
                    OSStatus e = AudioDeviceStart(r.device, r.proc);
                    if (!e) r.running = true; else trace("put back: start → %d", int(e));
                }
            }
            if ((rateBack || formatsBack) && hogged && !r.running) {
                // Not running in hog mode: changing it now would break later starts. Leave the device as it is.
                trace("put back skipped: the device could not run");
            } else {
                const uint64_t calls0 = slot ? slot->calls.load() : 0;
                const auto t0 = Clock::now();
                if (rateBack) {
                    try {
                        set(r.device, kAudioDevicePropertyNominalSampleRate, r.originalRate);
                        while (since(t0) < 1 && !sameRate(nominalRate(r.device), r.originalRate)) sleepMs(10);
                        if (!r.running) noteRateChange(r.device);
                    } catch (const std::exception &e) { emit(@{@"e":@"restoreWarning", @"msg":ns(e.what())}); }
                }
                if (formatsBack) for (const auto &item : r.physical) {
                    try {
                        if (sameFormat(physicalFormat(item.first), item.second)) continue;
                        auto t1 = Clock::now();
                        set(item.first, kAudioStreamPropertyPhysicalFormat, item.second);
                        while (since(t1) < 1 && !sameFormat(physicalFormat(item.first), item.second)) sleepMs(10);
                        if (!r.running) noteRateChange(r.device);
                    } catch (const std::exception &e) { emit(@{@"e":@"restoreWarning", @"msg":ns(e.what())}); }
                }
                if ((rateBack || formatsBack) && r.running && slot && !quickPutBack) waitRelocked(*slot, calls0, t0);
            }
        } catch (const std::exception &e) { trace("put back: %s", e.what()); } catch (...) { }
        stopIO();
        // Hog mode is a toggle: setting it while MIKU owns it releases it.
        try {
            if (hogged && hogOwner(r.device) == getpid()) { Phase ph2("releasing hog mode"); pid_t none = -1; set(r.device, kAudioDevicePropertyHogMode, none); hogChangedAt = Clock::now(); }
        } catch (const std::exception &e) { trace("put back: %s", e.what()); } catch (...) { }
    }
    // After a rate or format change on a running device: returns once its IO runs again (it pauses while the DAC
    // relocks), or after 2.5 s.
    void waitRelocked(Leaving &l, uint64_t calls0, Clock::time_point t0) {
        Phase ph("waiting for the previous device to relock");
        bool paused = false; uint64_t atPause = 0;
        while (since(t0) < 2.5) {
            const uint64_t c = l.calls.load(); const int64_t last = l.lastNs.load();
            const double idle = last ? (nowNs() - last) / 1e9 : since(t0);
            if (!paused && idle > 0.06) { paused = true; atPause = c; }
            if (paused && c >= atPause + 5 && idle < 0.03) { trace("previous device relocked after %.0f ms", since(t0) * 1000); return; }
            if (!paused && since(t0) > 0.5 && c > calls0) return;   // it changed without pausing its IO
            sleepMs(5);
        }
        trace("previous device: IO not running again after 2.5 s");
    }
    // Devices left during a command are put back after it has answered (the switch itself is not made longer).
    void putBackLater(Restore r) { if (r.device) later.push_back(std::move(r)); }
    void flushLater() {
        while (!later.empty()) { Restore r = std::move(later.front()); later.erase(later.begin()); putBack(std::move(r)); }
    }
    // Closes the open device to open the same one in the other mode, without relocking it twice: what MIKU changed on
    // it is carried over (and put back when it is really closed).
    Restore closeForReopen() { Restore r = detach(false); putBack(r, true); r.ownsHog = false; return r; }
    void carryOver(const Restore &r) {
        if (!r.device || r.device != device) return;
        state.originalRate = r.originalRate; state.rateTouched = r.rateTouched; state.appliedRate = r.appliedRate; state.physical = r.physical;
    }
    // The rate the device runs at for a source rate.
    double targetRate(double source) {
        double cur = nominalRate(device);
        // Without rate matching: the rate the device had when MIKU opened it (shared follows the device unless MIKU
        // changed it itself).
        if (!wantAutoRate || !(source > 0)) return (exclusive || state.rateTouched) && state.originalRate > 0 ? state.originalRate : cur;
        if (supportsRate(device, source)) return source;
        double r = chooseRate(source, availableRates(device));
        return r > 0 ? r : cur;
    }
    size_t streamOfChannel(UInt32 channel) {
        UInt32 at = 0;
        for (size_t s = 0; s < streams.size(); ++s) {
            UInt32 n = 0; try { n = virtualFormat(streams[s]).mChannelsPerFrame; } catch (...) { }
            if (channel < at + n) return s;
            at += n;
        }
        return 0;
    }
    void stereoPair(UInt32 &l, UInt32 &r) {
        l = 0; r = 1;
        UInt32 pref[2] = {1, 2}, n = sizeof(pref); auto a = addr(kAudioDevicePropertyPreferredChannelsForStereo, kAudioDevicePropertyScopeOutput);
        if (AudioObjectHasProperty(device, &a) && !AudioObjectGetPropertyData(device, &a, 0, nullptr, &n, pref) && pref[0] >= 1 && pref[1] >= 1) { l = pref[0] - 1; r = pref[1] - 1; }
    }
    int integerBitsAt(AudioStreamID s, UInt32 channels) {
        int best = 0;
        for (auto r : array<AudioStreamRangedDescription>(s, kAudioStreamPropertyAvailablePhysicalFormats)) {
            if (rate < r.mSampleRateRange.mMinimum - 0.5 || rate > r.mSampleRateRange.mMaximum + 0.5) continue;
            if (isInteger(r.mFormat) && r.mFormat.mChannelsPerFrame == channels && !(r.mFormat.mFormatFlags & kAudioFormatFlagIsNonMixable))
                best = std::max(best, int(r.mFormat.mBitsPerChannel));
        }
        return best;
    }
    // Exclusive: the DAC format at this rate gets the most integer bits it offers (at least the source's), so the HAL's
    // float → integer conversion is exact. A format that already holds enough bits is left alone (no relock).
    // `apply` false: only says whether it would change anything.
    bool raisePhysical(int needBits, bool apply) {
        bool changedAny = false;
        UInt32 l = 0, r = 1; stereoPair(l, r);
        std::vector<size_t> touched = {streamOfChannel(l)};
        if (streamOfChannel(r) != touched[0]) touched.push_back(streamOfChannel(r));
        for (size_t i : touched) {
            if (i >= streams.size()) continue;
            AudioStreamID s = streams[i];
            AudioStreamBasicDescription cur;
            try { cur = physicalFormat(s); } catch (...) { continue; }
            int curBits = isInteger(cur) && sameRate(cur.mSampleRate, rate) ? int(cur.mBitsPerChannel) : 0;
            if (curBits >= std::max(needBits, 24)) continue;
            AudioStreamBasicDescription best = cur; int bestBits = curBits;
            for (auto range : array<AudioStreamRangedDescription>(s, kAudioStreamPropertyAvailablePhysicalFormats)) {
                if (rate < range.mSampleRateRange.mMinimum - 0.5 || rate > range.mSampleRateRange.mMaximum + 0.5) continue;
                auto f = range.mFormat; f.mSampleRate = rate;
                if (!isInteger(f) || f.mChannelsPerFrame != cur.mChannelsPerFrame || (f.mFormatFlags & kAudioFormatFlagIsNonMixable)) continue;
                if (int(f.mBitsPerChannel) > bestBits) { best = f; bestBits = int(f.mBitsPerChannel); }
            }
            if (bestBits <= curBits) continue;
            if (!apply) return true;
            try {
                Phase ph("setting the DAC format");
                trace("DAC format %s → %s", str(formatName(cur)).c_str(), str(formatName(best)).c_str());
                bool known = false; for (const auto &item : state.physical) known = known || item.first == s;
                if (!known && i < openPhys.size()) state.physical.push_back({s, openPhys[i]});
                set(s, kAudioStreamPropertyPhysicalFormat, best); changedAny = true;
                for (int k = 0; k < 100 && !quitting && !sameFormat(physicalFormat(s), best); ++k) sleepMs(10);
            } catch (const std::exception &) { }   // the label shows the DAC format that is actually in use
        }
        return changedAny;
    }
    // Reads the IO layout. After a change, waits until the HAL reports every output stream at the device rate and the
    // formats read the same twice in a row (one setting can change another a moment later in some drivers).
    void settle(bool changed) {
        Phase ph("reading the output format");
        auto list = outputStreams(device);
        if (list.empty()) throw std::runtime_error("裝置沒有輸出串流");
        if (list != streams) { streams = list; listen(true); }
        std::vector<AudioStreamBasicDescription> v, p;
        for (int i = 0; i < 40 && !quitting; ++i) {   // at most ~1 s
            std::vector<AudioStreamBasicDescription> v2, p2;
            for (auto s : streams) { v2.push_back(virtualFormat(s)); p2.push_back(physicalFormat(s)); }
            bool stable = !changed || (i > 0 && sameFormats(v, v2) && sameFormats(p, p2));
            v = v2; p = p2;
            if (stable && std::all_of(v.begin(), v.end(), [&](const AudioStreamBasicDescription &f) { return sameRate(f.mSampleRate, rate); })) break;
            sleepMs(25);
        }
        layout(v, p);
    }
    void layout(const std::vector<AudioStreamBasicDescription> &v, const std::vector<AudioStreamBasicDescription> &p) {
        std::vector<Slot> channels; std::vector<UInt32> buffers;
        for (size_t s = 0; s < v.size(); ++s) {
            const auto &f = v[s];
            if (!packable(f)) throw std::runtime_error("裝置回報的輸出格式無法使用（" + str(formatName(f)) + "）");
            Slot slot; slot.format = f; slot.bytes = sampleBytes(f); slot.stream = UInt32(s);
            if (f.mFormatFlags & kAudioFormatFlagIsNonInterleaved) {
                for (UInt32 c = 0; c < f.mChannelsPerFrame; ++c) {
                    slot.buffer = UInt32(buffers.size()); slot.offset = 0; slot.stride = UInt32(slot.bytes);
                    channels.push_back(slot); buffers.push_back(1);
                }
            } else {
                slot.buffer = UInt32(buffers.size()); slot.stride = UInt32(slot.bytes) * f.mChannelsPerFrame;
                for (UInt32 c = 0; c < f.mChannelsPerFrame; ++c) { slot.offset = c * UInt32(slot.bytes); channels.push_back(slot); }
                buffers.push_back(f.mChannelsPerFrame);
            }
        }
        if (channels.empty()) throw std::runtime_error("裝置沒有可用的輸出聲道");
        UInt32 l = 0, r = 1; stereoPair(l, r);
        if (l >= channels.size()) l = 0;
        if (r >= channels.size()) r = channels.size() > 1 ? 1 : 0;
        virt = v; phys = p; bufferChannels = buffers; left = channels[l]; right = channels[r]; mono = l == r;
        maxPhysBits = 0;
        try { maxPhysBits = integerBitsAt(streams[left.stream], phys[left.stream].mChannelsPerFrame); } catch (...) { }
        shapeChanged.store(false); deviceDirty.store(false);
    }
    // Sets the device rate (and, exclusive, the DAC format) for a source; `rate` is what the device actually runs at.
    // The device may keep running meanwhile (silent until armIO): a rate change on a running device is relocked by the
    // HAL in place, with no start afterwards. `startFirst`: a stopped device that is about to play is started at its
    // current rate first, for the same reason.
    // A device MIKU holds in hog mode is always started first (see putBack for why it is never changed while stopped).
    void configureRate(double want, int needBits, bool startFirst = false) {
        ioReady.store(false); quiesce();
        rateNote.clear();
        bool changed = rate == 0;
        if (want > 0 && !sameRate(nominalRate(device), want)) {
            if (!running && (startFirst || ownsHog)) startIO();
            Phase ph("changing the device rate");
            bool ok = false; changed = true; askedRate = want; auto t0 = Clock::now();
            trace("rate %.0f → %.0f", nominalRate(device), want);
            try {
                set(device, kAudioDevicePropertyNominalSampleRate, want); if (!running) noteRateChange(device);
                state.rateTouched = true; state.appliedRate = want;
                for (int i = 0; i < 150 && !quitting && !(ok = sameRate(nominalRate(device), want)); ++i) sleepMs(10);
            } catch (const std::exception &) { }
            // The device keeps its own rate; FFmpeg resamples to it.
            if (!ok) rateNote = "裝置沒有接受 " + khz(want) + "，改為重新取樣";
            trace("rate change %s after %.0f ms", ok ? "done" : "NOT accepted", since(t0) * 1000);
        }
        rate = nominalRate(device);
        if (exclusive && !running && ownsHog && raisePhysical(needBits, false)) startIO();
        if (exclusive && raisePhysical(needBits, true)) { changed = true; if (!running) noteRateChange(device); }
        settle(changed);
    }
    int physicalPrecision() const {
        if (phys.empty()) return 0;
        return std::min(precision(phys[std::min<size_t>(left.stream, phys.size() - 1)]), precision(phys[std::min<size_t>(right.stream, phys.size() - 1)]));
    }
    bool exactPath() const {
        if (!device || !exclusive || !ownsHog || mono || virt.empty()) return false;
        // Bluetooth and AirPlay re-encode; the built-in speakers run Apple's speaker processing.
        if (transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE || transport == kAudioDeviceTransportTypeAirPlay) return false;
        if (transport == kAudioDeviceTransportTypeBuiltIn) {
            NSString *uid = ns(deviceUID);
            if ([uid rangeOfString:@"Speaker" options:NSCaseInsensitiveSearch].location != NSNotFound) return false;
        }
        return true;
    }
    int precisionBits() const {
        if (virt.empty()) return 0;
        return std::min({precision(left.format), precision(right.format), physicalPrecision()});
    }
    NSDictionary *hardware() {
        Deck *d = current.load(); Graph *g = graph.load(); double rg = d ? d->rg : 1;
        std::string note = modeNote.empty() ? rateNote : rateNote.empty() ? modeNote : modeNote + "；" + rateNote;
        if (exclusive && !exactPath() && (transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE)) note += note.empty() ? "藍牙裝置會重新編碼" : "；藍牙裝置會重新編碼";
        AudioStreamBasicDescription v = virt.empty() ? AudioStreamBasicDescription{} : left.format;
        AudioStreamBasicDescription p = phys.empty() ? AudioStreamBasicDescription{} : phys[std::min<size_t>(left.stream, phys.size() - 1)];
        return @{ @"open": @(device != 0), @"rate": @(rate), @"outputFormat": device ? formatName(v) : @"", @"outputBits": @(v.mBitsPerChannel),
            @"physicalFormat": device ? formatName(p) : @"", @"physicalBits": @(p.mBitsPerChannel), @"precisionBits": @(precisionBits()),
            @"exclusive": @(exclusive && (ownsHog || !running)), @"hogHeld": @(ownsHog), @"requestedExclusive": @(wantExclusive), @"shareMode": exclusive ? @"exclusive" : @"shared",
            @"exactPath": @(exactPath()), @"directPCM": @(exactPath()), @"mono": @(mono), @"transport": transportName(transport),
            @"deviceName": deviceName ?: @"", @"deviceUID": ns(deviceUID), @"fallbackDevice": @(fellBack), @"followsDefault": @(openedFollowing),
            @"note": ns(note), @"dspActive": @(g && g->active), @"gainUnity": @(gainUnity.load() && target.load() == 1),
            @"replayGainUnity": @(rg == 1), @"appliedReplayGainDb": @(rg > 0 ? 20 * log10(rg) : -100), @"systemOutputName": systemOutputName() };
    }
    // Exclusive: where macOS now sends the other apps' sound (it moves the system output off the hogged device).
    NSString *systemOutputName() {
        if (!device || !ownsHog) return @"";
        AudioDeviceID def = defaultOutput();
        return def && def != device ? nameOf(def, kAudioObjectPropertyName) : @"";
    }
    double position() { Deck *d = current.load(); return d ? d->now() : 0; }

    // Moves the open output to `target` (or reopens it in another mode), keeping the decks and the play state.
    // The previous device is put back only after the new one is playing. Throws with the output closed.
    void reopen(AudioDeviceID target, bool fb) {
        bool was = playingNow();
        Deck *d = current.load();
        Restore old, carry;
        if (device && target == device) carry = closeForReopen();
        else if (device) old = detach();
        try {
            openOutput(target, fb); carryOver(carry);
            configureRate(d ? targetRate(d->sourceRate) : 0, d ? d->bits : 16, was);
            rebuildDecks(); armIO();
            if (was) resumeIO();
        } catch (...) { if (carry.device && device != carry.device) putBack(carry); putBack(detach()); putBack(old); throw; }
        putBackLater(std::move(old));
    }
    // A device event moved the output: tell the app, or pause at the place if the move failed.
    void moveTo(AudioDeviceID target, bool fb, NSString *reason) {
        NSString *name = nameOf(target, kAudioObjectPropertyName);
        trace("moving output to \"%s\" (%s)", name.UTF8String ?: "?", reason.UTF8String);
        try {
            reopen(target, fb);
            emit(@{@"e":@"output", @"reason":reason, @"playing":@(playingNow()), @"pos":@(position()), @"hardware":hardware()});
        } catch (const std::exception &e) {
            Deck *d = current.load();
            emit(@{@"e":@"lost", @"reason":@"failed", @"pos":@(position()), @"playing":@NO, @"id":d ? ns(d->id) : @"",
                @"msg":[NSString stringWithFormat:@"無法切換到「%@」：%@", name.length ? name : @"輸出裝置", ns(e.what())]});
        }
    }
    // The open output can't go on: the device is gone or another app took it. The decks stay (paused at their place);
    // Play opens whatever output is there then.
    void lost(NSString *reason) {
        Deck *d = current.load(); double pos = position(); bool was = playingNow();
        trace("output lost (%s) at %.2f s", reason.UTF8String, pos);
        NSString *name = deviceName.length ? deviceName : @"輸出裝置";
        putBack(detach());
        NSString *msg = is(reason, @"gone") ? [NSString stringWithFormat:@"「%@」已中斷連線", name]
            : [NSString stringWithFormat:@"另一個程式取得了「%@」的獨佔", name];
        emit(@{@"e":@"lost", @"reason":reason, @"pos":@(pos), @"playing":@NO, @"wasPlaying":@(was), @"id":d ? ns(d->id) : @"", @"msg":msg});
    }
    // Looks at the open device after a notification: gone, taken, an outside rate change (followed), a new layout.
    void checkOutput() {
        if (!device) return;
        try {
            if (!alive(device) || !listed(device)) { lost(@"gone"); return; }
            pid_t owner = hogOwner(device);
            if (ownsHog ? owner != getpid() : (owner > 0 && owner != getpid())) { lost(@"hog"); return; }
            double now = nominalRate(device);
            auto list = outputStreams(device);
            std::vector<AudioStreamBasicDescription> v, p;
            for (auto s : list) { v.push_back(virtualFormat(s)); p.push_back(physicalFormat(s)); }
            bool shape = shapeChanged.load() || list != streams || !sameFormats(v, virt);
            if (!sameRate(now, rate)) {
                trace("device rate changed outside MIKU: %.0f → %.0f", rate, now);
                // Someone else changed the device rate (shared mode): follow it rather than fight over it.
                // The device keeps running (silent meanwhile): the HAL relocks it in place.
                ioReady.store(false); quiesce(); noteRateChange(device);
                rateNote = sameRate(now, askedRate) ? "" : "其他程式把裝置改成 " + khz(now);
                rate = now;
                settle(true); rebuildDecks(); armIO();
                emit(@{@"e":@"output", @"reason":@"rate", @"playing":@(playingNow()), @"pos":@(position()), @"hardware":hardware()});
            } else if (shape) {
                trace("output layout changed: re-reading");
                ioReady.store(false); quiesce(); settle(true); armIO();
                emit(@{@"e":@"output", @"reason":@"layout", @"playing":@(playingNow()), @"pos":@(position()), @"hardware":hardware()});
            } else if (!sameFormats(p, phys)) {
                phys = p;   // the DAC format changed (labels only)
                emit(@{@"e":@"output", @"reason":@"format", @"playing":@(playingNow()), @"pos":@(position()), @"hardware":hardware()});
            }
        } catch (const std::exception &e) {
            if (device && (!alive(device) || !listed(device))) lost(@"gone");
            else { Deck *d = current.load(); putBack(detach());
                emit(@{@"e":@"lost", @"reason":@"failed", @"pos":@(position()), @"playing":@NO, @"id":d ? ns(d->id) : @"", @"msg":ns(e.what())}); }
        }
    }
    // The system output changed (handled 0.3 s later, after a removal has been seen: an unplugged device pauses).
    void systemOutputChanged() {
        AudioDeviceID def = defaultOutput();
        trace("system output is now \"%s\"%s", nameOf(def, kAudioObjectPropertyName).UTF8String ?: "?",
              device && ownsHog ? " (MIKU holds hog mode: ignored)" : since(hogChangedAt) < 2.5 ? " (right after a hog change: ignored)" : "");
        if (device && ownsHog) {
            // macOS moves the system output off a device MIKU hogs. That is not the user choosing another output, so
            // MIKU stays (exclusive playback is moved with MIKU's own output menu). When this device was the system
            // output (MIKU followed it, or it was the system output when MIKU took hog mode), remember the move so "the
            // system output" keeps meaning this device, also after MIKU lets go of it (macOS doesn't always move back).
            if ((openedFollowing || defaultAtHog == device) && def != device && inducedFrom.empty()) { inducedFrom = deviceUID; inducedTo = uidOf(def); }
            return;
        }
        if (since(hogChangedAt) < 2.5) return;   // the system output settling right after MIKU released a device
        inducedFrom.clear(); inducedTo.clear();
        if (!follows || !device || !def || def == device || !current.load()) return;
        if (!alive(device) || !listed(device)) { lost(@"gone"); return; }
        moveTo(def, false, @"default");
    }
    // A device appeared: the selected one is back while playback had fallen back to the system output.
    void selectedReturned() {
        if (!fellBack || follows || !device || !current.load()) return;
        AudioDeviceID d = deviceWithUID(wantUID);
        if (d && d != device) { trace("selected device is back"); moveTo(d, false, @"returned"); }
    }
    void takeConfig(NSDictionary *m) {
        NSString *dev = text(m[@"device"]);
        wantUID = dev.length ? str(dev) : "default"; follows = wantUID == "default";
        wantExclusive = flag(m[@"exclusive"]);
        wantAutoRate = m[@"autoRate"] ? flag(m[@"autoRate"]) : true;
    }

    // ───────────── commands ─────────────
    void load(NSDictionary *m, NSNumber *seq) {
        takeConfig(m);
        const double pos = std::max(0.0, num(m[@"pos"])), source = num(m[@"rate"]); const bool play = flag(m[@"play"]);
        const int bits = bitsNeeded(m);
        dspCfg = dictOf(m[@"dsp"]); target.store(num(m[@"gain"], 1));
        bool fb = false; AudioDeviceID dev = chooseDevice(fb);
        const bool keep = device && dev == device && openedExclusive == wantExclusive;
        const bool fast = keep && sameRate(targetRate(source), rate) && ioReady.load() &&
            (!exclusive || physicalPrecision() >= std::min(bits, maxPhysBits > 0 ? maxPhysBits : bits));
        if (fast) {
            // Same device, same rate: the new deck replaces the old one while the device keeps running.
            fellBack = fb; openedFollowing = follows && !fb;
            auto fresh = std::make_unique<Deck>(m, rate, pos);
            if (!fresh->warm() && !(pos > 0)) throw std::runtime_error("FFmpeg 無法解碼這首歌的 PCM 資料");
            setGraph(); instantGain.store(true);
            Deck *p = adopt(std::move(fresh));
            queued.store(nullptr); current.store(p); announced = p;
            collect();   // after this no IO callback can still be draining the old deck
            ended = false; drained.store(false); underruns.store(0); clips.store(0);
            if (play) resumeIO(); else pausePlayback();
        } else {
            // The same device in the same mode keeps running (silent) through a rate change: no stop, no new start.
            Restore old, carry;
            if (device && !keep) { if (dev == device) carry = closeForReopen(); else old = detach(); }
            else if (device) { ioReady.store(false); quiesce(); }
            dropDecks();
            try {
                if (!device) { openOutput(dev, fb); carryOver(carry); }
                fellBack = fb; openedFollowing = follows && !fb;
                double want = targetRate(source);
                auto fresh = std::make_unique<Deck>(m, want, pos);   // decodes while the DAC relocks
                configureRate(want, bits, play);
                if (!sameRate(fresh->rate, rate)) fresh = std::make_unique<Deck>(m, rate, pos);
                if (!fresh->warm() && !(pos > 0)) throw std::runtime_error("FFmpeg 無法解碼這首歌的 PCM 資料");
                setGraph(); ramp = 1 - exp(-1 / (0.025 * rate)); gain = std::min(target.load(), graph.load()->limit);
                Deck *p = adopt(std::move(fresh));
                current.store(p); announced = p; ended = false; drained.store(false); underruns.store(0); clips.store(0);
                armIO();
                if (play) resumeIO(); else pausePlayback();
            } catch (...) { if (carry.device && device != carry.device) putBack(carry); putBack(old); throw; }
            putBackLater(std::move(old));
        }
        emit(@{@"e":@"loaded", @"seq":seq, @"ok":@YES, @"playing":@(playingNow()), @"hardware":hardware()});
    }
    void seek(NSDictionary *m, NSNumber *seq) {
        Deck *d = current.load();
        if (!d) throw std::runtime_error("沒有載入的曲目");
        const double pos = std::max(0.0, num(m[@"pos"]));
        const bool play = m[@"play"] ? flag(m[@"play"]) : playingNow();
        auto fresh = std::make_unique<Deck>(d->params, rate > 0 ? rate : d->rate, pos);
        fresh->warm();   // nothing at the very end: it drains at once and the song ends
        Deck *p = adopt(std::move(fresh));
        current.store(p); announced = p;
        collect();
        ended = false; drained.store(false);
        if (play && device) resumeIO(); else if (!play) pausePlayback();
        emit(@{@"e":@"seeked", @"seq":seq, @"ok":@YES, @"pos":@(pos), @"playing":@(playingNow())});
    }
    void config(NSDictionary *m, NSNumber *seq) {
        takeConfig(m);
        Deck *d = current.load();
        if (device && !d) putBack(detach());   // nothing loaded: the next load opens the new output
        if (device && d) {
            bool fb = false; AudioDeviceID dev = chooseDevice(fb);
            if (dev == device && openedExclusive == wantExclusive) {
                fellBack = fb; openedFollowing = follows && !fb;
                double want = targetRate(d->sourceRate);
                if (!sameRate(want, rate)) {   // rate matching was switched on or off
                    bool was = playingNow();
                    configureRate(want, d->bits, was); rebuildDecks(); armIO();
                    if (was) resumeIO();
                }
            } else reopen(dev, fb);
        }
        emit(@{@"e":@"configured", @"seq":seq, @"ok":@YES, @"playing":@(playingNow()), @"pos":@(position()), @"hardware":hardware()});
    }
    void resume(NSNumber *seq) {
        Deck *d = current.load();
        if (!d) throw std::runtime_error("沒有載入的曲目");
        if (device) checkOutput();
        if (!device) {
            // After an unplug or a failed switch: open whatever the wanted output resolves to now.
            bool fb = false; AudioDeviceID dev = chooseDevice(fb);
            try { openOutput(dev, fb); configureRate(targetRate(d->sourceRate), d->bits, !ended); rebuildDecks(); armIO(); }
            catch (...) { putBack(detach()); throw; }
        }
        if (!ended) resumeIO();
        emit(@{@"e":@"resumed", @"seq":seq, @"ok":@YES, @"playing":@(playingNow()), @"pos":@(position()), @"hardware":hardware()});
    }
    void preload(NSDictionary *m) {
        if (!device || !current.load() || ended) { emit(@{@"e":@"preloadFailed", @"msg":@"沒有開啟的輸出"}); return; }
        if (!sameRate(targetRate(num(m[@"rate"])), rate)) { emit(@{@"e":@"preloadFailed", @"msg":@"下一首需要不同的取樣率"}); return; }
        if (exclusive && maxPhysBits > physicalPrecision() && bitsNeeded(m) > physicalPrecision()) { emit(@{@"e":@"preloadFailed", @"msg":@"下一首需要更高的 DAC 位元深度"}); return; }
        auto fresh = std::make_unique<Deck>(m, rate, 0);
        if (!fresh->warm()) { emit(@{@"e":@"preloadFailed", @"msg":@"下一首沒有音訊資料"}); return; }
        queued.store(adopt(std::move(fresh)));
        collect();
    }
    void fail(NSString *cmd, NSNumber *seq, NSString *msg) {
        if (is(cmd, @"load")) { try { stop(); } catch (...) { } emit(@{@"e":@"loaded", @"seq":seq, @"ok":@NO, @"msg":msg}); }
        // the output may still be open (the new one could not be resolved): say what is playing now
        else if (is(cmd, @"config")) emit(@{@"e":@"configured", @"seq":seq, @"ok":@NO, @"msg":msg, @"pos":@(position()), @"playing":@(playingNow()), @"hardware":hardware()});
        else if (is(cmd, @"resume")) emit(@{@"e":@"resumed", @"seq":seq, @"ok":@NO, @"msg":msg, @"pos":@(position()), @"playing":@(playingNow()), @"hardware":hardware()});
        else if (is(cmd, @"seek")) emit(@{@"e":@"seeked", @"seq":seq, @"ok":@NO, @"msg":msg});
        else if (is(cmd, @"preload")) emit(@{@"e":@"preloadFailed", @"msg":msg});
        else emit(@{@"e":@"error", @"seq":seq, @"msg":msg});
    }
public:
    Engine() { graphOwned = std::make_unique<Graph>(); graph.store(graphOwned.get()); watchSystem(true); }
    ~Engine() { stop(); watchSystem(false); }
    void stop() { putBack(detach()); dropDecks(); underruns.store(0); clips.store(0); }
    bool playing() const { return playingNow(); }
    bool holdsHog() const { return ownsHog; }
    void command(NSDictionary *m) {
        NSString *cmd = text(m[@"c"]) ?: @""; NSNumber *seq = [m[@"seq"] isKindOfClass:[NSNumber class]] ? m[@"seq"] : @0;
        const bool quiet = is(cmd, @"devices") || is(cmd, @"probe") || is(cmd, @"gain") || is(cmd, @"dsp");
        auto t0 = Clock::now();
        Busy busy(literal(cmd));
        if (!quiet) trace("> %s device=%s exclusive=%d rate=%.0f pos=%.2f play=%d", cmd.UTF8String, (text(m[@"device"]) ?: @"-").UTF8String,
                          int(flag(m[@"exclusive"])), num(m[@"rate"]), num(m[@"pos"]), int(flag(m[@"play"])));
        struct Done { std::function<void()> f; ~Done() { f(); } } done{[&] {
            try { flushLater(); } catch (...) { }
            double ms = since(t0) * 1000;
            if (!quiet || ms > 500) trace("< %s %.0f ms%s", cmd.UTF8String, ms, device ? (playingNow() ? " (playing)" : " (paused)") : " (no output)");
        }};
        try {
            if (is(cmd, @"devices")) emit(@{@"e":@"devices", @"seq":seq, @"list":devices(logicalDefault())});
            else if (is(cmd, @"probe")) {
                NSString *uid = text(m[@"device"]);
                AudioDeviceID d = uid.length && ![uid isEqualToString:@"default"] ? deviceWithUID(str(uid)) : 0;
                bool fb = uid.length && ![uid isEqualToString:@"default"] && !d;
                if (!d) d = logicalDefault();
                NSDictionary *info = d ? deviceInfo(d) : nil;
                NSMutableDictionary *caps = [(info ?: @{}) mutableCopy]; caps[@"fallback"] = @(fb);
                emit(@{@"e":@"probe", @"seq":seq, @"caps":caps});
            }
            else if (is(cmd, @"load")) load(m, seq);
            else if (is(cmd, @"seek")) seek(m, seq);
            else if (is(cmd, @"config")) config(m, seq);
            else if (is(cmd, @"preload")) preload(m);
            else if (is(cmd, @"clearNext")) { queued.store(nullptr); collect(); }
            else if (is(cmd, @"pause")) { pausePlayback(); tick(true); }
            else if (is(cmd, @"resume")) { resume(seq); tick(true); }
            else if (is(cmd, @"stop")) { stop(); emit(@{@"e":@"stopped", @"seq":seq}); }
            else if (is(cmd, @"gain")) {
                target.store(num(m[@"v"], 1));
                if (!running) { gain = std::min(target.load(), graph.load()->limit); gainUnity.store(gain == 1 && target.load() == 1); }
                else if (flag(m[@"instant"])) instantGain.store(true);
                tick(true);
            }
            else if (is(cmd, @"dsp")) { dspCfg = dictOf(m[@"cfg"]); setGraph(); tick(true); }
            else emit(@{@"e":@"error", @"seq":seq, @"msg":[NSString stringWithFormat:@"未知的指令 %@", cmd]});
        } catch (const std::exception &e) {
            trace("%s failed: %s", cmd.UTF8String, e.what());
            fail(cmd, seq, ns(e.what()));
        } catch (...) {
            trace("%s failed: unexpected exception", cmd.UTF8String);
            // An Objective-C exception (64-bit runtime) or anything else: report it instead of terminating.
            fail(cmd, seq, @"原生音訊核心發生未預期的錯誤");
        }
    }
    void tick(bool force = false) {
        try {
            Busy busy("device events");
            bool list = listChanged.exchange(false);
            if (list) emit(@{@"e":@"devicechange"});
            if (defaultMoved.exchange(false)) { defaultPending = true; defaultDue = Clock::now() + std::chrono::milliseconds(300); emit(@{@"e":@"devicechange"}); }
            if (device && (deviceDirty.exchange(false) || list || shapeChanged.load())) checkOutput();
            if (list) selectedReturned();
            if (defaultPending && Clock::now() >= defaultDue) { defaultPending = false; systemOutputChanged(); }
            flushLater();
        } catch (const std::exception &e) { fprintf(stderr, "device event: %s\n", e.what()); }
        // A running device that stops calling MIKU (about every 10 ms normally; a relock pauses it for about 1 s):
        // the IO in this process is dead, and a new helper starts it cleanly. Counted in ticks, so time asleep does
        // not count.
        if (running && device) {
            const uint64_t c = ioCalls.load();
            if (c != ioCallsSeen) { ioCallsSeen = c; ticksWithoutIO = 0; }
            else {
                const bool wireless = transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE || transport == kAudioDeviceTransportTypeAirPlay;
                if (++ticksWithoutIO > (wireless ? 100 : 40)) restartHelper("the output stopped calling MIKU");
            }
        } else ticksWithoutIO = 0;
        Deck *d = current.load(); if (!d) return;
        if (d != announced) { announced = d; emit(@{@"e":@"started", @"id":ns(d->id), @"hardware":hardware()}); }
        if (drained.load() && !ended) {
            ended = true; endedAt = Clock::now(); queued.store(nullptr); collect();
            if (d->exitCode.load() != 0) { emit(@{@"e":@"error", @"fatal":@YES, @"msg":@"PCM 解碼器中斷；已停止輸出"}); stop(); }
            else emit(@{@"e":@"ended"});
            return;
        }
        // The device keeps running briefly after the last song so the next one starts without a relock.
        if (ended && running && since(endedAt) > 5) pauseIO();
        if (running && softPaused.load() && since(softPausedAt) > 30) { trace("paused for 30 s: stopping the device"); pauseIO(); }
        if (ended || (!playingNow() && !force)) return;
        NSMutableDictionary *m = [hardware() mutableCopy];
        [m addEntriesFromDictionary:@{@"e":@"status", @"id":ns(d->id), @"pos":@(d->now()), @"dur":@(d->duration),
            @"playing":@(playingNow()), @"l":@(peakL.exchange(0)), @"r":@(peakR.exchange(0)), @"clips":@(clips.load()), @"underruns":@(underruns.load())}];
        emit(m);
    }
};

static int selfTest() {
    // Every sample of 16-bit PCM, boundary/random 24/32-bit PCM, both endian layouts, both alignments.
    uint32_t random = 0x12345678; size_t checked = 0;
    for (int bits : {16,24,32}) for (int bytes : {2,3,4}) {
        if (bytes*8<bits) continue;
        for (bool big : {false,true}) for (bool high : {false,true}) {
            AudioStreamBasicDescription f{48000,kAudioFormatLinearPCM,UInt32(kAudioFormatFlagIsSignedInteger|(big?kAudioFormatFlagIsBigEndian:0)|(high?kAudioFormatFlagIsAlignedHigh:0)),UInt32(bytes*2),1,UInt32(bytes*2),2,UInt32(bits),0};
            int count=bits==16?65536:20000;
            for (int i=0;i<count;++i) {
                random=random*1664525+1013904223; uint32_t raw=bits==16?uint32_t(i)<<16:random&(~uint32_t(0)<<(32-bits));
                if (i==0) raw=0x80000000;
                if (i==1) raw=0x7fffffff&(~uint32_t(0)<<(32-bits));
                uint8_t out[8]{}; pack(out,int32_t(raw),f,sampleBytes(f)); uint32_t decoded=0;
                for (int b=0;b<bytes;++b) decoded|=uint32_t(out[big?bytes-1-b:b])<<(8*b);
                decoded<<=(high?32-bytes*8:32-bits); assert(decoded==raw); ++checked;
            }
        }
    }
    // 16/24-bit samples through 32-bit float and back to the DAC's integer format, the way the HAL converts them:
    // every value survives exactly (this is what makes the float path bit-perfect).
    for (int bits : {16,24}) {
        AudioStreamBasicDescription f{48000,kAudioFormatLinearPCM,kAudioFormatFlagIsFloat,8,1,8,2,32,0};
        for (int i=0;i<200000;++i) {
            random=random*1664525+1013904223; int32_t source=int32_t(random&(~uint32_t(0)<<(32-bits)));
            if (i==0) source=int32_t(0x80000000);
            if (i==1) source=int32_t(0x7fffffff&(~uint32_t(0)<<(32-bits)));
            uint8_t out[4]; pack(out,source,f,4); float value; memcpy(&value,out,4);
            assert(int64_t(double(value)*2147483648.0)==source);
            for (int dac : {16,24,32}) if (dac>=bits) {
                double scaled=double(value)*std::ldexp(1.0,dac-1); int64_t integer=int64_t(std::llround(scaled));
                assert(double(integer)==scaled && integer*(int64_t(1)<<(32-dac))==int64_t(source));
            }
            ++checked;
        }
        assert(precision(f)>=bits && precision(f)<32);
    }
    Ring ring(3,2); int32_t samples[]={1,-1,2,-2,3,-3,4,-4}, out[8]; assert(ring.push(samples,4)==3);
    assert(ring.pop(out,1)==1&&out[0]==1&&out[1]==-1); assert(ring.push(samples+6,1)==1);
    assert(ring.pop(out,4)==3); for(int i=0;i<3;++i) assert(out[2*i]==i+2&&out[2*i+1]==-(i+2));
    assert(ring.pop(out,1)==0);
    Ring mono(4,1); int32_t m1[]={7,8}; mono.push(m1,2); assert(mono.pop(out,2)==2&&out[0]==7&&out[1]==7&&out[2]==8&&out[3]==8);
    Graph graph; double dl=0.5,dr=-0.25; graph.run(dl,dr); assert(dl==0.5&&dr==-0.25&&!graph.active);
    // Rate fallback when the DAC lacks the track's rate.
    std::vector<double> dac = {44100, 48000, 96000};
    assert(chooseRate(48000, dac) == 48000); assert(chooseRate(88200, dac) == 44100); assert(chooseRate(192000, dac) == 96000);
    assert(chooseRate(32000, dac) == 44100); assert(chooseRate(768000, {48000}) == 48000);
    // Malformed commands and non-finite numbers must not raise.
    assert(num([NSNull null], 7) == 7 && num(@"3", 2) == 2 && !flag(@"yes") && text(@5) == nil);
    NSDictionary *bad = jsonSafe(@{@"a":@(NAN), @"b":@[@(INFINITY), @1]}); assert([bad[@"a"] doubleValue] == 0);
    Graph odd(@{@"enabled":@YES, @"eqOn":@YES, @"bands":@[[NSNull null], @{@"on":@YES, @"type":@5, @"fc":[NSNull null], @"gain":@3}]}, 48000);
    assert(odd.filters.size() == 1);
    assert(khz(44100) == "44.1 kHz" && khz(96000) == "96 kHz");
    emit(@{@"ok":@YES,@"samplesVerified":@(checked),@"tests":@[@"integer PCM packing",@"float path exactness (16/24-bit → float32 → 16/24/32-bit DAC)",
        @"ring wraparound",@"mono ring",@"DSP bypass",@"rate fallback",@"malformed input"]});
    return 0;
}

// A stable C string for a command name (the watchdog reads it from another thread).
static const char *literal(NSString *cmd) {
    static const char *const known[] = {"devices", "probe", "load", "seek", "config", "preload", "clearNext", "pause", "resume", "stop", "gain", "dsp"};
    for (const char *k : known) if ([cmd isEqualToString:@(k)]) return k;
    return "command";
}
// Commands the newest of which makes the earlier ones pointless (quick output switches and seeks while a slow one runs).
static bool supersededBy(NSString *cmd, NSString *later) {
    if (is(later, @"load")) return is(cmd, @"load") || is(cmd, @"seek") || is(cmd, @"config");
    if (is(later, @"seek")) return is(cmd, @"seek");
    if (is(later, @"config")) return is(cmd, @"config");
    return false;
}
static NSString *replyFor(NSString *cmd) { return is(cmd, @"load") ? @"loaded" : is(cmd, @"seek") ? @"seeked" : @"configured"; }

// --diag-engine "<device name part>" <ffmpeg> <audio file>: MIKU's own start / switch sequences on one device (silence),
// the ones that used to hang AudioDeviceStart; every step must end playing in hog mode without a long start.
static void diagWaitDefault(AudioDeviceID before) { auto t0 = Clock::now(); while (defaultOutput() != before && since(t0) < 4) sleepMs(20); sleepMs(800); }
static int diagnoseEngine(const char *want, const char *ffmpeg, const char *file) {
    AudioDeviceID d = 0;
    for (auto x : allDevices()) if (!outputStreams(x).empty() && strstr(nameOf(x, kAudioObjectPropertyName).UTF8String ?: "", want)) { d = x; break; }
    if (!d) { trace("diag: no output device matching \"%s\"", want); return 2; }
    const AudioDeviceID before = defaultOutput();
    NSDictionary *track = @{@"id":@"diag", @"ffmpeg":ns(ffmpeg), @"path":ns(file), @"rate":@48000, @"bits":@24, @"channels":@2, @"integerSource":@YES,
        @"duration":@8, @"rg":@1};
    trace("diag-engine \"%s\"; system output \"%s\"%s", nameOf(d, kAudioObjectPropertyName).UTF8String ?: "?",
          nameOf(before, kAudioObjectPropertyName).UTF8String ?: "?", before == d ? " (this device)" : "");
    auto load = [&](Engine &e, double rate, bool play) {
        NSMutableDictionary *m = [track mutableCopy]; m[@"rate"] = @(rate);
        [m addEntriesFromDictionary:@{@"c":@"load", @"seq":@1, @"device":ns(uidOf(d)), @"exclusive":@YES, @"autoRate":@YES, @"play":@(play), @"pos":@0, @"gain":@1, @"dsp":@{}}];
        auto t0 = Clock::now(); e.command(m); return since(t0) * 1000;
    };
    enum Kind { RapidCycles, RateCycles, SongChanges, PauseResume, PauseAfterRateChange, PausedLoadThenPlay };
    struct Run { const char *label; Kind kind; };
    const Run runs[] = {
        {"open/close ×4 then play", RapidCycles},
        {"44.1/48/96/192 open/close then play", RateCycles},
        {"song changes 44.1→96→48→192 while playing", SongChanges},
        {"pause / resume", PauseResume},
        {"rate change, pause, resume", PauseAfterRateChange},
        {"closed, paused load at a new rate, play 0.3 s later", PausedLoadThenPlay},
    };
    for (const Run &run : runs) {
        std::vector<double> times;
        bool ok = true;
        {
            Engine e;
            auto check = [&](const char *step, double ms) {
                times.push_back(ms);
                bool good = e.playing() && e.holdsHog();
                if (!good) ok = false;
                trace("  [%s] %s: %.0f ms, playing %d, hog %d", run.label, step, ms, int(e.playing()), int(e.holdsHog()));
            };
            switch (run.kind) {
                case RapidCycles:
                    for (int i = 0; i < 4; ++i) { load(e, 48000, true); e.stop(); }
                    check("final play", load(e, 48000, true)); break;
                case RateCycles:
                    for (double r : {44100.0, 48000.0, 96000.0, 192000.0}) { load(e, r, true); e.stop(); }
                    check("final play", load(e, 48000, true)); break;
                case SongChanges:
                    for (double r : {44100.0, 96000.0, 48000.0, 192000.0}) { check(r == 44100 ? "44.1 kHz" : r == 96000 ? "96 kHz" : r == 48000 ? "48 kHz" : "192 kHz", load(e, r, true)); sleepMs(300); }
                    break;
                case PauseResume: {
                    check("play", load(e, 48000, true)); sleepMs(300);
                    e.command(@{@"c":@"pause", @"seq":@2}); sleepMs(500);
                    auto t0 = Clock::now(); e.command(@{@"c":@"resume", @"seq":@3}); check("resume", since(t0) * 1000);
                    break;
                }
                case PauseAfterRateChange: {
                    check("44.1 kHz", load(e, 44100, true)); sleepMs(300);
                    check("96 kHz", load(e, 96000, true)); sleepMs(200);
                    e.command(@{@"c":@"pause", @"seq":@2}); sleepMs(300);
                    auto t0 = Clock::now(); e.command(@{@"c":@"resume", @"seq":@3}); check("resume", since(t0) * 1000);
                    break;
                }
                case PausedLoadThenPlay: {
                    load(e, 44100, true); sleepMs(300); e.stop();
                    load(e, 96000, false); sleepMs(300);
                    auto t0 = Clock::now(); e.command(@{@"c":@"resume", @"seq":@3}); check("resume", since(t0) * 1000);
                    break;
                }
            }
            sleepMs(300); e.stop();
        }
        double worst = times.empty() ? 0 : *std::max_element(times.begin(), times.end());
        trace("RESULT %s: %s, slowest start %.0f ms", run.label, ok ? "PLAYING" : "FAILED", worst);
        diagWaitDefault(before);
    }
    return 0;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        signal(SIGTERM,terminate); signal(SIGINT,terminate); signal(SIGPIPE,SIG_IGN);
        // HAL notifications (device list, default output, device removal) are delivered on the HAL's own thread.
        // Without this they wait for the main run loop, which this command loop never runs.
        {
            CFRunLoopRef none = nullptr; auto loop = addr(kAudioHardwarePropertyRunLoop);
            AudioObjectSetPropertyData(kAudioObjectSystemObject, &loop, 0, nullptr, sizeof(none), &none);
        }
        if (argc == 5 && !strcmp(argv[1], "--diag-engine")) { startWatchdog(); return diagnoseEngine(argv[2], argv[3], argv[4]); }
        if (argc>1 && !strcmp(argv[1],"--self-test")) return selfTest();
        if (argc>1 && !strcmp(argv[1],"--devices")) { emit(@{@"devices":devices(defaultOutput())}); return 0; }
        if (argc==3 && !strcmp(argv[1],"--dsp-test")) {
            NSData *data=[NSData dataWithContentsOfFile:ns(argv[2])]; NSDictionary *m=dictOf(data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil);
            Graph graph(dictOf(m[@"cfg"]),num(m[@"rate"],48000)); NSMutableArray *values=[NSMutableArray array];
            for(int i=0;i<512;++i) { double l=0.6*sin(i*0.12),r=0.4*cos(i*0.075); graph.run(l,r); [values addObject:@(l)]; [values addObject:@(r)]; }
            emit(@{@"samples":values,@"limit":@(graph.limit),@"active":@(graph.active)}); return 0;
        }
        if (argc==7 && !strcmp(argv[1],"--decode-test")) {
            NSDictionary *m=@{@"id":@"test", @"ffmpeg":ns(argv[2]), @"path":ns(argv[3]), @"pos":@0, @"rg":@1,
                @"duration":@0, @"rate":@(atoi(argv[4])), @"bits":@(atoi(argv[5])), @"channels":@(atoi(argv[6])), @"integerSource":@YES};
            try {
                Deck deck(m,atoi(argv[4]),0); deck.warm(); NSMutableData *pcm=[NSMutableData data]; int32_t frame[2];
                while (!deck.atEnd()) {
                    if (deck.ring.pop(frame,1)) { [pcm appendBytes:&frame[0] length:4]; if(deck.channels==2) [pcm appendBytes:&frame[1] length:4]; }
                    else sleepMs(1);
                    if (pcm.length>16*1024*1024) throw std::runtime_error("測試檔案過大");
                }
                emit(@{@"ok":@(deck.exitCode.load()==0), @"pcm":[pcm base64EncodedStringWithOptions:0]}); return deck.exitCode.load();
            } catch(const std::exception &e) { emit(@{@"ok":@NO,@"error":ns(e.what())}); return 1; }
        }
        startWatchdog();
        trace("MIKU audio helper started (protocol 3, pid %d)", int(getpid()));
        Engine engine; emit(@{@"e":@"hello", @"version":@3});
        std::string buffer; std::deque<NSDictionary *> queue; bool inputOpen = true;
        // Reads whatever is on stdin (waiting up to `timeout` ms for the first bytes) into the command queue.
        auto pump = [&](int timeout) {
            while (inputOpen) {
                pollfd p{STDIN_FILENO, POLLIN, 0}; int polled = poll(&p, 1, timeout);
                if (polled < 0) { if (errno == EINTR) continue; inputOpen = false; break; }
                if (!polled) break;
                char bytes[16384]; ssize_t n = read(STDIN_FILENO, bytes, sizeof(bytes));
                if (n < 0 && errno == EINTR) continue;
                if (n <= 0) { inputOpen = false; break; }
                buffer.append(bytes, size_t(n));
                size_t at;
                while ((at = buffer.find('\n')) != std::string::npos) {
                    NSData *data = [NSData dataWithBytes:buffer.data() length:at]; id m = nil;
                    @try { m = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil]; } @catch (NSException *) { m = nil; }
                    buffer.erase(0, at + 1);
                    if ([m isKindOfClass:[NSDictionary class]]) queue.push_back(m);
                }
                if (buffer.size() > 1024 * 1024) { inputOpen = false; break; }
                timeout = 0;
            }
        };
        auto last = Clock::now();
        while (!quitting && (inputOpen || !queue.empty())) {
            @autoreleasepool {
                pump(queue.empty() ? 50 : 0);
                while (!queue.empty() && !quitting) {
                    NSDictionary *m = queue.front(); queue.pop_front();
                    NSString *cmd = text(m[@"c"]);
                    bool replaced = false;
                    for (NSDictionary *later : queue) if (supersededBy(cmd, text(later[@"c"]))) { replaced = true; break; }
                    if (replaced) {
                        emit(@{@"e":replyFor(cmd), @"seq":[m[@"seq"] isKindOfClass:[NSNumber class]] ? m[@"seq"] : @0, @"ok":@NO, @"superseded":@YES, @"msg":@"已由較新的指令取代"});
                        continue;
                    }
                    engine.command(m);
                    pump(0);
                    if (since(last) >= 0.1) { engine.tick(); last = Clock::now(); }
                }
                if (since(last) >= 0.1) { engine.tick(); last = Clock::now(); }
            }
        }
        engine.stop(); return 0;
    }
}
