// Loaded first by the shell page and the login page.
// 直连: this page usually comes through the cloud relay (slow uplink). When a direct address is configured
// (SUPERDEMO_DIRECT_URL) and this browser can reach it (IPv6 to the NAS), move there — same path. `?relay` (remembered
// for the tab) stays on the relay. Links handed to others always use the public (relay) addresses.
// window.sdDirect resolves to true when the page is moving away (callers then do nothing else).
window.sdDirect = (async () => {
  try {
    if (new URLSearchParams(location.search).has('relay')) sessionStorage.setItem('sd.relay', '1');
    if (sessionStorage.getItem('sd.relay')) return false;
    const { url } = await (await fetch('/api/direct', { cache: 'no-store' })).json();
    if (!url) return false;
    const target = new URL(url);
    if (target.origin === location.origin) return false;
    // no-cors: an opaque answer is enough to know the address is reachable; a network failure rejects
    await fetch(`${target.origin}/api/health`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(1500) });
    location.replace(target.origin + location.pathname + location.search + location.hash);
    return true;
  } catch { return false; }
})();

// Session ran out (or was ended elsewhere): any API answer marked x-sd-login sends the tab to the login page.
(() => {
  const orig = window.fetch.bind(window);
  let leaving = false;
  window.fetch = async (...args) => {
    const r = await orig(...args);
    if (r.status === 401 && r.headers.get('x-sd-login') === '1' && !leaving && location.pathname !== '/login') {
      leaving = true;
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash);
    }
    return r;
  };
})();
