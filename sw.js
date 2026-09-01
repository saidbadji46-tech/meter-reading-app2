// Service Worker - يخزن التطبيق للعمل بلا انترنت، ويسولك قبل ما يبدل لنسخة جديدة
const CACHE_NAME = 'meter-reading-v5';

self.addEventListener('install', () => {
  /* ماندير-وش skipWaiting هنا، باش النسخة الجديدة تبقى "فحالة انتظار"
     حتى المستخدم يأكد التحديث بنفسو */
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).then((response) => {
      const resClone = response.clone();
      caches.open(CACHE_NAME).then((cache) => {
        if (event.request.method === 'GET') cache.put(event.request, resClone);
      });
      return response;
    }).catch(() => caches.match(event.request))
  );
});
