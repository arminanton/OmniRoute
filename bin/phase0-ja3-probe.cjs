// Phase-0 TLS de-risk: does wreq-js firefox_150 present the JA3 hash MaxAI's
// chat endpoints check (6447ab086255d194909d4013b1a89e87)? And does a
// firefox_150 request through the residential HTTP proxy reach api.maxai.me?
// We hit tls.peet.ws / a JA3 echo through the proxy to read back the JA3.
const wreq = require("/app/node_modules/wreq-js");

const PROXY = "http://ts-egress:3128";

async function ja3Via(browser) {
  // ja3er / tls.peet.ws echo the JA3 the server saw. Use tls.peet.ws/api/all.
  try {
    const res = await wreq.fetch("https://tls.peet.ws/api/all", {
      browser,
      os: browser.startsWith("firefox") ? "windows" : "macos",
      proxy: PROXY,
    });
    const j = await res.json();
    const tls = j.tls || {};
    return { ja3: tls.ja3, ja3_hash: tls.ja3_hash, ja4: tls.ja4, ua: (j.http_version||"") };
  } catch (e) {
    return { error: e.message };
  }
}

async function maxaiVia(browser) {
  try {
    const res = await wreq.fetch("https://api.maxai.me/", {
      browser,
      os: browser.startsWith("firefox") ? "windows" : "macos",
      proxy: PROXY,
    });
    const t = await res.text();
    return { status: res.status, body: t.slice(0, 80) };
  } catch (e) {
    return { error: e.message };
  }
}

(async () => {
  console.log("TARGET JA3 hash (MaxAI FF150):", "6447ab086255d194909d4013b1a89e87");
  for (const b of ["firefox_150", "firefox_135", "chrome_142"]) {
    const j = await ja3Via(b);
    console.log(`\n[${b}] JA3 hash=${j.ja3_hash || j.error}  JA4=${j.ja4 || ""}`);
    if (j.ja3) console.log(`  ja3=${j.ja3.slice(0, 90)}...`);
    const m = await maxaiVia(b);
    console.log(`  api.maxai.me GET / -> ${m.status || m.error} ${m.body || ""}`);
  }
})();
