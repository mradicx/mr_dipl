/**
 * izvori/jsonld.js — konektor za stranice sa strukturiranim podacima
 *
 * Velik broj stranica organizatora i izvođača u svoj HTML ugrađuje opis
 * događanja prema rječniku Schema.org, zapisan u formatu JSON-LD. 
 * Tražilice takve podatke koriste za obogaćeni prikaz rezultata, pa
 * ih stranice objavljuju u vlastitom interesu.
 *
 * Ta okolnost omogućuje jedinstven konektor koji radi na proizvoljnom broju
 * stranica bez ijedne odrednice specifične za pojedinu stranicu. Stranice se
 * dodaju upisom u postavke izvora, čime sustav ostaje proširiv i nakon
 * dovršetka izrade.
 *
 * Ako stranica ne objavljuje strukturirane podatke, konektor za nju vraća
 * prazan rezultat. Udio stranica koje ih objavljuju sam je po sebi nalaz i
 * bilježi se u dnevniku dohvata.
 */

import { dohvatiDokument, stanka } from './index.js';
import { VRSTE, otisakStranice, zabiljeziStanjeStranice } from '../db.js';

/** Tipovi iz rječnika Schema.org koji označuju događanje */
const TIPOVI_DOGADANJA = new Set([
  'Event', 'MusicEvent', 'Festival', 'MusicFestival', 'TheaterEvent',
  'DanceEvent', 'ScreeningEvent', 'ComedyEvent', 'SocialEvent',
  'PublicEvent', 'ExhibitionEvent', 'EventSeries',
]);

/* Dohvat*/

/**
 * @param {object} izvor — zapis iz tablice izvora; postavke.stranice sadrži
 *   popis objekata oblika { url, naziv, grad, vrsta }
 */
/**
 * Izvještaj o posljednjem prolazu, po stranici. Bilježi se kako bi se u
 * sučelju vidjelo koje stranice objavljuju strukturirane podatke, a koje ne,
 * bez potrebe za pregledavanjem razvojne konzole.
 */
let izvjestaj = [];

/** @returns {Array} stanje svake obrađene stranice u posljednjem prolazu */
export function dohvatiIzvjestaj() {
  return izvjestaj;
}

export async function dohvati(izvor) {
  const stranice = izvor.postavke?.stranice ?? [];
  const svi = new Map();
  izvjestaj = [];

  for (const stranica of stranice) {
    const stavka = {
      url: stranica.url, naziv: stranica.naziv,
      objekata: 0, dogadanja: 0, izTeksta: false,
      promijenjeno: false, greska: null,
    };

    try {
      const dokument = await dohvatiDokument(stranica.url);

      /* Nadzor promjena obavlja se nad istim dohvatom, bez dodatnog zahtjeva */
      stavka.promijenjeno = await zabiljeziStanjeStranice(
        stranica.url, stranica.naziv, otisakStranice(dokument)
      );

      /* Prva razina: strukturirani podaci prema rječniku Schema.org */
      const objekti = izdvojiObjekte(dokument).filter(jeDogadanje);
      stavka.objekata = objekti.length;

      const zapisi = [];
      for (const objekt of objekti) zapisi.push(...pretvori(objekt, stranica));

      /* Druga razina: prepoznavanje datuma u tekstu, ako prva ništa ne da */
      if (!zapisi.length) {
        const izTeksta = izTekstaStranice(dokument, stranica);
        if (izTeksta) {
          zapisi.push(izTeksta);
          stavka.izTeksta = true;
        }
      }

      for (const zapis of zapisi) {
        if (zapis && !svi.has(zapis.idNaIzvoru)) svi.set(zapis.idNaIzvoru, zapis);
      }
      stavka.dogadanja = zapisi.length;
    } catch (greska) {
      /* Nedostupna pojedinačna stranica ne prekida obradu ostalih */
      stavka.greska = greska.message;
    }

    izvjestaj.push(stavka);
    await stanka();
  }

  return [...svi.values()];
}

/* Izdvajanje objekata iz dokumenta */

/**
 * Prikuplja sve objekte iz svih blokova JSON-LD u dokumentu. Blokovi mogu
 * sadržavati pojedinačan objekt, niz objekata ili svežanj pod ključem @graph,
 * pa se struktura obilazi u dubinu.
 */
function izdvojiObjekte(dokument) {
  const objekti = [];

  for (const blok of dokument.querySelectorAll('script[type="application/ld+json"]')) {
    let sadrzaj;
    try {
      sadrzaj = JSON.parse(blok.textContent);
    } catch {
      continue;   /* neispravan zapis se preskače */
    }
    skupi(sadrzaj, objekti);
  }

  return objekti;
}

function skupi(cvor, spremnik, dubina = 0) {
  if (!cvor || dubina > 6) return;

  if (Array.isArray(cvor)) {
    for (const c of cvor) skupi(c, spremnik, dubina + 1);
    return;
  }
  if (typeof cvor !== 'object') return;

  spremnik.push(cvor);

  if (cvor['@graph']) skupi(cvor['@graph'], spremnik, dubina + 1);
  if (cvor.subEvent) skupi(cvor.subEvent, spremnik, dubina + 1);
  if (cvor.event) skupi(cvor.event, spremnik, dubina + 1);
}

function jeDogadanje(objekt) {
  const tip = objekt?.['@type'];
  const tipovi = Array.isArray(tip) ? tip : [tip];
  return tipovi.some((t) => TIPOVI_DOGADANJA.has(t));
}

/* Svođenje na jedinstvenu shemu */

/** Determinističan identifikator, jer Schema.org ne propisuje obavezan ključ */
function izracunajKljuc(naziv, pocetak, url) {
  const ulaz = `${naziv}|${pocetak}|${url}`;
  let h = 5381;
  for (let i = 0; i < ulaz.length; i += 1) {
    h = ((h << 5) + h + ulaz.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/** Vrijednost može biti niz, objekt ili tekst; vraća se prvi upotrebljiv tekst */
function tekst(vrijednost) {
  if (!vrijednost) return null;
  if (typeof vrijednost === 'string') return vrijednost.trim() || null;
  if (Array.isArray(vrijednost)) return tekst(vrijednost[0]);
  if (typeof vrijednost === 'object') return tekst(vrijednost.name ?? vrijednost['@value']);
  return null;
}

function popisImena(vrijednost) {
  if (!vrijednost) return [];
  const niz = Array.isArray(vrijednost) ? vrijednost : [vrijednost];
  return niz.map(tekst).filter(Boolean);
}

/** Iz ponude se uzima najniža navedena cijena i poveznica na kupnju */
function ponuda(objekt) {
  const ponude = Array.isArray(objekt.offers) ? objekt.offers : [objekt.offers].filter(Boolean);
  let cijena = null;
  let valuta = null;
  let url = null;

  for (const p of ponude) {
    if (!p) continue;
    const c = Number(p.price ?? p.lowPrice);
    if (!Number.isNaN(c) && c > 0 && (cijena === null || c < cijena)) {
      cijena = c;
      valuta = p.priceCurrency ?? null;
    }
    if (!url && typeof p.url === 'string') url = p.url;
  }
  return { cijena, valuta, url };
}

/** Vrsta se određuje iz tipa u zapisu, a ako on nije dovoljno određen, iz postavki */
function odrediVrstu(objekt, stranica) {
  const tip = Array.isArray(objekt['@type']) ? objekt['@type'][0] : objekt['@type'];
  const preslikavanje = {
    Festival: VRSTE.FESTIVAL,
    MusicFestival: VRSTE.FESTIVAL,
    MusicEvent: VRSTE.KONCERT,
    TheaterEvent: VRSTE.PREDSTAVA,
    ComedyEvent: VRSTE.STAND_UP,
    DanceEvent: VRSTE.DJ_PARTY,
    ScreeningEvent: VRSTE.FILM,
    ExhibitionEvent: VRSTE.IZLOZBA,
  };
  return preslikavanje[tip] ?? stranica.vrsta ?? VRSTE.OSTALO;
}

/**
 * Pretvara jedan objekt iz zapisa u nula ili više događanja. Nula se vraća kad
 * nedostaje naziv ili datum početka, jer takav zapis nije upotrebljiv.
 */
function pretvori(objekt, stranica) {
  const naziv = tekst(objekt.name) ?? stranica.naziv;
  const pocetakSirovo = objekt.startDate;
  if (!naziv || !pocetakSirovo) return [];

  const pocetak = new Date(pocetakSirovo);
  if (Number.isNaN(pocetak.getTime())) return [];

  const kraj = objekt.endDate ? new Date(objekt.endDate) : null;
  const lokacija = Array.isArray(objekt.location) ? objekt.location[0] : objekt.location;
  const { cijena, valuta, url } = ponuda(objekt);

  return [{
    idNaIzvoru: izracunajKljuc(naziv, pocetak.toISOString(), stranica.url),
    naziv,
    vrsta: odrediVrstu(objekt, stranica),
    pocetak: pocetak.toISOString(),
    kraj: kraj && !Number.isNaN(kraj.getTime()) ? kraj.toISOString() : null,
    mjesto: {
      naziv: tekst(lokacija?.name) ?? stranica.naziv ?? null,
      grad: tekst(lokacija?.address?.addressLocality) ?? stranica.grad ?? null,
      drzava: tekst(lokacija?.address?.addressCountry) ?? null,
      adresa: tekst(lokacija?.address?.streetAddress) ?? null,
    },
    izvodaci: popisImena(objekt.performer),
    cijenaOd: cijena,
    valuta: valuta ?? 'EUR',
    poveznica: url ?? tekst(objekt.url) ?? stranica.url,
    slika: tekst(objekt.image) ?? null,
    opis: tekst(objekt.description)?.slice(0, 400) ?? null,
  }];
}


/* Pričuvni postupak: prepoznavanje datuma u tekstu */

/**
 * Kad stranica ne objavljuje strukturirane podatke, datum se pokušava
 * prepoznati iz teksta. Pretraživanje ne počinje od tijela dokumenta, nego od
 * metapodataka u zaglavlju: stranice organizatora ondje redovito navode
 * razdoblje održavanja, jer se taj opis prikazuje u rezultatima tražilica i
 * pri dijeljenju na društvenim mrežama. Tijelo dokumenta često je gotovo u
 * cijelosti sastavljeno od slika, pa u njemu datuma nema.
 */

const MJESECI_EN = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];
const MJESECI_HR_G = ['siječnja', 'veljače', 'ožujka', 'travnja', 'svibnja', 'lipnja',
  'srpnja', 'kolovoza', 'rujna', 'listopada', 'studenoga', 'prosinca'];
const MJESECI_HR_N = ['siječanj', 'veljača', 'ožujak', 'travanj', 'svibanj', 'lipanj',
  'srpanj', 'kolovoz', 'rujan', 'listopad', 'studeni', 'prosinac'];

/** Vraća redni broj mjeseca iz naziva na engleskom ili hrvatskom */
function brojMjeseca(naziv) {
  const n = naziv.toLowerCase();
  let i = MJESECI_EN.findIndex((m) => m.startsWith(n.slice(0, 3)));
  if (i >= 0) return i + 1;
  i = MJESECI_HR_G.findIndex((m) => m.startsWith(n.slice(0, 4)));
  if (i >= 0) return i + 1;
  i = MJESECI_HR_N.findIndex((m) => m.startsWith(n.slice(0, 4)));
  return i >= 0 ? i + 1 : null;
}

/**
 * Priprema tekst za prepoznavanje: uklanja nastavke rednih brojeva, izjednačuje
 * crtice i uklanja prijedlog koji se u engleskom umeće između dana i mjeseca.
 * Bez toga zapisi poput "27th - 31st of August" ostaju neprepoznati.
 */
function pripremiTekst(t) {
  return t
    .replace(/(\d{1,2})\s*(st|nd|rd|th)\b/gi, '$1')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\bof\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NAZIV_MJESECA = '([a-zA-Zčćžšđ\u010c\u0106\u017d\u0160\u0110]{3,12})';

/** Obrasci se primjenjuju redom, od najodređenijeg prema najmanje određenom */
const OBRASCI = [
  { r: new RegExp(`\\b(\\d{1,2})\\.\\s*-\\s*(\\d{1,2})\\.\\s*(\\d{1,2})\\.\\s*(\\d{4})`), o: 'brojcani' },
  { r: new RegExp(`\\b(\\d{1,2})\\s*-\\s*(\\d{1,2})\\s+${NAZIV_MJESECA}\\.?\\s*(\\d{4})?`, 'i'), o: 'dd-mm' },
  { r: new RegExp(`\\b${NAZIV_MJESECA}\\s+(\\d{1,2})\\s*-\\s*(\\d{1,2}),?\\s*(\\d{4})?`, 'i'), o: 'mm-dd' },
  { r: new RegExp(`\\b(\\d{1,2})\\s+${NAZIV_MJESECA}\\.?\\s*(\\d{4})?`, 'i'), o: 'd-m' },
  { r: new RegExp(`\\b${NAZIV_MJESECA}\\s+(\\d{1,2}),?\\s*(\\d{4})?`, 'i'), o: 'm-d' },
];

/** Skuplja tekstove po redoslijedu pouzdanosti: zaglavlje, naslovi, tijelo */
function kandidati(dokument) {
  const izlaz = [];
  const meta = (odabir) => dokument.querySelector(odabir)?.getAttribute('content');

  for (const odabir of [
    'meta[name="description"]',
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
    'meta[property="og:site_name"]',
    'meta[property="og:title"]',
  ]) {
    const v = meta(odabir);
    if (v) izlaz.push(v);
  }

  if (dokument.title) izlaz.push(dokument.title);

  for (const n of [...dokument.querySelectorAll('h1, h2')].slice(0, 6)) {
    const t = n.textContent.replace(/\s+/g, ' ').trim();
    if (t) izlaz.push(t);
  }

  const tijelo = dokument.body?.cloneNode(true);
  if (tijelo) {
    for (const e of tijelo.querySelectorAll('script, style, noscript, nav, footer')) e.remove();
    izlaz.push(tijelo.textContent.replace(/\s+/g, ' ').trim().slice(0, 6000));
  }

  return izlaz;
}

/** Traži četveroznamenkastu godinu bilo gdje u dokumentu, kao krajnju pričuvu */
function godinaStranice(dokument) {
  const t = dokument.body?.textContent ?? '';
  const sada = new Date().getFullYear();
  const godine = [...t.matchAll(/\b(20\d{2})\b/g)]
    .map((m) => Number(m[1]))
    .filter((g) => g >= sada && g <= sada + 2);
  return godine.length ? Math.min(...godine) : null;
}

function izTekstaStranice(dokument, stranica) {
  const sada = new Date();
  const pricuvnaGodina = godinaStranice(dokument);
  const nadjeni = [];

  for (const sirovi of kandidati(dokument)) {
    const tekst = pripremiTekst(sirovi);

    for (const { r, o } of OBRASCI) {
      /* Sva poklapanja u tekstu, ne samo prvo. */
      for (const m of tekst.matchAll(new RegExp(r.source, r.flags.includes('g') ? r.flags : r.flags + 'g'))) {
        let dan; let doDana = null; let mjesec; let godina;

        if (o === 'brojcani') {
          [dan, doDana, mjesec, godina] = [+m[1], +m[2], +m[3], m[4]];
        } else if (o === 'dd-mm') {
          [dan, doDana, mjesec, godina] = [+m[1], +m[2], brojMjeseca(m[3]), m[4]];
        } else if (o === 'mm-dd') {
          [mjesec, dan, doDana, godina] = [brojMjeseca(m[1]), +m[2], +m[3], m[4]];
        } else if (o === 'd-m') {
          [dan, mjesec, godina] = [+m[1], brojMjeseca(m[2]), m[3]];
        } else {
          [mjesec, dan, godina] = [brojMjeseca(m[1]), +m[2], m[3]];
        }

        if (!mjesec || mjesec < 1 || mjesec > 12) continue;
        if (!dan || dan < 1 || dan > 31) continue;

        let g = godina ? Number(godina)
          : Number(tekst.match(/\b(20\d{2})\b/)?.[1]) || pricuvnaGodina;
        if (!g) {
          g = sada.getFullYear();
          if (new Date(g, mjesec - 1, dan) < sada) g += 1;
        }

        const pocetak = new Date(g, mjesec - 1, dan, 12);
        if (Number.isNaN(pocetak.getTime())) continue;
        if (pocetak < sada) continue;                 /* prošli datumi se odbacuju */
        if (g > sada.getFullYear() + 2) continue;

        const kraj = doDana && doDana >= dan
          ? new Date(g, mjesec - 1, doDana, 23, 59) : null;
        nadjeni.push({ pocetak, kraj });
      }
    }
  }

  if (!nadjeni.length) return null;

  /*
   * Među svim prepoznatim nadolazećim datumima bira se najraniji. Stranice
   * festivala uz glavni datum često navode i datume drugih, kasnijih događanja
   * ili promidžbenih sadržaja; uzimanje najranijeg nadolazećeg datuma daje
   * pouzdaniji rezultat od uzimanja prvog na koji se naiđe.
   */
  nadjeni.sort((a, b) => a.pocetak - b.pocetak);
  const { pocetak, kraj } = nadjeni[0];

  return {
    idNaIzvoru: izracunajKljuc(stranica.naziv, pocetak.toISOString(), stranica.url),
    naziv: stranica.naziv,
    vrsta: stranica.vrsta ?? VRSTE.FESTIVAL,
    pocetak: pocetak.toISOString(),
    kraj: kraj ? kraj.toISOString() : null,
    mjesto: { naziv: stranica.naziv, grad: stranica.grad ?? null, drzava: null },
    izvodaci: [],
    poveznica: stranica.url,
    slika: null,
    opis: 'Datum prepoznat iz teksta stranice, bez strukturiranih podataka.',
  };
}
