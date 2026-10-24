// Test-only C ABI. No decoding, audio device access, or threads are started here.
#include <windows.h>
#include <stdlib.h>
#include <string.h>
#define API __declspec(dllexport)
typedef struct { LONG active; } player;
static HANDLE entered, resume;
static LONG blocked, destroyed, destroyed_busy, next_calls, load_calls;

API void test_reset(void) {
    if (entered) CloseHandle(entered);
    if (resume) CloseHandle(resume);
    entered = CreateEventW(NULL, TRUE, FALSE, NULL);
    resume = CreateEventW(NULL, TRUE, FALSE, NULL);
    blocked = destroyed = destroyed_busy = next_calls = load_calls = 0;
}
API void test_block_state(void) { InterlockedExchange(&blocked, 1); }
API int test_wait_entered(void) { return WaitForSingleObject(entered, 5000) == WAIT_OBJECT_0; }
API void test_release(void) { SetEvent(resume); }
API int test_destroy_count(void) { return destroyed; }
API int test_destroyed_busy(void) { return destroyed_busy; }
API int test_next_count(void) { return next_calls; }
API int test_load_count(void) { return load_calls; }
API player* dc_create(void) { return calloc(1, sizeof(player)); }
API void dc_destroy(player* p) {
    if (p->active) InterlockedIncrement(&destroyed_busy);
    InterlockedIncrement(&destroyed);
    // Keep a tombstone so a regression reports a failed assertion, not a random native crash.
    // The test subprocess owns these tiny allocations and exits after all checks.
}
API void dc_stop(player* p) { (void)p; }
API int dc_load(player* p, const wchar_t* path, const char* settings, double seconds, int play, char* err, int len) {
    (void)p; (void)path; (void)settings; (void)seconds; (void)play;
    InterlockedIncrement(&load_calls);
    if (err && len) *err = 0;
    return 0;
}
API int dc_state(player* p, char* out, int len) {
    InterlockedIncrement(&p->active);
    if (blocked) { SetEvent(entered); WaitForSingleObject(resume, 5000); }
    const char* json = "{\"position\":0,\"duration\":0,\"report\":{}}";
    int n = (int)strlen(json), result = -5;
    if (n < len) { memcpy(out, json, n + 1); result = n; }
    InterlockedDecrement(&p->active);
    return result;
}
API int dc_poll_event(player* p, char* out, int len) { (void)p; (void)out; (void)len; return 0; }
API double dc_design(player* p) { (void)p; return 1.0; }
API void dc_set_next(player* p, const wchar_t* path) { (void)p; (void)path; InterlockedIncrement(&next_calls); }
