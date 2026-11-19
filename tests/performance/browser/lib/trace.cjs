'use strict';
// Reads a Chromium trace of one action: where the renderer's main thread spent its time (script, style, layout, paint,
// commit), what the raster and image-decode workers did, and which frames the compositor showed or dropped.

const KIND = {
  script: ['EvaluateScript', 'FunctionCall', 'EventDispatch', 'TimerFire', 'FireAnimationFrame', 'RunMicrotasks', 'v8.callFunction', 'FireIdleCallback', 'MinorGC', 'MajorGC', 'V8.GC_MC_BACKGROUND_MARKING'],
  style: ['UpdateLayoutTree', 'RecalculateStyles', 'ParseAuthorStyleSheet'],
  layout: ['Layout', 'IntersectionObserverController::computeIntersections', 'HitTest'],
  paint: ['PrePaint', 'Paint', 'PaintImage', 'Layerize', 'UpdateLayer', 'UpdateLayerTree', 'CompositeLayers'],
  commit: ['Commit', 'ProxyMain::BeginMainFrame::commit'],
};
const KIND_OF = new Map(Object.entries(KIND).flatMap(([k, names]) => names.map(n => [n, k])));
const CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'cc', 'benchmark', 'blink', 'loading', 'v8'];

/** Self-contained time of the outermost events of each kind on one thread (nested events of the same kind are not counted twice). */
function byKind(events) {
  const out = { script: 0, style: 0, layout: 0, paint: 0, commit: 0 }, counts = { style: 0, layout: 0, paint: 0, commit: 0 };
  const open = [];   // outer events still running: [end, kind]
  for (const e of events) {
    const kind = KIND_OF.get(e.name);
    if (!kind) continue;
    while (open.length && open[open.length - 1][0] <= e.ts) open.pop();
    if (kind in counts && (e.name === 'UpdateLayoutTree' || e.name === 'Layout' || e.name === 'Paint' || e.name === 'Commit')) counts[kind]++;
    // time inside an outer event of another kind moves from that kind to this one (style inside script is style)
    const outer = open[open.length - 1];
    if (outer && outer[1] === kind) continue;
    if (outer) out[outer[1]] -= e.dur;
    out[kind] += e.dur;
    open.push([e.ts + e.dur, kind]);
  }
  for (const k of Object.keys(out)) out[k] = +(out[k] / 1000).toFixed(2);
  return { ms: out, counts };
}

/** Summary of the trace between two timestamps (µs, trace clock); all of it when they are not given. */
function summarize(trace, from = -Infinity, to = Infinity) {
  const events = trace.traceEvents || trace;
  const threads = new Map();
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') threads.set(e.pid + ':' + e.tid, e.args.name);
  // the page's renderer: the process whose main thread ran the most timeline events
  const perMain = new Map();
  for (const e of events) if (e.ph === 'X' && threads.get(e.pid + ':' + e.tid) === 'CrRendererMain' && KIND_OF.has(e.name)) perMain.set(e.pid, (perMain.get(e.pid) || 0) + 1);
  const pid = [...perMain.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const inWin = e => e.ts >= from && e.ts < to;
  const main = events.filter(e => e.ph === 'X' && e.pid === pid && threads.get(e.pid + ':' + e.tid) === 'CrRendererMain' && inWin(e)).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const kinds = byKind(main);
  // top-level tasks: how long the main thread was busy, and its longest stretch
  const tasks = main.filter(e => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask');
  let busy = 0, longest = 0, end = -Infinity;
  for (const t of tasks) { if (t.ts < end) continue; busy += t.dur; longest = Math.max(longest, t.dur); end = t.ts + t.dur; }
  const sum = names => +(events.filter(e => e.ph === 'X' && e.pid === pid && names.includes(e.name) && inWin(e)).reduce((n, e) => n + e.dur, 0) / 1000).toFixed(2);
  const count = names => events.filter(e => names.includes(e.name) && inWin(e) && (e.pid === pid || !e.pid)).length;
  // frames: one PipelineReporter per frame the compositor was asked for
  const frames = { presented: 0, dropped: 0, droppedSmooth: 0, noUpdate: 0 };
  for (const e of events) {
    if (e.name !== 'PipelineReporter' || (e.ph !== 'b' && e.ph !== 'B') || !inWin(e)) continue;
    const r = e.args && (e.args.chrome_frame_reporter || e.args.frame_reporter);
    if (!r) continue;
    const st = String(r.state || '');
    if (st.includes('DROPPED')) { frames.dropped++; if (r.affects_smoothness) frames.droppedSmooth++; }
    else if (st.includes('PRESENTED')) frames.presented++;
    else frames.noUpdate++;
  }
  return {
    mainBusyMs: +(busy / 1000).toFixed(2), longestTaskMs: +(longest / 1000).toFixed(2), ...kinds,
    rasterMs: sum(['RasterTask']), rasterTasks: count(['RasterTask']),
    decodeMs: sum(['Decode Image', 'ImageDecodeTask', 'Decode LazyPixelRef', 'Draw LazyPixelRef']), decodes: count(['Decode Image']),
    layerTreeCommits: count(['Commit']), frames,
    drawFrames: count(['DrawFrame']), droppedFrames: count(['DroppedFrame']),
  };
}

/** Records a trace of the page while `action` runs and for `settle` ms after it. Returns { trace, t0, t1 } (trace clock, µs). */
async function record(browser, page, action, settle = 600) {
  const mark = async name => page.evaluate(n => { performance.mark(n); }, name);
  await browser.startTracing(page, { categories: [...CATEGORIES, 'blink.user_timing'] });
  await mark('miku-trace-start');
  await action();
  await new Promise(r => setTimeout(r, settle));
  await mark('miku-trace-end');
  const trace = JSON.parse((await browser.stopTracing()).toString('utf8'));
  const events = trace.traceEvents || trace;
  const at = name => events.find(e => e.name === name && e.cat && e.cat.includes('blink.user_timing'))?.ts;
  return { trace, t0: at('miku-trace-start') ?? -Infinity, t1: at('miku-trace-end') ?? Infinity };
}

module.exports = { record, summarize, CATEGORIES };
