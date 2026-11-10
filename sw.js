// M0 のオフライン起動の検証用。
//
// 方針:
// - ビルドごとに版 (BUILD) を持ち、その版の全ファイルを専用のキャッシュへ入れてから切り替える
// - 取得したファイルは precache.json の SHA-256 と照合する。ログイン画面 (キャプティブポータル)、
//   エラー、リダイレクト、古い版の混入があればインストールを失敗させ、使える旧版をそのまま残す
// - 起動は常にキャッシュから行う (通信状態に左右されない)。実行中にキャッシュを書き換えない
// - 新しい版は裏で導入して待機させ、この版のページがすべて閉じてから切り替える。
//   開いたままのページが、別の版のファイルを受け取ったり、必要なファイルを消されたりしないようにするため
//
// GitHub Pages では他のページと同じオリジン (masashi-maruyama.github.io) を共有するので、
// パスは登録したスコープ (例: /mon-francais-m0/) からの相対で扱い、消すキャッシュはこのページのものだけにする。
const BUILD = 'bec0efaaf1bfe477';
const PREFIX = 'm0-probe-';
const CACHE = `${PREFIX}${BUILD}`;
const SCOPE = self.registration.scope;

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** リダイレクトを許さず、HTTP のキャッシュも使わずに取得する */
async function strictFetch(url) {
  const response = await fetch(url, { cache: 'no-store', redirect: 'error', credentials: 'same-origin' });
  if (!response.ok || response.redirected || response.type !== 'basic') {
    throw new Error(`取得できません: ${url} (${response.status} ${response.type})`);
  }
  return response;
}

async function install() {
  const manifest = await (await strictFetch(new URL('precache.json', SCOPE))).json();
  if (manifest.build !== BUILD) {
    // sw.js と precache.json の版が食い違う (配信側のキャッシュが古いなど)。あとで再試行される
    throw new Error(`版が一致しません: sw=${BUILD} precache=${manifest.build}`);
  }
  // 先に全ファイルを取得して照合し、すべて揃ったときだけキャッシュへ書く
  const entries = await Promise.all(
    Object.entries(manifest.files).map(async ([path, expected]) => {
      const url = new URL(path, SCOPE);
      const response = await strictFetch(url);
      const body = await response.arrayBuffer();
      const actual = await sha256(body);
      if (actual !== expected) throw new Error(`内容が一致しません: ${path}`);
      const headers = new Headers();
      const type = response.headers.get('content-type');
      if (type) headers.set('content-type', type);
      return [url.href, new Response(body, { status: 200, headers })];
    }),
  );
  // 同じ版のキャッシュが既にあれば (登録のやり直しなど) 消さずに上書きする。内容は SHA-256 で同一と確認済み
  const existed = await caches.has(CACHE);
  const cache = await caches.open(CACHE);
  try {
    for (const [url, response] of entries) await cache.put(url, response);
  } catch (error) {
    if (!existed) await caches.delete(CACHE);
    throw error;
  }
}

self.addEventListener('install', (event) => {
  // skipWaiting はしない。旧版のページが閉じるまで待機する
  event.waitUntil(
    install().catch((error) => {
      console.warn('新しい版を導入できません。現在の版を使い続けます', error);
      throw error;
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 旧版のページはすべて閉じているので、このページの古い版のキャッシュを消す (他のページのものは消さない)
      for (const key of await caches.keys()) {
        if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
      }
      // clients.claim() はしない。初回に開いたページは別の版の可能性があるため、
      // 次に開いたとき (ホーム画面から開くときなど) から、この版のキャッシュで制御する
    })(),
  );
});

async function lookup(request) {
  const cache = await caches.open(CACHE);
  return (
    (await cache.match(request, { ignoreVary: true, ignoreSearch: request.mode === 'navigate' })) ??
    (request.mode === 'navigate' ? await cache.match(SCOPE) : undefined)
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // 同じオリジンの別のページ (他のリポジトリ) の通信には関わらない
  if (request.method !== 'GET' || !request.url.startsWith(SCOPE)) return;
  event.respondWith(lookup(request).then((cached) => cached ?? fetch(request)));
});
