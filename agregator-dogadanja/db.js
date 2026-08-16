/**
 * db.js - sloj za pohranu podataka proširenja za agregaciju događanja
 *
 * Baza je izvedena nad IndexedDB-om, ugrađenom bazom podataka web preglednika,
 * uz korištenje biblioteke Dexie.js koja pruža deklarativan opis sheme i
 * sučelje temeljeno na obećanjima
 * Podaci se pohranjuju isključivo lokalno, unutar profila preglednika.
 */

import Dexie from './lib/dexie.mjs';

/* 1. Kontrolirani rječnici  */

/** Jedinstvene vrste događanja na koje se preslikavaju kategorije svih izvora */
export const VRSTE = {
  KONCERT: 'koncert',
  DJ_PARTY: 'dj_party',
  FESTIVAL: 'festival',
  PREDSTAVA: 'predstava',
  STAND_UP: 'stand_up',
  FILM: 'film',
  IZLOZBA: 'izlozba',
  SPORT: 'sport',
  OSTALO: 'ostalo',
};

/** Način na koji se podaci dohvaćaju s pojedinog izvora */
export const VRSTE_IZVORA = {
  API: 'api',           // službeno programsko sučelje
  GRAPHQL: 'graphql',   // GraphQL krajnja točka
  JSON_LD: 'json_ld',   // strukturirani podaci ugrađeni u stranicu
  HTML: 'html',         // ekstrakcija iz HTML-a pomoću CSS selektora
};

/** Posebna vrijednost filtra za događanja kojima grad nije poznat. */
export const BEZ_GRADA = '__bez_grada__';

/** Stanje događanja u trenutku posljednjeg dohvata. */
export const STANJA = {
  AKTIVNO: 'aktivno',
  RASPRODANO: 'rasprodano',
  OTKAZANO: 'otkazano',
  ODGODENO: 'odgodeno',
};

/* 2. Definicija sheme */

export const db = new Dexie('AgregatorDogadanja');

/*
 * U Dexie.js sintaksi navode se samo indeksirana polja. Prvo polje je
 * primarni ključ, znak ++ označava automatski generiran ključ, znak &
 * jedinstvenost, a znak * viševrijednosni indeks nad poljem tipa niz.
 * Ostala polja zapisa pohranjuju se bez indeksa.
 */
db.version(1).stores({
  dogadanja:
    'id, izvorId, kljucDuplikata, kanonskiId, pocetak, vrsta, gradNorm, ' +
    'mjestoId, *izvodaciIds, stanje, dohvaceno',

  mjesta: '++id, &nazivNorm, grad, gradNorm',

  izvodaci: '++id, &nazivNorm, pracen, *aliasi',

  izvori: 'id, naziv, vrsta, omogucen, zadnjeIzvrsavanje',

  spremljena: '&dogadanjeId, spremljeno, podsjetnik',

  filtri: '++id, &naziv',

  dnevnik: '++id, izvorId, pokrenuto, uspjeh',
});

/*
 * Druga inačica sheme dodaje nadzor stranica. Stranice koje ne objavljuju
 * strukturirane podatke ne mogu se obraditi ekstrakcijom, ali se može pratiti
 * mijenja li im se sadržaj. Time se korisnika obavještava o objavi programa
 * ili početku prodaje ulaznica i onda kad se sam podatak ne može pročitati.
 */
db.version(2).stores({
  nadzor: 'url, zadnjaProvjera, promijenjeno',
});

/* 3. Normalizacija */

/**
 * Svodi tekst na oblik pogodan za usporedbu: mala slova, bez dijakritičkih
 * znakova, bez interpunkcije i višestrukih razmaka.
 *
 * Primjer: "KONCERT: Buč Kesidi – Ljeto na Gradini!" postaje "koncert buc kesidi ljeto na gradini"
 */
export function normaliziraj(tekst) {
  if (!tekst) return '';
  return tekst
    .normalize('NFD')                  // razdvaja slovo i dijakritički znak
    .replace(/[\u0300-\u036f]/g, '')   // uklanja dijakritičke znakove
    .replace(/đ/gi, 'd')               // NFD ne rastavlja slovo đ
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Uklanja iz naziva događanja dijelove koji se razlikuju među izvorima, a ne
 * nose informaciju o identitetu događanja (naziv grada, oznaka datuma,
 * marketinški dodaci). Time se povećava vjerojatnost prepoznavanja duplikata.
 */
const SUVISNI_IZRAZI = [
  /\b\d{1,2}\s*\.\s*\d{1,2}\s*\.?\s*\d{0,4}\b/g,   // datumi u nazivu
  /\b(live|uzivo|tour|turneja|official|koncert)\b/g,
  /\b(u|in)\s+(rijeci|zagrebu|splitu|puli|zadru|osijeku)\b/g,
];

export function normalizirajNaziv(naziv) {
  let n = normaliziraj(naziv);
  for (const izraz of SUVISNI_IZRAZI) n = n.replace(izraz, ' ');
  return n.replace(/\s+/g, ' ').trim();
}

/**
 * Vraća datum u obliku GGGG-MM-DD. Neispravan ulaz ne prekida obradu, nego se
 * vraća prazan niz: poziv toISOString nad neispravnim datumom inače baca
 * iznimku, koja bi srušila upis cijeloga zapisa.
 */
export function danOd(isoDatum) {
  const d = new Date(isoDatum);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/**
 * Ključ duplikata: isto događanje prijavljeno s više izvora dobiva istu
 * vrijednost. Sastoji se od normaliziranog naziva, datuma i grada.
 */
export function izracunajKljucDuplikata({ naziv, pocetak, grad }) {
  return [normalizirajNaziv(naziv), danOd(pocetak), normaliziraj(grad)].join('|');
}

/** Determinističan identifikator zapisa unutar jednog izvora */
export function izracunajId(izvorId, idNaIzvoru) {
  return `${izvorId}:${idNaIzvoru}`;
}

/* 4. Prepoznavanje duplikata */

/**
 * Jaccardov koeficijent nad skupovima riječi dvaju naziva. Koristi se kao
 * dopuna ključu duplikata, za slučajeve u kojima se nazivi neznatno razlikuju
 * (npr. "Buč Kesidi" i "Buc Kesidi Ljeto na Gradini", za rad).
 */
export function slicnost(a, b) {
  const A = new Set(normalizirajNaziv(a).split(' ').filter(Boolean));
  const B = new Set(normalizirajNaziv(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  const presjek = [...A].filter((r) => B.has(r)).length;
  return presjek / (A.size + B.size - presjek);
}

const PRAG_SLICNOSTI = 0.6;

/**
 * Traži postojeći zapis koji predstavlja isto događanje. Prvo se provjerava
 * podudaranje ključa duplikata, a zatim, među događanjima istoga dana i grada,
 * podudaranje naziva iznad zadanoga praga sličnosti.
 */
async function pronadiKanonski(zapis) {
  /*
   * Duplikatom se smatra isto događanje koje su prijavila dva različita
   * izvora. Zapisi istoga izvora namjerno se ne spajaju, jer podudaran naziv i
   * datum unutar jednog izvora najčešće označuju različite termine istoga
   * programa, a ne ponovljeni zapis.
   */
  const izravno = await db.dogadanja
    .where('kljucDuplikata').equals(zapis.kljucDuplikata)
    .filter((d) => d.izvorId !== zapis.izvorId)
    .first();
  if (izravno) return izravno.kanonskiId || izravno.id;

  if (!zapis.gradNorm) return null;   /* bez grada nema pouzdane usporedbe */

  const dan = danOd(zapis.pocetak);
  const kandidati = await db.dogadanja
    .where('gradNorm').equals(zapis.gradNorm)
    .filter((d) => d.izvorId !== zapis.izvorId && danOd(d.pocetak) === dan)
    .toArray();

  for (const k of kandidati) {
    if (slicnost(k.naziv, zapis.naziv) >= PRAG_SLICNOSTI) {
      return k.kanonskiId || k.id;
    }
  }
  return null;
}

/* 5. Upis podataka */

/**
 * Zapisuje ili ažurira jedno događanje. Zapisi s različitih izvora zadržavaju
 * se odvojeno, ali se povezuju zajedničkim kanonskim identifikatorom, čime se
 * čuvaju sve poveznice na prodaju ulaznica, a korisniku se prikazuje jedan unos.
 *
 * @param {object} u - događanje svedeno na jedinstvenu shemu
 */
export async function upisiDogadanje(u) {
  /*
   * Zapis bez ispravnog vremena početka ne može se pouzdano razvrstati ni
   * uspoređivati, pa se preskače. Time neispravan datum s jednog zapisa ne
   * prekida upis ostalih.
   */
  if (Number.isNaN(new Date(u.pocetak).getTime())) {
    return { zapis: null, duplikat: false, postojao: false, preskocen: true };
  }

  const kljuc = izracunajId(u.izvorId, u.idNaIzvoru);
  const postojeci = await db.dogadanja.get(kljuc);

  const mjestoId = await upisiMjesto(u.mjesto);

  /*
   * Izvođači se upisuju redom, a ne usporedno. Usporedni upis (Promise.all)
   * pokrenuo bi sve odjednom, pa bi dva nastupa istog izvođača u istom skupu
   * podataka izazvala sudar na uvjetu jedinstvenosti.
   */
  const izvodaciIds = [];
  for (const naziv of u.izvodaci || []) {
    izvodaciIds.push(await upisiIzvodaca(naziv));
  }

  const zapis = {
    id: izracunajId(u.izvorId, u.idNaIzvoru),
    izvorId: u.izvorId,
    idNaIzvoru: String(u.idNaIzvoru),

    naziv: u.naziv,
    nazivNorm: normalizirajNaziv(u.naziv),
    opis: u.opis ?? null,
    vrsta: u.vrsta ?? VRSTE.OSTALO,
    zanr: u.zanr ?? null,

    pocetak: u.pocetak,         // ISO 8601
    kraj: u.kraj ?? null,

    mjestoId,
    /*
     * Naziv prostora i grad pohranjuju se i uz sam zapis, iako postoje u
     * tablici mjesta. Time se pri prikazu popisa izbjegava spajanje tablica,
     * koje bi za nekoliko stotina zapisa značilo jednak broj dodatnih upita.
     */
    mjestoNaziv: u.mjesto?.naziv ?? null,
    grad: u.mjesto?.grad ?? null,
    gradNorm: normaliziraj(u.mjesto?.grad),

    izvodaciIds,
    cijenaOd: u.cijenaOd ?? null,
    valuta: u.valuta ?? 'EUR',
    poveznica: u.poveznica,
    slika: u.slika ?? null,
    stanje: u.stanje ?? STANJA.AKTIVNO,

    kljucDuplikata: izracunajKljucDuplikata({
      naziv: u.naziv, pocetak: u.pocetak, grad: u.mjesto?.grad,
    }),
    kanonskiId: null,
    dohvaceno: new Date().toISOString(),
  };

  zapis.kanonskiId = (await pronadiKanonski(zapis)) ?? zapis.id;
  await db.dogadanja.put(zapis);

  /*
   * Uz sam zapis vraćaju se i podaci o ishodu upisa, koji se bilježe u dnevnik
   * i služe za vrednovanje rada sustava. Razlikuju se tri ishoda: zapis je nov,
   * zapis je već postojao pa je osvježen, ili je prepoznat kao isto događanje
   * koje je već prijavio neki drugi izvor.
   */
  return {
    zapis,
    duplikat: zapis.kanonskiId !== zapis.id,
    postojao: Boolean(postojeci),
  };
}

async function upisiMjesto(mjesto) {
  if (!mjesto?.naziv) return null;
  const nazivNorm = normaliziraj(mjesto.naziv);

  const postojece = await db.mjesta.where('nazivNorm').equals(nazivNorm).first();
  if (postojece) return postojece.id;

  /*
   * Nad poljem nazivNorm postavljen je uvjet jedinstvenosti. Kad se veći broj
   * zapisa upisuje brzo jedan za drugim, moguće je da dva zapisa s istim novim
   * nazivom oba prođu prethodnu provjeru prije nego što ijedan bude upisan, pa
   * drugi upis prekrši uvjet jedinstvenosti. Ta se iznimka hvata i tada se
   * dohvaća zapis koji je u međuvremenu upisan, čime se izbjegava prekid upisa.
   */
  try {
    return await db.mjesta.add({
      naziv: mjesto.naziv,
      nazivNorm,
      grad: mjesto.grad ?? null,
      gradNorm: normaliziraj(mjesto.grad),
      drzava: mjesto.drzava ?? 'HR',
      adresa: mjesto.adresa ?? null,
      lat: mjesto.lat ?? null,
      lng: mjesto.lng ?? null,
    });
  } catch (greska) {
    if (greska?.name === 'ConstraintError') {
      const zapis = await db.mjesta.where('nazivNorm').equals(nazivNorm).first();
      if (zapis) return zapis.id;
    }
    throw greska;
  }
}

async function upisiIzvodaca(naziv) {
  const nazivNorm = normaliziraj(naziv);

  const postojeci = await db.izvodaci.where('nazivNorm').equals(nazivNorm).first();
  if (postojeci) return postojeci.id;

  /* Isti razlog kao kod upisa mjesta: usporedni upis istog naziva. */
  try {
    return await db.izvodaci.add({
      naziv,
      nazivNorm,
      aliasi: [],
      pracen: 0,               // IndexedDB ne indeksira logičke vrijednosti
      slika: null,
      vanjskiIds: {},          // npr. { residentAdvisor: '1234', bandsintown: '567' }
    });
  } catch (greska) {
    if (greska?.name === 'ConstraintError') {
      const zapis = await db.izvodaci.where('nazivNorm').equals(nazivNorm).first();
      if (zapis) return zapis.id;
    }
    throw greska;
  }
}

/* 6. Dohvat i filtriranje  */

/**
 * Vraća objedinjen popis nadolazećih događanja prema zadanim filtrima.
 * Duplikati se sažimaju u jedan zapis kojemu se pridružuje popis svih izvora.
 *
 * @param {object} f
 * @param {string[]} [f.vrste]        — npr. [VRSTE.KONCERT, VRSTE.FESTIVAL]
 * @param {string[]} [f.gradovi]      — nazivi gradova, normaliziraju se
 * @param {number[]} [f.izvodaciIds]  — ograničenje na odabrane izvođače
 * @param {string}  [f.od]            — ISO datum, zadano: sada
 * @param {string}  [f.do]            — ISO datum
 * @param {boolean} [f.samoPraceni]   — samo praćeni izvođači
 */
export async function dohvatiDogadanja(f = {}) {
  const od = f.od ?? new Date().toISOString();

  let upit = db.dogadanja.where('pocetak').above(od);
  if (f.do) upit = db.dogadanja.where('pocetak').between(od, f.do);

  let zapisi = await upit.toArray();

  if (f.vrste?.length) {
    zapisi = zapisi.filter((d) => f.vrste.includes(d.vrsta));
  }
  if (f.gradovi?.length) {
    /* Posebna vrijednost izdvaja zapise kojima grad nije poznat */
    if (f.gradovi.includes(BEZ_GRADA)) {
      zapisi = zapisi.filter((d) => !d.gradNorm);
    } else {
      const g = f.gradovi.map(normaliziraj);
      zapisi = zapisi.filter((d) => g.includes(d.gradNorm));
    }
  }
  if (f.izvori?.length) {
    zapisi = zapisi.filter((d) => f.izvori.includes(d.izvorId));
  }
  if (f.samoPraceni) {
    const praceni = await db.izvodaci.where('pracen').equals(1).primaryKeys();
    const skup = new Set(praceni);
    zapisi = zapisi.filter((d) => d.izvodaciIds.some((id) => skup.has(id)));
  }
  if (f.izvodaciIds?.length) {
    const skup = new Set(f.izvodaciIds);
    zapisi = zapisi.filter((d) => d.izvodaciIds.some((id) => skup.has(id)));
  }

  return sazmiDuplikate(zapisi);
}

/** Grupira zapise po kanonskom identifikatoru i spaja podatke iz svih izvora */
function sazmiDuplikate(zapisi) {
  const grupe = new Map();

  for (const z of zapisi) {
    const kljuc = z.kanonskiId ?? z.id;
    if (!grupe.has(kljuc)) {
      grupe.set(kljuc, { ...z, izvori: [] });
    }
    const g = grupe.get(kljuc);
    if (!g.izvori.some((i) => i.izvorId === z.izvorId)) {
      g.izvori.push({ izvorId: z.izvorId, poveznica: z.poveznica, cijenaOd: z.cijenaOd });
    }

    // Zadržava se najniža poznata cijena i najbogatiji opis
    if (z.cijenaOd != null && (g.cijenaOd == null || z.cijenaOd < g.cijenaOd)) {
      g.cijenaOd = z.cijenaOd;
    }
    if (!g.opis && z.opis) g.opis = z.opis;
    if (!g.slika && z.slika) g.slika = z.slika;
  }

  return [...grupe.values()].sort((a, b) => a.pocetak.localeCompare(b.pocetak));
}

/* 7. Dnevnik dohvata */

/**
 * Bilježi svako izvršavanje dohvata s pojedinog izvora. Prikupljeni podaci
 * koriste se za mjerenje trajanja dohvata, pokrivenosti izvora i udjela
 * prepoznatih duplikata.
 */
export async function zabiljeziDohvat(izvorId, rezultat) {
  await db.dnevnik.add({
    izvorId,
    pokrenuto: rezultat.pokrenuto,
    trajanjeMs: rezultat.trajanjeMs,
    dohvaceno: rezultat.dohvaceno,
    novih: rezultat.novih,
    azuriranih: rezultat.azuriranih ?? 0,
    duplikata: rezultat.duplikata,
    izvjestaj: rezultat.izvjestaj ?? null,
    uspjeh: rezultat.greska ? 0 : 1,
    greska: rezultat.greska ?? null,
  });

  await db.izvori.update(izvorId, {
    zadnjeIzvrsavanje: rezultat.pokrenuto,
    zadnjeStanje: rezultat.greska ? 'greska' : 'uspjeh',
  });
}

/* 8. Početni popis izvora  */

/**
 * Izvori se opisuju podacima, a ne kodom. Dodavanje nove stranice svodi se na
 * upis novog zapisa u tablicu izvora, bez izmjene programskog koda, čime je
 * sustav proširiv i nakon završetka izrade.
 */
export const POCETNI_IZVORI = [
  {
    id: 'entrio',
    naziv: 'Entrio.hr',
    vrsta: VRSTE_IZVORA.HTML,
    osnovniUrl: 'https://www.entrio.hr',
    omogucen: 1,
    intervalMin: 360,
    postavke: {
      /* Gradovi se dodaju ili uklanjaju bez izmjene programskog koda */
      putanje: [
        '/dogadaji/rijeka', '/dogadaji/zagreb', '/dogadaji/split',
        '/dogadaji/zadar', '/dogadaji/pula', '/dogadaji/osijek',
      ],
    },
  },
  {
    id: 'ra',
    naziv: 'Resident Advisor',
    vrsta: VRSTE_IZVORA.GRAPHQL,
    osnovniUrl: 'https://ra.co/graphql',
    omogucen: 1,
    intervalMin: 360,
    postavke: {
      /*
       * Područja se označuju brojčanim identifikatorom koji dodjeljuje
       * Resident Advisor. Naziv grada navodi se uz identifikator jer ga
       * odgovor sučelja ne sadrži.
       */
      podrucja: [
        { id: 559, grad: 'Zagreb' },
        { id: 13, grad: 'London' },
      ],
    },
  },
  {
    id: 'bandsintown',
    naziv: 'Bandsintown',
    vrsta: VRSTE_IZVORA.API,
    osnovniUrl: 'https://rest.bandsintown.com',
    omogucen: 0,               /* uključuje se nakon upisa identifikatora */
    intervalMin: 1440,
    postavke: { appId: null },
  },
  {
    id: 'ticketmaster',
    naziv: 'Ticketmaster Discovery',
    vrsta: VRSTE_IZVORA.API,
    osnovniUrl: 'https://app.ticketmaster.com',
    omogucen: 0,               /* uključuje se nakon upisa ključa */
    intervalMin: 720,
    postavke: {
      kljuc: null,
      /* Zemlje u kojima se održavaju praćeni festivali */
      pretrage: [
        { countryCode: 'GB' },
        { countryCode: 'NL' },
        { countryCode: 'DE' },
      ],
    },
  },
  {
    id: 'jsonld',
    naziv: 'Ručno dodane stranice',
    vrsta: VRSTE_IZVORA.JSON_LD,
    osnovniUrl: '',
    omogucen: 1,
    intervalMin: 720,
    postavke: {
      /*
       * Stranice organizatora i izvođača. Polja naziv, grad i vrsta koriste se
       * samo kad ih sam zapis na stranici ne sadrži.
       */
      stranice: [
        { url: 'https://dimensionsfestival.com/', naziv: 'Dimensions Festival', vrsta: VRSTE.FESTIVAL },
        { url: 'https://www.loveinternationalfestival.com/', naziv: 'Love International', vrsta: VRSTE.FESTIVAL },
        { url: 'https://wakinglife.pt/', naziv: 'Waking Life', vrsta: VRSTE.FESTIVAL },
        { url: 'https://www.draaimolen.nu/', naziv: 'Draaimolen', vrsta: VRSTE.FESTIVAL },
        { url: 'https://www.horstartsandmusic.com/festival', naziv: 'Horst Arts & Music', vrsta: VRSTE.FESTIVAL },
        { url: 'https://omana-festival.de/', naziv: 'Omana Festival', vrsta: VRSTE.FESTIVAL },
        { url: 'https://www.naturalisfestival.it/', naziv: 'Naturalis Festival', vrsta: VRSTE.FESTIVAL },
        { url: 'https://dekmantelfestival.com/', naziv: 'Dekmantel', vrsta: VRSTE.FESTIVAL },
        { url: 'https://butikfestival.com/', naziv: 'Butik Festival', vrsta: VRSTE.FESTIVAL },
        { url: 'https://www.houghtonfestival.co.uk/', naziv: 'Houghton Festival', vrsta: VRSTE.FESTIVAL },
        { url: 'https://thisisgala.co.uk/', naziv: 'Gala Festival', vrsta: VRSTE.FESTIVAL },
        { url: 'https://www.samfender.com/', naziv: 'Sam Fender', vrsta: VRSTE.KONCERT },
        { url: 'https://www.rammstein.de/en/live/', naziv: 'Rammstein', vrsta: VRSTE.KONCERT },
        { url: 'https://www.nbthieves.com/', naziv: 'Nothing But Thieves', vrsta: VRSTE.KONCERT },
      ],
    },
  },
];

/**
 * Nadopunjuje tablicu izvora onima kojih u njoj još nema. Postojeći se zapisi
 * ne diraju, čime se čuvaju korisnikove izmjene postavki i uključenosti, a
 * nadogradnja proširenja može dodati nove izvore bez brisanja baze.
 */
export async function inicijalizirajIzvore() {
  const postojeci = new Set(await db.izvori.toCollection().primaryKeys());
  const nedostaju = POCETNI_IZVORI.filter((i) => !postojeci.has(i.id));
  if (!nedostaju.length) return;

  await db.izvori.bulkAdd(
    nedostaju.map((i) => ({ ...i, zadnjeIzvrsavanje: null, zadnjeStanje: null }))
  );
}

/* 9. Nadzor promjena na stranicama */


/**
 * Svodi sadržaj stranice na tekst pogodan za usporedbu. Uklanjaju se skripte i
 * stilovi, a razmaci se sažimaju, kako promjene u oblikovanju ne bi bile
 * protumačene kao promjena sadržaja.
 */
export function otisakStranice(dokument) {
  const kopija = dokument.body?.cloneNode(true);
  if (!kopija) return '0';

  for (const el of kopija.querySelectorAll('script, style, noscript, svg')) el.remove();

  const tekst = kopija.textContent.replace(/\s+/g, ' ').trim().toLowerCase();

  let h = 5381;
  for (let i = 0; i < tekst.length; i += 1) {
    h = ((h << 5) + h + tekst.charCodeAt(i)) >>> 0;
  }
  return `${h.toString(36)}:${tekst.length}`;
}

/**
 * Bilježi stanje nadzirane stranice i javlja je li se sadržaj promijenio od
 * prethodne provjere. Pri prvoj provjeri promjena se ne prijavljuje, jer još
 * nema s čime usporediti.
 *
 * @returns {Promise<boolean>} je li sadržaj promijenjen
 */
export async function zabiljeziStanjeStranice(url, naziv, otisak) {
  const prethodno = await db.nadzor.get(url);
  const promijenjeno = Boolean(prethodno?.otisak) && prethodno.otisak !== otisak;

  await db.nadzor.put({
    url,
    naziv,
    otisak,
    zadnjaProvjera: new Date().toISOString(),
    promijenjeno: promijenjeno ? 1 : 0,
    prethodnaPromjena: promijenjeno
      ? new Date().toISOString()
      : (prethodno?.prethodnaPromjena ?? null),
  });

  return promijenjeno;
}
