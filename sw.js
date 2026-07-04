/**
 * ═══════════════════════════════════════════════════════════════════════
 * SERVICE WORKER — FinApp (strategia: network-first con fallback alla cache)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * PERCHÉ NETWORK-FIRST E NON CACHE-FIRST
 * FinApp viene pubblicata di frequente (iterazione continua su GitHub
 * Pages). Una strategia "cache-first" (la più comune nei tutorial: usa
 * sempre la cache, aggiorna solo se manca) qui sarebbe un problema reale:
 * dopo ogni deploy, il telefono continuerebbe a caricare la versione
 * VECCHIA di index.html dalla cache, ignorando quella nuova pubblicata,
 * finché la cache non viene invalidata esplicitamente — un classico
 * difetto delle PWA fatte al risparmio.
 *
 * Con "network-first": quando c'è connessione (il caso normale), il
 * browser scarica SEMPRE l'ultima versione pubblicata — zero rischio di
 * vedere codice vecchio mentre sei online. Solo se la rete non risponde
 * affatto (galleria, aereo, tunnel, tempo di attesa oltre soglia) si
 * ricade sulla copia salvata in cache, così l'app si apre comunque
 * invece di restare bloccata sulla schermata "nessuna connessione" del
 * browser.
 *
 * COSA VIENE CACHATO E COSA NO — IMPORTANTE
 * Solo l'app "shell": index.html, manifest.json e le icone. Le richieste
 * verso Firebase/Firestore NON vengono mai intercettate da questo
 * service worker (il filtro sotto le esclude esplicitamente): la
 * persistenza offline dei DATI è già gestita da Firestore stesso
 * (enableIndexedDbPersistence, vedi index.html), e mescolare le due cose
 * rischierebbe di rompere i listener realtime di Firestore o servire
 * risposte cache per richieste che devono invece sempre arrivare dal
 * server (autenticazione, letture/scritture dati).
 *
 * QUANDO SERVE TOCCARE QUESTO FILE
 * Nella pratica, quasi mai: essendo network-first, ogni nuova versione
 * di index.html arriva automaticamente appena c'è connessione, senza
 * bisogno di invalidare nulla a mano. L'unico motivo per incrementare
 * CACHE_VERSION è se in futuro cambi la LISTA di file da precachare
 * (es. aggiungi un font o un'immagine allo shell) — a quel punto un
 * numero di versione diverso forza la pulizia della cache vecchia
 * nell'evento "activate" più sotto.
 */

const CACHE_VERSION = 'v1'
const CACHE_NAME = `finapp-shell-${CACHE_VERSION}`

// File dell'app shell da precachare all'installazione — solo asset
// statici, mai endpoint Firebase/Firestore.
const SHELL_FILES = [
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
]

// Timeout oltre il quale consideriamo la rete "non disponibile" e
// ricadiamo sulla cache — senza questo, con una rete presente ma
// estremamente lenta, l'utente resterebbe a guardare una schermata
// bianca invece di ricevere subito la versione cache mentre la rete
// (eventualmente) finisce di rispondere in background.
const NETWORK_TIMEOUT_MS = 4000

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  )
  // Attiva questo service worker subito, senza aspettare che tutte le
  // altre schede di FinApp vengano chiuse — appropriato qui perché è
  // un'app personale su un solo dispositivo per volta nella pratica,
  // non un sito con centinaia di tab concorrenti da gestire con cautela.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name.startsWith('finapp-shell-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Intercetta SOLO richieste same-origin (i file di FinApp stessa).
  // Qualsiasi richiesta verso un altro host — Firestore, Firebase Auth,
  // l'API Eurostat per l'inflazione, i CDN — passa dritta alla rete,
  // gestita dal browser come se questo service worker non esistesse.
  // Questo è il punto che protegge i listener realtime di Firestore da
  // qualunque interferenza.
  if (url.origin !== self.location.origin) return

  // Solo GET ha senso cachare: le eventuali POST (nessuna, in questa
  // app, che scrive tutto su Firestore) non vanno mai intercettate.
  if (event.request.method !== 'GET') return

  event.respondWith(networkFirstWithTimeout(event.request))
})

async function networkFirstWithTimeout(request) {
  const cache = await caches.open(CACHE_NAME)

  try {
    const networkResponse = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS)
    // Aggiorna la cache con la risposta fresca, così il prossimo
    // fallback offline userà comunque l'ultima versione vista con
    // successo, non quella precaricata all'installazione originaria.
    cache.put(request, networkResponse.clone())
    return networkResponse
  } catch (e) {
    // Rete assente o troppo lenta: ricadiamo su quanto salvato in cache.
    const cached = await cache.match(request)
    if (cached) return cached
    // Nessuna cache disponibile (es. primissimo utilizzo mai andato a
    // buon fine online): non c'è alternativa, la richiesta fallisce
    // come farebbe normalmente senza service worker.
    throw e
  }
}

function fetchWithTimeout(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout rete service worker')), timeoutMs)
    fetch(request).then(
      (res) => { clearTimeout(timer); resolve(res) },
      (err) => { clearTimeout(timer); reject(err) }
    )
  })
}
