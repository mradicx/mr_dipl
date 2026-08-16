/**
 * izvori/entrio.js — konektor za Entrio.hr
 *
 * Entrio ne nudi javno programsko sučelje, pa se podaci prikupljaju
 * ekstrakcijom sadržaja stranice. Za razliku od uobičajenog pristupa, u kojem
 * se pojedina polja dohvaćaju unaprijed zadanim CSS selektorima, ovdje se
 * primjenjuje ekstrakcija temeljena na uzorcima sadržaja: iz svakoga zapisa
 * prikupljaju se svi tekstualni čvorovi, a polja se prepoznaju prema obliku
 * teksta (datum, kategorija, mjesto održavanja).
 *
 * Prednost je otpornost na promjene dizajna, budući da preimenovanje razreda
 * ili izmjena rasporeda elemenata ne utječe na prepoznavanje polja. Nedostatak
 * je nešto veća složenost i mogućnost pogrešnog razvrstavanja polja u rubnim
 * slučajevima, o čemu se raspravlja u poglavlju o ograničenjima.
 */

import { dohvatiDokument, stanka } from './index.js';
import { VRSTE } from '../db.js';

/* Preslikavanje kategorija */

/** Nazivi kategorija kojima se Entrio koristi, svedeni na jedinstveni rječnik */
const KATEGORIJE = {
  'KONCERT': VRSTE.KONCERT,
  'GLAZBA': VRSTE.KONCERT,
  'KAZALIŠNA PREDSTAVA': VRSTE.PREDSTAVA,
  'PREDSTAVA': VRSTE.PREDSTAVA,
  'FESTIVAL': VRSTE.FESTIVAL,
  'DJ PARTY': VRSTE.DJ_PARTY,
  'STAND-UP': VRSTE.STAND_UP,
  'STAND-UP KOMEDIJA': VRSTE.STAND_UP,
  'KINO I FILM': VRSTE.FILM,
  'IZLOŽBA': VRSTE.IZLOZBA,
  'TURNIRI': VRSTE.SPORT,
  'SPORT': VRSTE.SPORT,
  'KONFERENCIJA': VRSTE.OSTALO,
  'OBITELJSKI PROGRAM': VRSTE.OSTALO,
  'KVIZ': VRSTE.OSTALO,
  'OSTALO': VRSTE.OSTALO,
};

/* Prepoznavanje oblika podataka*/

/** Pojedinačni termin: "Subota, 08.08.2026., 21:00h" */
const TERMIN = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\.?(?:\s*,\s*(\d{1,2}):(\d{2}))?/;

/** Višednevni termin: "Od 24.07.2026. do 26.07.2026." */
const RASPON = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\.?\s*(?:do|-)\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/i;

/** Oznaka preuzetog zapisa: "Izvor: ulaznice.hr" */
const IZVORNA_OZNAKA = /^Izvor:\s*(.+)$/i;

/**
 * Pretvara dijelove datuma u zapis prema normi ISO 8601, u lokalnoj vremenskoj
 * zoni. Kad vrijeme nije navedeno, pretpostavlja se 20:00, što je uobičajen
 * početak večernjih događanja i sprječava da se događanje prikaže kao prošlo.
 */
function uIso(dan, mjesec, godina, sati = 20, minute = 0) {
  const d = new Date(Number(godina), Number(mjesec) - 1, Number(dan),
                     Number(sati), Number(minute));
  return isNaN(d) ? null : d.toISOString();
}

/* Prikupljanje tekstualnih polja */
/**
 * Vraća tekstove svih elemenata unutar zadanog čvora koji nemaju potomaka s
 * vlastitim tekstom. Time se dobiva niz pojedinačnih polja zapisa, neovisno o
 * tome kojim su elementima i razredima ta polja oblikovana.
 */
function tekstualnaPolja(cvor) {
  const polja = [];
  const hod = cvor.ownerDocument.createTreeWalker(cvor, NodeFilter.SHOW_TEXT);

  let n;
  while ((n = hod.nextNode())) {
    const t = n.textContent.replace(/\s+/g, ' ').trim();
    if (t) polja.push(t);
  }
  return polja;
}

/**
 * Pronalazi element koji obuhvaća cijeli zapis o događanju. Polazi se od
 * poveznice na stranicu događanja i penje prema korijenu dokumenta sve dok se
 * ne pronađe predak koji uz naziv sadrži i podatak o datumu.
 */
function pronadiZapis(poveznica) {
  let el = poveznica;
  for (let i = 0; i < 6 && el?.parentElement; i += 1) {
    el = el.parentElement;
    const t = el.textContent;
    if (TERMIN.test(t) || RASPON.test(t)) {
      /* Predak koji obuhvaća više događanja odbacuje se. */
      const brojPoveznica = el.querySelectorAll('a[href*="/event/"], a[href*="/dogadaj/"]').length;
      if (brojPoveznica <= 1) return el;
      return null;
    }
  }
  return null;
}

/* Razvrstavanje polja */


/**
 * Razvrstava prikupljena tekstualna polja jednog zapisa u strukturu događanja.
 *
 * Redoslijed provjere ide od najodređenijih oblika prema najmanje određenima:
 * prvo se izdvaja datum, zatim kategorija iz zatvorenog popisa, potom mjesto
 * održavanja prepoznato po obliku "dvorana, grad", a preostali najdulji tekst
 * uzima se kao naziv događanja.
 */
function razvrstaj(polja) {
  const rezultat = {
    naziv: null, vrsta: null, pocetak: null, kraj: null,
    mjesto: { naziv: null, grad: null }, preuzetoS: null,
  };
  const ostatak = [];

  for (const polje of polja) {
    const veliko = polje.toUpperCase();

    if (KATEGORIJE[veliko] && !rezultat.vrsta) {
      rezultat.vrsta = KATEGORIJE[veliko];
      continue;
    }

    const raspon = polje.match(RASPON);
    if (raspon && !rezultat.pocetak) {
      rezultat.pocetak = uIso(raspon[1], raspon[2], raspon[3]);
      rezultat.kraj = uIso(raspon[4], raspon[5], raspon[6], 23, 59);
      continue;
    }

    const termin = polje.match(TERMIN);
    if (termin && !rezultat.pocetak) {
      rezultat.pocetak = uIso(termin[1], termin[2], termin[3], termin[4], termin[5]);
      continue;
    }

    const oznaka = polje.match(IZVORNA_OZNAKA);
    if (oznaka) {
      rezultat.preuzetoS = oznaka[1].trim();
      continue;
    }

    ostatak.push(polje);
  }

  /* Mjesto održavanja: posljednje polje oblika "dvorana, grad". */
  for (let i = ostatak.length - 1; i >= 0; i -= 1) {
    if (ostatak[i].includes(',')) {
      const dijelovi = ostatak[i].split(',').map((d) => d.trim()).filter(Boolean);
      rezultat.mjesto.grad = dijelovi.pop();
      rezultat.mjesto.naziv = dijelovi.join(', ') || rezultat.mjesto.grad;
      ostatak.splice(i, 1);
      break;
    }
  }

  /* Naziv je najdulje preostalo polje nakon izdvajanja ostalih podataka */
  rezultat.naziv = ostatak.sort((a, b) => b.length - a.length)[0] ?? null;

  return rezultat;
}

/* Dohvat */


/**
 * Dohvaća i obrađuje sve konfigurirane stranice izvora
 *
 * @param {object} izvor — zapis iz tablice izvora
 * @returns {Promise<object[]>} događanja svedena na jedinstvenu shemu
 */
export async function dohvati(izvor) {
  const svi = new Map();     // identifikator na Entriju → zapis
  const putanje = izvor.postavke?.putanje ?? ['/dogadaji'];

  for (const putanja of putanje) {
    const url = izvor.osnovniUrl + putanja;

    let dokument;
    try {
      dokument = await dohvatiDokument(url);
    } catch (greska) {
      /* Nedostupna pojedinačna stranica ne prekida dohvat ostalih */
      console.warn(`Entrio: preskačem ${putanja} — ${greska.message}`);
      continue;
    }

    for (const zapis of obradiStranicu(dokument, izvor.osnovniUrl)) {
      if (!svi.has(zapis.idNaIzvoru)) svi.set(zapis.idNaIzvoru, zapis);
    }

    await stanka();   /* poštovanje prema poslužitelju između zahtjeva */
  }

  return [...svi.values()];
}

/** Izdvaja sva događanja s jedne stranice popisa. */
function obradiStranicu(dokument, osnovniUrl) {
  const poveznice = dokument.querySelectorAll('a[href*="/event/"], a[href*="/dogadaj/"]');
  const zapisi = [];
  const vidjeni = new Set();

  for (const poveznica of poveznice) {
    const href = poveznica.getAttribute('href');
    if (!href || vidjeni.has(href)) continue;
    vidjeni.add(href);

    /* Identifikator je brojčani sufiks putanje, npr. .../thompson-29610 */
    const id = href.match(/-(\d+)\/?$/)?.[1];
    if (!id) continue;

    const zapis = pronadiZapis(poveznica);
    if (!zapis) continue;

    /*
     * Tekst poveznice ne uzima se kao naziv jer poveznica obavija cijelu
     * karticu, pa bi obuhvatila i kategoriju, mjesto i datum. Naziv se stoga
     * uvijek određuje razvrstavanjem pojedinačnih tekstualnih polja.
     */
    const podaci = razvrstaj(tekstualnaPolja(zapis));

    /* Zapis bez naziva ili datuma nije upotrebljiv. */
    if (!podaci.naziv || !podaci.pocetak) continue;

    zapisi.push({
      idNaIzvoru: id,
      naziv: podaci.naziv,
      vrsta: podaci.vrsta ?? VRSTE.OSTALO,
      pocetak: podaci.pocetak,
      kraj: podaci.kraj,
      mjesto: {
        naziv: podaci.mjesto.naziv,
        grad: podaci.mjesto.grad,
        drzava: 'HR',
      },
      izvodaci: [],
      poveznica: new URL(href, osnovniUrl).href,
      slika: zapis.querySelector('img')?.src ?? null,
      opis: podaci.preuzetoS ? `Zapis preuzet s platforme ${podaci.preuzetoS}.` : null,
    });
  }

  return zapisi;
}
