// Host-page script for tests/golden.e2e.ts: one console error and one failed request after load
// (the widget's buffers are installed by then), so the console/network parts have something to
// send — or to null out when switched off.
window.addEventListener('load', function () {
  console.error('golden host: checkout widget failed to load');
  fetch('/api/missing?token=secret-value').catch(function () {});
});
