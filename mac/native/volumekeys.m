// MIKU Volume Keys: hands the Mac's volume keys to MIKU while it plays in exclusive mode (device-volume.js starts it).
// The keys otherwise change the system output, which macOS has moved off the device MIKU holds. Taking a key before
// macOS does needs the Accessibility permission; a small app of its own keeps that permission across MIKU's updates
// (macOS ties it to the exact program, and MIKU changes with every update; MIKU replaces this one only when its own
// version changes). It looks at nothing but the three volume keys, and only while MIKU asks for them.
//
//   volumekeys <socket> [prompt]     lines in: on / off / prompt
//   lines out: trusted 0|1           key up|down|mute [fine]
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <sys/socket.h>
#import <sys/un.h>

static int g_sock = -1;
static BOOL g_on = NO;
static CFMachPortRef g_tap = NULL;

static void say(NSString *line) {
    NSData *d = [[line stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
    if (write(g_sock, d.bytes, d.length) < 0) exit(0);
}

static CGEventRef onEvent(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *ctx) {
    (void)proxy; (void)ctx;
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        if (g_tap && g_on) CGEventTapEnable(g_tap, true);
        return event;
    }
    if (!g_on || type != (CGEventType)NSEventTypeSystemDefined) return event;
    @autoreleasepool {
        NSEvent *e = [NSEvent eventWithCGEvent:event];
        if (!e || e.subtype != 8) return event;   // 8: the keyboard's media keys
        const NSInteger key = (e.data1 & 0xffff0000) >> 16, state = (e.data1 & 0xff00) >> 8;   // 0xA down, 0xB up
        if (key != 0 && key != 1 && key != 7) return event;   // NX_KEYTYPE_SOUND_UP, _DOWN, _MUTE
        const BOOL option = (e.modifierFlags & NSEventModifierFlagOption) != 0, shift = (e.modifierFlags & NSEventModifierFlagShift) != 0;
        if (option && !shift) return event;   // Option + a volume key opens Sound settings
        if (state == 0xA && !(key == 7 && (e.data1 & 1))) say([NSString stringWithFormat:@"key %@%@", key == 0 ? @"up" : key == 1 ? @"down" : @"mute", option ? @" fine" : @""]);
    }
    return NULL;
}

static void makeTap(void) {
    if (g_tap) return;
    g_tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, CGEventMaskBit(NSEventTypeSystemDefined), onEvent, NULL);
    if (!g_tap) return;
    CFRunLoopSourceRef src = CFMachPortCreateRunLoopSource(NULL, g_tap, 0);
    CFRunLoopAddSource(CFRunLoopGetMain(), src, kCFRunLoopCommonModes);
    CFRelease(src);
    CGEventTapEnable(g_tap, g_on);
}
static void prompt(void) { AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)@{(__bridge id)kAXTrustedCheckOptionPrompt:@YES}); }

int main(int argc, char **argv) {
    @autoreleasepool {
        signal(SIGPIPE, SIG_IGN);
        if (argc < 2) return 2;
        struct sockaddr_un a = {0};
        a.sun_family = AF_UNIX;
        strlcpy(a.sun_path, argv[1], sizeof a.sun_path);
        g_sock = socket(AF_UNIX, SOCK_STREAM, 0);
        if (connect(g_sock, (struct sockaddr *)&a, sizeof a)) return 1;   // MIKU is gone
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        __block int last = -1;
        void (^check)(void) = ^{
            const BOOL t = AXIsProcessTrusted();
            if (t) makeTap();
            else if (g_tap) { CFMachPortInvalidate(g_tap); CFRelease(g_tap); g_tap = NULL; }
            const int now = t && g_tap;
            if (now != last) { last = now; say([NSString stringWithFormat:@"trusted %d", now]); }
        };
        check();
        if (last == 0 && argc > 2 && !strcmp(argv[2], "prompt")) prompt();
        [NSTimer scheduledTimerWithTimeInterval:2 repeats:YES block:^(NSTimer *t) { (void)t; check(); }];
        dispatch_source_t in = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, (uintptr_t)g_sock, 0, dispatch_get_main_queue());
        NSMutableString *buf = [NSMutableString string];
        dispatch_source_set_event_handler(in, ^{
            char b[512]; ssize_t n = read(g_sock, b, sizeof b);
            if (n <= 0) exit(0);   // MIKU quit
            [buf appendString:[[NSString alloc] initWithBytes:b length:(NSUInteger)n encoding:NSASCIIStringEncoding] ?: @""];
            NSRange r;
            while ((r = [buf rangeOfString:@"\n"]).location != NSNotFound) {
                NSString *line = [buf substringToIndex:r.location];
                [buf deleteCharactersInRange:NSMakeRange(0, r.location + 1)];
                if ([line isEqualToString:@"on"] || [line isEqualToString:@"off"]) { g_on = [line isEqualToString:@"on"]; if (g_tap) CGEventTapEnable(g_tap, g_on); }
                else if ([line isEqualToString:@"prompt"]) prompt();
            }
        });
        dispatch_resume(in);
        [NSApp run];
    }
    return 0;
}
