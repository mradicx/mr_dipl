/**
 * izvori/ticketmaster.js — konektor za Ticketmaster Discovery API
 *
 * Za razliku od ostalih izvora u sustavu, Discovery API službeno je i javno
 * dokumentirano sučelje kojemu se pristup stječe registracijom, bez posebnog
 * odobrenja. Odgovor je strukturiran i tipiziran, uvjeti korištenja jasno su
 * određeni, a ograničenje broja zahtjeva navedeno je u dokumentaciji, čime
 * ovaj izvor predstavlja najpouzdaniju razinu prikupljanja u sustavu.
 */

import { VRSTE, STANJA } from '../db.js';
import { stanka } from './index.js';

const OSNOVNI_URL = 'https://app.ticketmaster.com/discovery/v2/events.json';
const VELICINA_STRANICE = 100;
const NAJVISE_STRANICA = 5;

/* Dohvat */

/**
 * @param {object} izvor — zapis iz tablice izvora; postavke.kljuc sadrži
 *   ključ dobiven registracijom, a postavke.pretrage popis upita oblika
 *   { countryCode, city }
 */
export async function dohvati(izvor) {
  const kljuc = izvor.postavke?.kljuc;
  if (!kljuc) {
    throw new Error('Nije upisan ključ sučelja. Dodaj ga u postavkama.');
  }

  const pretrage = izvor.postavke?.pretrage ?? [];
  if (!pretrage.length) {
    throw new Error('Nije zadana nijedna pretraga.');
  }

  const od = new Date().toISOString().slice(0, 19) + 'Z';
  const svi = new Map();

  for (const pretraga of pretrage) {
    for (let stranica = 0; stranica < NAJVISE_STRANICA; stranica += 1) {
      const odgovor = await posaljiUpit({ kljuc, pretraga, od, stranica });
      const dogadanja = odgovor?._embedded?.events ?? [];
      if (!dogadanja.length) break;

      for (const d of dogadanja) {
        const zapis = pretvori(d);
        if (zapis && !svi.has(zapis.idNaIzvoru)) svi.set(zapis.idNaIzvoru, zapis);
      }

      const ukupnoStranica = odgovor?.page?.totalPages ?? 1;
      if (stranica + 1 >= ukupnoStranica) break;

      /* Dokumentacija dopušta pet zahtjeva u sekundi. */
      await stanka(300);
    }
  }

  return [...svi.values()];
}

/** Sastavlja i šalje jedan upit prema sučelju */
async function posaljiUpit({ kljuc, pretraga, od, stranica }) {
  const parametri = new URLSearchParams({
    apikey: kljuc,
    size: String(VELICINA_STRANICE),
    page: String(stranica),
    sort: 'date,asc',
    startDateTime: od,
  });

  if (pretraga.countryCode) parametri.set('countryCode', pretraga.countryCode);
  if (pretraga.city) parametri.set('city', pretraga.city);
  if (pretraga.classificationName) {
    parametri.set('classificationName', pretraga.classificationName);
  }

  const odgovor = await fetch(`${OSNOVNI_URL}?${parametri}`, {
    headers: { 'Accept': 'application/json' },
    credentials: 'omit',
  });

  if (odgovor.status === 429) {
    throw new Error('Dnevna kvota je iscrpljena. Pokušaj ponovno sutra.');
  }
  if (odgovor.status === 401) {
    throw new Error('Ključ sučelja nije prihvaćen. Provjeri je li točno prepisan.');
  }
  if (!odgovor.ok) {
    throw new Error(`Sučelje je vratilo stanje ${odgovor.status}.`);
  }

  return odgovor.json();
}

/* Svođenje na jedinstvenu shemu */

/**
 * Razvrstavanje se temelji na hijerarhiji klasifikacija koju sučelje vraća.
 * Najširu razinu čini segment, a unutar njega žanr, pa se vrsta određuje
 * kombinacijom obaju podataka i naziva događanja.
 */
function odrediVrstu(dogadanje) {
  const k = dogadanje.classifications?.[0] ?? {};
  const segment = k.segment?.name ?? '';
  const zanr = k.genre?.name ?? '';
  const naziv = dogadanje.name ?? '';

  if (/festival/i.test(naziv) || /festival/i.test(zanr)) return VRSTE.FESTIVAL;

  switch (segment) {
    case 'Music':
      return /electronic|dance|house|techno/i.test(zanr) ? VRSTE.DJ_PARTY : VRSTE.KONCERT;
    case 'Arts & Theatre':
      if (/comedy/i.test(zanr)) return VRSTE.STAND_UP;
      if (/exhibit|museum/i.test(zanr)) return VRSTE.IZLOZBA;
      return VRSTE.PREDSTAVA;
    case 'Film':
      return VRSTE.FILM;
    case 'Sports':
      return VRSTE.SPORT;
    default:
      return VRSTE.OSTALO;
  }
}

/** Preslikava oznaku stanja iz sučelja na kontrolirani rječnik sustava */
function odrediStanje(dogadanje) {
  switch (dogadanje.dates?.status?.code) {
    case 'cancelled': return STANJA.OTKAZANO;
    case 'postponed':
    case 'rescheduled': return STANJA.ODGODENO;
    case 'offsale': return STANJA.RASPRODANO;
    default: return STANJA.AKTIVNO;
  }
}

/** Bira sliku najbližu širini prikladnoj za popis, radi manje potrošnje */
function odaberiSliku(slike) {
  if (!slike?.length) return null;
  const poredane = [...slike].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (poredane.find((s) => (s.width ?? 0) >= 400) ?? poredane.at(-1)).url ?? null;
}

function pretvori(dogadanje) {
  const pocetakSirovo = dogadanje.dates?.start?.dateTime
    ?? (dogadanje.dates?.start?.localDate
      ? `${dogadanje.dates.start.localDate}T${dogadanje.dates.start.localTime ?? '20:00:00'}`
      : null);

  if (!dogadanje?.id || !dogadanje?.name || !pocetakSirovo) return null;

  const pocetak = new Date(pocetakSirovo);
  if (Number.isNaN(pocetak.getTime())) return null;

  const prostor = dogadanje._embedded?.venues?.[0] ?? {};
  const cijena = dogadanje.priceRanges?.[0];

  return {
    idNaIzvoru: String(dogadanje.id),
    naziv: dogadanje.name,
    vrsta: odrediVrstu(dogadanje),
    pocetak: pocetak.toISOString(),
    kraj: dogadanje.dates?.end?.dateTime
      ? new Date(dogadanje.dates.end.dateTime).toISOString()
      : null,
    mjesto: {
      naziv: prostor.name ?? null,
      grad: prostor.city?.name ?? null,
      drzava: prostor.country?.countryCode ?? null,
      adresa: prostor.address?.line1 ?? null,
      lat: prostor.location?.latitude ? Number(prostor.location.latitude) : null,
      lng: prostor.location?.longitude ? Number(prostor.location.longitude) : null,
    },
    izvodaci: (dogadanje._embedded?.attractions ?? []).map((a) => a.name).filter(Boolean),
    cijenaOd: cijena?.min ?? null,
    valuta: cijena?.currency ?? 'EUR',
    stanje: odrediStanje(dogadanje),
    poveznica: dogadanje.url,
    slika: odaberiSliku(dogadanje.images),
    opis: dogadanje.info?.trim()?.slice(0, 400) || null,
  };
}
